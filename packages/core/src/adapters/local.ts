import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { platform, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import {
  makerOf,
  type AgentEvent,
  type ModelOption,
  type ProviderStatus,
  type Role,
} from '@plenum/shared';
import type { ProcessChunk, ProcessOptions } from '../process.js';
import { runCommand } from '../process.js';
import type { RunPermissions } from './permissions.js';
import {
  assertSafeModel,
  defaultExec,
  failure,
  homeDirs,
  isRecord,
  locateCli,
  num,
  runCli,
  str,
  sum,
  tokenUsage,
  TypedEventParser,
  type EventBody,
  type Exec,
  type LineParser,
} from './kit/index.js';
import type { Adapter, Capabilities, LoginCommand, ModelList, RunRequest } from './types.js';
import { QUIET_MS } from './types.js';
import { linkSignals } from '../signals.js';

export const DEFAULT_OLLAMA_HOST = 'http://127.0.0.1:11434';

/** Context Plenum asks for, per job: enough for the CLI's instructions plus the work. */
const CONTEXT = { chat: 8192, review: 16384, build: 32768 } as const;

/** Aliases Plenum makes so OpenCode gets a usable context; hidden from the model list. */
const ALIAS_PREFIX = 'plenum/';

export interface Hardware {
  gpu?: string;
  /** Graphics memory, or the share of unified memory a Mac gives the GPU. */
  gpuMemoryGb?: number;
  ramGb: number;
  /** False when Ollama runs on another computer: its hardware isn't known here. */
  local: boolean;
}

export type Fit = 'gpu' | 'partial' | 'no';

/** How a model of this size fits: in GPU memory, partly on the CPU (slower), or not at all. */
export function fitOf(sizeGb: number, hw: Hardware): Fit | undefined {
  if (!hw.local) return undefined;
  // The weights plus room for a 16-32k context and the runtime (gpt-oss:20b, 13.8 GB, runs fully
  // on a 16 GB card).
  const need = sizeGb + 1.5;
  if (hw.gpuMemoryGb && need <= hw.gpuMemoryGb) return 'gpu';
  if (need <= (hw.gpuMemoryGb ?? 0) + hw.ramGb * 0.6) return 'partial';
  return 'no';
}

export const FIT_LABEL: Record<Fit, string> = {
  gpu: 'Fits in GPU memory',
  partial: 'Partly on CPU: slower',
  no: 'Too big for this machine',
};

/** Graphics memory from the driver (Windows' own report caps it at 4 GB, so it isn't used). */
export function readHardware(host: string): Hardware {
  const ramGb = Math.round(totalmem() / 1024 ** 3);
  const local = isLocalHost(host);
  if (!local) return { ramGb, local };
  if (platform() === 'darwin') {
    // Apple silicon shares memory; macOS lets the GPU use about three quarters of it.
    return { gpu: 'Apple GPU', gpuMemoryGb: Math.round(ramGb * 0.75), ramGb, local };
  }
  try {
    const out = execFileSync(
      'nvidia-smi',
      ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'],
      { encoding: 'utf8', timeout: 5000, windowsHide: true },
    );
    const [name, mib] = out.trim().split(/\r?\n/)[0]!.split(',');
    const gb = Math.round(Number(mib) / 1024);
    if (name && gb > 0) return { gpu: name.trim(), gpuMemoryGb: gb, ramGb, local };
  } catch {
    // no NVIDIA driver: CPU only, unless Ollama finds another GPU
  }
  return { ramGb, local };
}

export function isLocalHost(host: string): boolean {
  try {
    const { hostname } = new URL(host);
    return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostname);
  } catch {
    return false;
  }
}

/** Ollama has no sign-in, so an address outside this computer or a private network is a risk. */
export function isPrivateHost(host: string): boolean {
  try {
    const { hostname } = new URL(host);
    if (isLocalHost(host) || hostname.endsWith('.local') || !hostname.includes('.')) return true;
    return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(
      hostname,
    );
  } catch {
    return false;
  }
}

export interface LocalAdapterOptions {
  /** The Ollama address; read on every call, so a settings change applies at once. */
  host?: () => string;
  /** Replaces spawning OpenCode (tests). */
  exec?: Exec;
  /** Replaces HTTP calls to Ollama (tests). */
  fetch?: typeof fetch;
  hardware?: () => Hardware;
}

