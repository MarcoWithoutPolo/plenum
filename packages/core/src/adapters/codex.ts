import type { AgentEvent, ProviderStatus } from '@conclave/shared';
import { runCommand } from '../process.js';
import {
  assertSafeEffort,
  assertSafeModel,
  assertSafeSession,
  defaultExec,
  detectVersion,
  limitResetsAt,
  looksLikeLimit,
  isRecord,
  num,
  runCli,
  safeImage,
  str,
  tokenUsage,
  type CliAdapterOptions,
  type EventBody,
  type Exec,
  type LineParser,
} from './kit/index.js';
import { codexHome, readCodexDefaults, readCodexLimits, readCodexModels } from './codex-home.js';
import type { Adapter, Capabilities, LoginCommand, ModelList, RunRequest } from './types.js';

export interface CodexAdapterOptions extends CliAdapterOptions {
  /** The Codex data folder; defaults to CODEX_HOME or ~/.codex. */
  home?: string;
}

/**
 * Drives the official OpenAI Codex CLI in headless mode:
 * `codex exec --json -`, prompt on stdin.
 * Format recorded from codex-cli 0.163 (see test/fixtures/codex).
 */
export class CodexAdapter implements Adapter {
  readonly id = 'codex' as const;
  readonly displayName = 'OpenAI Codex';
  readonly capabilities: Capabilities = {
    // Codex picks the model allowed for the signed-in plan; override per chat if needed.
    models: [],
    readOnly: true,
    resume: true,
    streaming: false,
    // codex exec --image attaches pictures to the prompt.
    vision: 'native',
  };
  private readonly command: string;
  private readonly exec: Exec;
  private readonly home: string;

  constructor(opts: CodexAdapterOptions = {}) {
    this.command = opts.command ?? 'codex';
    this.exec = opts.exec ?? defaultExec;
    this.home = opts.home ?? codexHome();
  }

  async detect(): Promise<ProviderStatus> {
    const found = await detectVersion('codex', this.command, {
      missing: 'Codex CLI not found on PATH',
      version: (out) => out.replace(/^codex-cli\s+/, ''),
    });
    if (!found.installed) return found.status;
    const status: ProviderStatus = {
      provider: 'codex',
      installed: true,
      version: found.version,
      auth: 'unknown',
    };
    const auth = await runCommand(this.command, ['login', 'status']);
    const text = `${auth.stdout}\n${auth.stderr}`.trim();
    if (auth.code === 0 && /logged in/i.test(text)) {
      status.auth = 'signed_in';
      status.detail = text.split(/\r?\n/)[0];
    } else if (/not logged in/i.test(text) || auth.code !== 0) {
      status.auth = 'signed_out';
    }
    return status;
  }

  login(): LoginCommand {
    return {
      command: this.command,
      args: ['login'],
      hint: 'Your browser opens the ChatGPT sign-in page. Choose "Sign in with ChatGPT".',
    };
  }

  async models(): Promise<ModelList> {
    const defaults = readCodexDefaults(this.home);
    return {
      models: readCodexModels(this.home).map((m) => ({
        id: m.id,
        label: m.label,
        ...(m.description && { description: m.description }),
        efforts: m.efforts,
        ...(m.defaultEffort && { defaultEffort: m.defaultEffort }),
      })),
      ...(defaults.model && { defaultModel: defaults.model }),
      ...(defaults.effort && { defaultEffort: defaults.effort }),
    };
  }

  async limits() {
    return readCodexLimits(undefined, this.home);
  }

  /** Runs the CLI, then reports the plan usage Codex logged for this session. */
  async *run(request: RunRequest): AsyncGenerator<AgentEvent> {
    let threadId: string | undefined;
    for await (const event of this.runCli(request)) {
      if (event.type === 'session') threadId = event.sessionId;
      if (event.type === 'done' && threadId) {
        for (const limit of readCodexLimits(threadId, this.home)) {
          yield { provider: 'codex', runId: event.runId, at: Date.now(), type: 'quota', ...limit };
        }
      }
      yield event;
    }
  }

  private runCli(request: RunRequest) {
    return runCli(
      'codex',
      this.exec,
      {
        command: this.command,
        args: codexArgs(request),
        cwd: request.cwd,
        stdin: request.prompt,
        ...(request.signal && { signal: request.signal }),
        ...(request.timeoutMs && { timeoutMs: request.timeoutMs }),
      },
      new CodexParser(),
    );
  }
}