/**
 * Local models through Ollama, one provider with two engines. Answers (chat, councils, plans,
 * reviews) go to Ollama's own API, which takes a context size per request and reports token
 * counts. Building goes through OpenCode with a config Plenum writes for each run: the chosen
 * model, edits allowed, shell and web denied. Without OpenCode, local models still answer.
 */
export class LocalAdapter implements Adapter {
  readonly id = 'local' as const;
  readonly displayName = 'Local models';
  readonly capabilities: Capabilities = {
    models: [],
    readOnly: true,
    resume: false,
    streaming: true,
    quietMs: QUIET_MS,
    vision: 'none',
  };
  private readonly host: () => string;
  private readonly exec: Exec;
  private readonly http: typeof fetch;
  private readonly hardware: () => Hardware;
  /** OpenCode's version, once detect() has looked. */
  private opencode: string | null | undefined;

  constructor(opts: LocalAdapterOptions = {}) {
    this.host = () =>
      (opts.host?.() || process.env.OLLAMA_HOST || DEFAULT_OLLAMA_HOST).replace(/\/+$/, '');
    this.exec = opts.exec ?? defaultExec;
    this.http = opts.fetch ?? fetch;
    this.hardware = opts.hardware ?? (() => readHardware(this.host()));
  }

  private get ollamaCommand(): string {
    return locateCli('ollama', {
      windows: [join(homeDirs.localAppData, 'Programs', 'Ollama', 'ollama.exe')],
      unix: ['/usr/local/bin/ollama', '/opt/homebrew/bin/ollama'],
    });
  }

  private get opencodeCommand(): string {
    return locateCli('opencode', {
      windows: [join(homeDirs.appData, 'npm', 'opencode.cmd')],
      unix: [join(homeDirs.home, '.opencode', 'bin', 'opencode')],
    });
  }

  /** Building needs OpenCode, and levels 3 and 4 need command rules not verified yet. */
  permissionGap = (permissions: RunPermissions): string | undefined => {
    if (this.opencode === null) {
      return 'Install OpenCode to let local models build: npm install -g opencode-ai. They can still chat and review without it.';
    }
    if (permissions.level === 3 || permissions.level === 4) {
      return 'Local models build at levels 2 and 5 for now; command allow-lists for levels 3 and 4 are not verified yet.';
    }
    if (permissions.network && permissions.level < 5) {
      return 'Local models reach the network only at level 5.';
    }
    return undefined;
  };