export function codexArgs(request: RunRequest): string[] {
  assertSafeModel(request.model);
  assertSafeEffort(request.effort);
  const args = ['exec'];
  assertSafeSession(request.sessionId);
  if (request.sessionId) args.push('resume', request.sessionId);
  // Before the other flags, so a multi-value --image never swallows them.
  if (!request.sessionId)
    for (const img of request.images ?? []) args.push('--image', safeImage(img));
  args.push('--json', '--skip-git-repo-check', '--color', 'never');
  // resume inherits the original session's sandbox, so only set it on new sessions.
  if (!request.sessionId) args.push(...sandboxArgs(request));
  if (request.model) args.push('-m', request.model);
  // A bare value that isn't valid TOML is taken as a literal string by Codex.
  if (request.effort) args.push('-c', `model_reasoning_effort=${request.effort}`);
  args.push('-');
  return args;
}

/**
 * Codex runs every command inside its sandbox: read-only for level 1, the worktree only and
 * no network for levels 2–4 (network when allowed), and no sandbox at level 5.
 */
function sandboxArgs(request: RunRequest): string[] {
  const level = request.permissions?.level ?? 2;
  if ((request.readOnly ?? true) || level === 1) return ['--sandbox', 'read-only'];
  if (level === 5) return ['--dangerously-bypass-approvals-and-sandbox'];
  return [
    '--sandbox',
    'workspace-write',
    ...(request.permissions?.network ? ['-c', 'sandbox_workspace_write.network_access=true'] : []),
  ];
}

export class CodexParser implements LineParser {
  failed = false;
  private lastMessage = '';
  private lastError = '';

  parse(message: unknown): EventBody[] {
    if (!isRecord(message)) return [];
    switch (message.type) {
      case 'thread.started': {
        const id = str(message.thread_id);
        return id ? [{ type: 'session', sessionId: id }] : [];
      }
      case 'item.completed':
        return this.item(message.item);
      case 'turn.completed':
        return this.turnCompleted(message.usage);
      case 'error':
        return this.error(str(message.message));
      case 'turn.failed':
        this.failed = true;
        return this.error(isRecord(message.error) ? str(message.error.message) : undefined);
      default:
        return [];
    }
  }

  private item(item: unknown): EventBody[] {
    if (!isRecord(item)) return [];
    switch (item.type) {
      case 'agent_message': {
        const text = str(item.text) ?? '';
        if (!text) return [];
        // Codex sends whole messages; keep consecutive ones apart in the stream.
        const delta = this.lastMessage
          ? `

${text}`
          : text;
        this.lastMessage = text;
        return [{ type: 'message.delta', text: delta }];
      }
      case 'command_execution':
        return [{ type: 'tool.call', tool: 'shell', input: { command: item.command } }];
      case 'mcp_tool_call':
        return [
          { type: 'tool.call', tool: `${str(item.server) ?? 'mcp'}:${str(item.tool) ?? '?'}` },
        ];
      case 'web_search':
        return [{ type: 'tool.call', tool: 'web_search', input: { query: item.query } }];
      case 'file_change': {
        const changes = Array.isArray(item.changes) ? item.changes : [];
        return changes.filter(isRecord).flatMap((c): EventBody[] => {
          const path = str(c.path);
          if (!path) return [];
          const kind = c.kind === 'add' || c.kind === 'delete' ? c.kind : 'update';
          return [{ type: 'file.edit', path, kind }];
        });
      }
      default:
        // 'error' items are non-fatal warnings (e.g. unknown model metadata); 'reasoning' is hidden thinking.
        return [];
    }
  }

  private turnCompleted(usage: unknown): EventBody[] {
    const out: EventBody[] = [{ type: 'message.done', text: this.lastMessage }];
    if (isRecord(usage)) {
      const input = num(usage.input_tokens);
      const cached = num(usage.cached_input_tokens);
      const output = (num(usage.output_tokens) ?? 0) + (num(usage.reasoning_output_tokens) ?? 0);
      out.push({ type: 'usage', usage: tokenUsage({ input, cached, output }) });
    }
    return out;
  }

  private error(raw: string | undefined): EventBody[] {
    this.failed = true;
    const message = unwrapApiError(raw) ?? 'Codex failed';
    if (message === this.lastError) return []; // turn.failed repeats the preceding error
    this.lastError = message;
    if (looksLikeLimit(`${raw} ${message}`)) {
      const resetsAt = limitResetsAt(message);
      return [{ type: 'rate_limit', message, ...(resetsAt && { resetsAt }) }];
    }
    return [{ type: 'error', message }];
  }
}

/** Codex wraps API errors as a JSON string inside `message`; pull out the readable part. */
function unwrapApiError(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed)) {
      const inner = isRecord(parsed.error) ? str(parsed.error.message) : str(parsed.message);
      if (inner) return inner;
    }
  } catch {
    // not JSON, use as is
  }
  return raw;
}