  private async api<T>(path: string, body?: unknown, timeoutMs = 10_000): Promise<T> {
    const res = await this.http(`${this.host()}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      ...(body !== undefined && {
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`Ollama: ${res.status} ${await res.text().catch(() => '')}`);
    return (await res.json()) as T;
  }

  async detect(): Promise<ProviderStatus> {
    const oc = await runCommand(this.opencodeCommand, ['--version'], { timeoutMs: 20_000 });
    this.opencode = oc.code === 0 ? oc.stdout.trim().split(/\s+/)[0]! : null;
    try {
      const { version } = await this.api<{ version: string }>('/api/version', undefined, 4000);
      const { models } = await this.api<{ models: { name: string }[] }>('/api/tags');
      const count = models.filter((m) => !m.name.startsWith(ALIAS_PREFIX)).length;
      const where = isLocalHost(this.host())
        ? 'on this computer'
        : `on ${new URL(this.host()).host}`;
      return {
        provider: 'local',
        installed: true,
        version,
        auth: 'signed_in',
        detail: [
          count ? `${count} model${count === 1 ? '' : 's'} ${where}` : `No models yet ${where}`,
          this.opencode ? `OpenCode ${this.opencode} builds` : 'Install OpenCode to build',
        ].join(' · '),
      };
    } catch {
      const installed = isLocalHost(this.host())
        ? (await runCommand(this.ollamaCommand, ['--version'], { timeoutMs: 10_000 })).code === 0
        : true;
      return {
        provider: 'local',
        installed,
        auth: 'unknown',
        detail: installed
          ? `Ollama isn't answering at ${this.host()}. Start Ollama, then check again.`
          : 'Install Ollama to run models on your own computer.',
      };
    }
  }

  login(): LoginCommand {
    return {
      command: this.ollamaCommand,
      args: ['serve'],
      hint: 'Local models need no account. This starts Ollama; keep the window open.',
    };
  }

  /** Every downloaded model, with its size, context and whether it fits this machine. */
  async models(): Promise<ModelList> {
    const { models } = await this.api<{
      models: { name: string; size: number; details?: Record<string, unknown> }[];
    }>('/api/tags');
    const hw = this.hardware();
    const out: ModelOption[] = [];
    for (const m of models) {
      if (m.name.startsWith(ALIAS_PREFIX) || !/^[\w.:/-]+$/.test(m.name)) continue;
      const sizeGb = m.size / 1e9;
      const details = m.details ?? {};
      let context = num(details.context_length);
      let tools = false;
      try {
        const show = await this.api<{
          model_info?: Record<string, unknown>;
          capabilities?: string[];
        }>('/api/show', { model: m.name });
        context ??= Object.entries(show.model_info ?? {}).find(([k]) =>
          k.endsWith('.context_length'),
        )?.[1] as number | undefined;
        tools = (show.capabilities ?? []).includes('tools');
      } catch {
        // an older Ollama: list it without the extras
      }
      const fit = fitOf(sizeGb, hw);
      out.push({
        id: m.name,
        label: prettyName(m.name),
        description: [
          str(details.parameter_size),
          str(details.quantization_level),
          tools ? 'uses tools' : 'answers only',
        ]
          .filter(Boolean)
          .join(' · '),
        tags: [
          `${sizeGb < 10 ? sizeGb.toFixed(1) : Math.round(sizeGb)} GB`,
          ...(fit ? [fit === 'gpu' ? 'fits' : fit === 'partial' ? 'partly CPU' : 'too big'] : []),
          ...(context ? [`${Math.round(context / 1024)}k context`] : []),
        ],
        maker: makerOf(m.name),
      });
    }
    const best = bestFit(models, hw);
    return { models: out, ...(best && { defaultModel: best }) };
  }

  async *run(request: RunRequest): AsyncGenerator<AgentEvent> {
    assertSafeModel(request.model);
    // "Default" is the biggest downloaded model that fits this machine.
    const model = request.model ?? (await this.defaultModel());
    // PLENUM_LOCAL_REVIEWS=opencode sends reviews through OpenCode, read-only: for the
    // benchmark that compares the two engines (v0.9 C11). Ollama is faster for answers.
    const engine =
      request.role === 'reviewer' && process.env.PLENUM_LOCAL_REVIEWS === 'opencode'
        ? 'opencode'
        : localEngine(request.role, request.readOnly, request.permissions?.level);
    const stream = engine === 'opencode' ? this.build(request, model) : this.answer(request, model);
    // Say which engine ran, for the Usage screen. Local runs never resume, so the id isn't reused.
    let told = false;
    for await (const event of stream) {
      if (!told && event.type !== 'session') {
        const { runId, at } = event;
        yield { type: 'session', provider: 'local', runId, at, sessionId: runId, model, engine };
      }
      told = true;
      if (event.type === 'session') yield { ...event, engine };
      // OpenCode passes Ollama's "model 'x' not found" through as is; say it the same way chat does.
      else if (event.type === 'error' && /model .*not found/i.test(event.message))
        yield { ...event, message: explainOllamaError(event.message, model) };
      else yield event;
    }
  }

  private async defaultModel(): Promise<string> {
    try {
      const { models } = await this.api<{ models: { name: string; size: number }[] }>('/api/tags');
      return bestFit(models, this.hardware()) ?? '';
    } catch {
      return '';
    }
  }

  /** Answers straight from Ollama's chat API, streamed. */
  private answer(request: RunRequest, model: string): AsyncIterable<AgentEvent> {
    const job = request.role === 'reviewer' || request.role === 'planner' ? 'review' : 'chat';
    // Enough for the prompt (about 3.5 characters a token) plus the answer.
    const numCtx = Math.min(
      CONTEXT.build * 2,
      Math.max(CONTEXT[job], Math.ceil(request.prompt.length / 3.5) + 4096),
    );
    const body = {
      model,
      messages: [{ role: 'user', content: request.prompt }],
      stream: true,
      options: { num_ctx: numCtx },
      // The model stays loaded for the next task instead of reloading each time.
      keep_alive: '30m',
    };
    return runCli(
      'local',
      httpExec(this.http, `${this.host()}/api/chat`, body),
      {
        command: 'ollama',
        args: [],
        ...(request.signal && { signal: request.signal }),
        ...(request.timeoutMs && { timeoutMs: request.timeoutMs }),
      },
      new OllamaParser(model),
    );
  }

  /** Builds with OpenCode on the chosen model, given a context it can work in. */
  private async *build(request: RunRequest, model: string): AsyncGenerator<AgentEvent> {
    const alias = await this.ensureContext(model, CONTEXT.build);
    const dir = mkdtempSync(join(tmpdir(), 'plenum-opencode-'));
    try {
      const config = join(dir, 'opencode.json');
      writeFileSync(
        config,
        JSON.stringify(
          openCodeConfig(this.host(), alias, request.permissions, request.readOnly ?? false),
        ),
      );
      // The task goes in an attached file: no command-line limits or quoting on Windows.
      const brief = join(dir, 'instructions.md');
      writeFileSync(brief, request.prompt);
      yield* runCli(
        'local',
        this.exec,
        {
          command: this.opencodeCommand,
          args: openCodeArgs(alias, brief, request.cwd),
          cwd: request.cwd,
          // An open stdin makes `opencode run` wait for more input.
          stdin: '',
          // OpenCode takes its folder from PWD when it's set, not from the process: an inherited
          // PWD once pointed it at the folder Plenum was started from. Both name the worktree.
          env: { ...process.env, PWD: request.cwd, OPENCODE_CONFIG: config },
          ...(request.signal && { signal: request.signal }),
          ...(request.timeoutMs && { timeoutMs: request.timeoutMs }),
        },
        new OpenCodeParser(),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Downloads a model into Ollama, reporting progress lines. Callers ask the user first. */
  async pull(model: string, onProgress: (line: string) => void): Promise<void> {
    assertSafeModel(model);
    const exec = httpExec(this.http, `${this.host()}/api/pull`, { model, stream: true });
    let last = '';
    for await (const chunk of exec({ command: 'ollama', args: [], timeoutMs: 6 * 60 * 60_000 })) {
      if (chunk.kind === 'line') {
        let status = chunk.line;
        try {
          const p = JSON.parse(chunk.line) as {
            status?: string;
            completed?: number;
            total?: number;
            error?: string;
          };
          if (p.error) throw new Error(explainOllamaError(p.error, model));
          status = p.total
            ? `${p.status ?? 'pulling'} ${Math.floor(((p.completed ?? 0) / p.total) * 100)}%`
            : (p.status ?? '');
        } catch (e) {
          if (e instanceof Error && !(e instanceof SyntaxError)) throw e;
        }
        if (status && status !== last) onProgress(`${status}\n`);
        last = status;
      } else if (chunk.kind === 'exit' && (chunk.code !== 0 || chunk.error)) {
        throw new Error(chunk.error ?? `Ollama couldn't download ${model}`);
      }
    }
  }

  /**
   * A model whose default context is too small for OpenCode's instructions gets a same-weights
   * alias with a bigger one (`plenum/<model>-32k`): Ollama's OpenAI-style endpoint, which
   * OpenCode uses, can't set the context per request.
   */
  private async ensureContext(model: string, want: number): Promise<string> {
    let max = want;
    try {
      const show = await this.api<{ model_info?: Record<string, unknown> }>('/api/show', { model });
      const listed = Object.entries(show.model_info ?? {}).find(([k]) =>
        k.endsWith('.context_length'),
      )?.[1];
      if (typeof listed === 'number') max = Math.min(want, listed);
    } catch {
      return model;
    }
    const alias = `${ALIAS_PREFIX}${model}-${Math.round(max / 1024)}k`;
    await this.api(
      '/api/create',
      { model: alias, from: model, parameters: { num_ctx: max }, stream: false },
      60_000,
    ).catch(() => undefined);
    return alias;
  }
}

/** The biggest model that fits in GPU memory, else the smallest one (it at least runs). */
export function bestFit(
  models: { name: string; size: number }[],
  hw: Hardware,
): string | undefined {
  const own = models.filter((m) => !m.name.startsWith(ALIAS_PREFIX));
  const fitting = own.filter((m) => fitOf(m.size / 1e9, hw) === 'gpu');
  const pick = fitting.length
    ? fitting.reduce((a, b) => (b.size > a.size ? b : a))
    : own.reduce<(typeof own)[number] | undefined>(
        (a, b) => (!a || b.size < a.size ? b : a),
        undefined,
      );
  return pick?.name;
}

const ACRONYMS: Record<string, string> = { gpt: 'GPT', oss: 'OSS', glm: 'GLM', qwq: 'QwQ' };

/** "gpt-oss:20b" → "GPT-OSS 20B", "llama3.2:1b" → "Llama 3.2 1B", "qwen2.5-coder:14b" → "Qwen2.5 Coder 14B". */
export function prettyName(id: string): string {
  const [name = id, tag] = id.split(':');
  const words = name
    .replace(/^.*\//, '')
    .split(/[-_]/)
    .map((w) => {
      if (ACRONYMS[w]) return ACRONYMS[w]!;
      const split = /^(llama|gemma|phi|mistral|granite)(\d.*)$/.exec(w);
      if (split) return `${split[1]!.charAt(0).toUpperCase()}${split[1]!.slice(1)} ${split[2]}`;
      return /^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1);
    });
  // Acronym pairs read as one name: GPT-OSS.
  const joined = words.join(' ').replace(/\b(GPT) (OSS)\b/, '$1-$2');
  return [joined, tag && tag !== 'latest' ? tag.toUpperCase() : ''].filter(Boolean).join(' ');
}

export function openCodeArgs(model: string, brief: string, cwd: string): string[] {
  return [
    'run',
    // The message comes first: --file takes several values and would swallow it.
    'Follow the instructions in the attached file exactly. They are this task, not part of the project.',
    '--format',
    'json',
    '-m',
    `ollama/${model}`,
    '--file',
    brief,
    '--dir',
    cwd,
  ];
}

/** OpenCode's config for one run: the model on this Ollama, and what it may do. */
export function openCodeConfig(
  host: string,
  model: string,
  permissions?: RunPermissions,
  readOnly = false,
) {
  const full = permissions?.level === 5 && !readOnly;
  return {
    $schema: 'https://opencode.ai/config.json',
    provider: {
      ollama: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Ollama',
        options: { baseURL: `${host}/v1` },
        models: {
          [model]: { name: model, tools: true, limit: { context: CONTEXT.build, output: 8192 } },
        },
      },
    },
    model: `ollama/${model}`,
    permission: full
      ? { edit: 'allow', bash: 'allow', webfetch: 'allow' }
      : { edit: readOnly ? 'deny' : 'allow', bash: 'deny', webfetch: 'deny' },
    share: 'disabled',
    autoupdate: false,
  };
}

/** Streams an HTTP response's lines as if a process printed them, so runCli can parse it. */
export function httpExec(http: typeof fetch, url: string, body: unknown): Exec {
  return async function* (opts: ProcessOptions): AsyncGenerator<ProcessChunk> {
    // The caller's stop and our timeout, let go of when the request is over.
    const timeout = new AbortController();
    const timer = opts.timeoutMs
      ? setTimeout(
          () => timeout.abort(new Error(`Timed out after ${opts.timeoutMs} ms`)),
          opts.timeoutMs,
        )
      : undefined;
    const { signal, dispose } = linkSignals(opts.signal, timeout.signal);
    try {
      yield* request(signal);
    } finally {
      clearTimeout(timer);
      dispose();
    }
  };

  async function* request(signal: AbortSignal): AsyncGenerator<ProcessChunk> {
    let res: Response;
    try {
      res = await http(url, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
        signal,
      });
    } catch (e) {
      yield {
        kind: 'exit',
        code: null,
        error: `Ollama isn't answering at ${new URL(url).origin}: ${(e as Error).message}`,
      };
      return;
    }
    if (!res.ok || !res.body) {
      // Ollama's errors are JSON ({"error": "..."}): hand them to the parser like a stream line.
      yield { kind: 'line', line: await res.text().catch(() => '{}') };
      yield { kind: 'exit', code: 1 };
      return;
    }
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let at: number;
        while ((at = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, at).trim();
          buffer = buffer.slice(at + 1);
          if (line) yield { kind: 'line', line };
        }
      }
      if (buffer.trim()) yield { kind: 'line', line: buffer.trim() };
      yield { kind: 'exit', code: 0 };
    } catch (e) {
      yield { kind: 'exit', code: null, error: signal.aborted ? 'Stopped' : (e as Error).message };
    }
  }
}

/** Ollama's streamed `/api/chat` lines: message pieces, then one line with `done` and the counts. */
export class OllamaParser implements LineParser {
  failed = false;
  private answer = '';

  constructor(private readonly model: string) {}

  parse(message: unknown): EventBody[] {
    if (!isRecord(message)) return [];
    const error = str(message.error);
    if (error) {
      this.failed = true;
      return [failure(explainOllamaError(error, this.model))];
    }
    const out: EventBody[] = [];
    const text = isRecord(message.message) ? str(message.message.content) : undefined;
    if (text) {
      this.answer += text;
      out.push({ type: 'message.delta', text });
    }
    if (message.done === true) {
      out.push({
        type: 'usage',
        usage: tokenUsage({
          input: num(message.prompt_eval_count),
          output: num(message.eval_count),
        }),
      });
      out.push({ type: 'message.done', text: this.answer.trim() });
    }
    return out;
  }
}

export function explainOllamaError(error: string, model: string): string {
  if (/not found/i.test(error))
    return `${model || 'That model'} isn't downloaded in Ollama. Pull it first, or pick another.`;
  if (/memory|out of memory|too large/i.test(error)) {
    return `${model || 'That model'} is too big for this machine's memory. Try a smaller one.`;
  }
  return `Ollama: ${error}`;
}

/** `opencode run --format json`: text parts, tool calls with their state, and token counts per step. */
export class OpenCodeParser extends TypedEventParser {
  private readonly announced = new Set<string>();
  private tokens = { input: 0, output: 0, cached: 0 };

  protected on(type: string, message: Record<string, unknown>): EventBody[] {
    const part = isRecord(message.part) ? message.part : {};
    switch (type) {
      case 'text': {
        const text = str(part.text);
        return text ? this.delta(this.answer ? `\n\n${text}` : text) : [];
      }
      case 'tool_use':
        return this.tool(part);
      case 'step_finish': {
        const t = isRecord(part.tokens) ? part.tokens : {};
        const cache = isRecord(t.cache) ? t.cache : {};
        this.tokens.input += num(t.input) ?? 0;
        this.tokens.output += sum(num(t.output), num(t.reasoning)) ?? 0;
        this.tokens.cached += num(cache.read) ?? 0;
        return [];
      }
      case 'error': {
        const err = isRecord(message.error) ? message.error : {};
        const data = isRecord(err.data) ? err.data : {};
        return this.fail(str(data.message) ?? str(err.name) ?? 'OpenCode failed');
      }
      default:
        return [];
    }
  }

  finish(ok: boolean): EventBody[] {
    if (!ok) return [];
    return [
      this.usage(
        tokenUsage({
          input: this.tokens.input,
          cached: this.tokens.cached,
          output: this.tokens.output,
        }),
      ),
      this.done(),
    ];
  }

  private tool(part: Record<string, unknown>): EventBody[] {
    const id = str(part.callID) ?? str(part.id) ?? '';
    const state = isRecord(part.state) ? part.state : {};
    const input = isRecord(state.input) ? state.input : {};
    const tool = str(part.tool) ?? 'tool';
    const out: EventBody[] = [];
    if (!this.announced.has(id)) {
      this.announced.add(id);
      out.push(
        tool === 'bash'
          ? { type: 'tool.call', tool: 'shell', input: { command: str(input.command) } }
          : { type: 'tool.call', tool, input },
      );
    }
    const path = str(input.filePath);
    if ((tool === 'edit' || tool === 'write') && path && state.status === 'completed') {
      out.push({ type: 'file.edit', path, kind: tool === 'write' ? 'add' : 'update' });
    }
    return out;
  }
}

/** Which engine a request needs: OpenCode only when it may edit files. */
export function localEngine(
  role: Role | undefined,
  readOnly: boolean | undefined,
  level = 2,
): 'ollama' | 'opencode' {
  const writing = !(readOnly ?? true) && role !== 'chat' && role !== 'synthesizer' && level > 1;
  return writing ? 'opencode' : 'ollama';
}
