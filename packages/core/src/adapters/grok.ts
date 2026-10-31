import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AgentEvent, ProviderStatus, Role } from '@conclave/shared';
import { runCommand } from '../process.js';
import type { RunPermissions } from './permissions.js';
import {
  assertSafeEffort,
  assertSafeModel,
  assertSafeSession,
  defaultExec,
  detectVersion,
  homeDirs,
  isRecord,
  locateCli,
  num,
  runCli,
  safeImage,
  str,
  sum,
  tokenUsage,
  TypedEventParser,
  type CliAdapterOptions,
  type EventBody,
  type Exec,
} from './kit/index.js';
import type { Adapter, Capabilities, LoginCommand, ModelList, RunRequest } from './types.js';
import { QUIET_MS } from './types.js';

/** The levels `--effort` accepts (its own error lists them: "use one of: xhigh, high, medium, low"). */
const GROK_EFFORTS = ['low', 'medium', 'high', 'xhigh'];

const EDIT_TOOLS = ['write', 'search_replace'];
const DENY_ALWAYS = ['web_fetch', 'web_search'];

/**
 * Drives xAI's Grok Build CLI headless: `grok --prompt-file <file> --output-format
 * streaming-json`. Format recorded from grok 1.0.70 on a free grok.com account
 * (see test/fixtures/grok). Permissions are its own allow and deny rules, checked live:
 * level 2 writes files while `run_terminal_command` and `web_fetch` are "Denied by
 * permission policy".
 */
export class GrokAdapter implements Adapter {
  permissionGap = grokPermissionGap;
  readonly id = 'grok' as const;
  readonly displayName = 'Grok Build';
  readonly capabilities: Capabilities = {
    models: ['grok-4.7'],
    efforts: GROK_EFFORTS,
    readOnly: true,
    resume: true,
    streaming: true,
    quietMs: QUIET_MS,
    vision: 'files',
  };
  private readonly exec: Exec;
  private readonly explicitCommand: string | undefined;

  constructor(opts: CliAdapterOptions = {}) {
    this.exec = opts.exec ?? defaultExec;
    this.explicitCommand = opts.command;
  }

  /** Its installer puts grok in ~/.grok/bin, on PATH only in new terminals. */
  private get command(): string {
    return (
      this.explicitCommand ??
      locateCli('grok', {
        windows: [join(homeDirs.home, '.grok', 'bin', 'grok.exe')],
        unix: [join(homeDirs.home, '.grok', 'bin', 'grok')],
      })
    );
  }

  async detect(): Promise<ProviderStatus> {
    const found = await detectVersion('grok', this.command, {
      missing: 'Grok Build CLI (grok) not found',
      // "grok 1.0.70 (f50904eaee6c)"
      version: (out) => out.split(/\s+/)[1],
    });
    if (!found.installed) return found.status;
    const status: ProviderStatus = {
      provider: 'grok',
      installed: true,
      version: found.version,
      auth: 'unknown',
    };
    // Listing models needs a signed-in account and spends nothing.
    const models = await runCommand(this.command, ['models'], {
      timeoutMs: 30_000,
    });
    if (models.code === 0 && /logged in/i.test(models.stdout)) {
      status.auth = 'signed_in';
      status.detail = /grok\.com/i.test(models.stdout) ? 'grok.com account' : 'Signed in';
    } else {
      status.auth = 'signed_out';
    }
    return status;
  }

  login(): LoginCommand {
    return {
      command: this.command,
      args: ['login'],
      hint: 'Grok shows a code and a link. Open the link, check the code matches, and approve.',
    };
  }

  async models(): Promise<ModelList> {
    const result = await runCommand(this.command, ['models'], {
      timeoutMs: 30_000,
    });
    return parseGrokModels(result.stdout);
  }

  async *run(request: RunRequest): AsyncGenerator<AgentEvent> {
    const { args, cleanup } = grokArgs(request);
    try {
      yield* runCli(
        'grok',
        this.exec,
        {
          command: this.command,
          args,
          cwd: request.cwd,
          ...(request.signal && { signal: request.signal }),
          ...(request.timeoutMs && { timeoutMs: request.timeoutMs }),
        },
        new GrokParser(),
      );
    } finally {
      cleanup();
    }
  }
}

/** `grok models`: "Default model: grok-4.7" and lines like "  * grok-4.7 (default)". */
export function parseGrokModels(text: string): ModelList {
  const ids = text.split(/\r?\n/).flatMap((l) => {
    const m = /^\s*\*?\s*([\w.:-]+)(?:\s+\(default\))?\s*$/.exec(l);
    return m && /\d/.test(m[1]!) ? [m[1]!] : [];
  });
  const defaultModel = /Default model:\s*([\w.:-]+)/i.exec(text)?.[1];
  return {
    models: ids.map((id) => ({
      id,
      label: id.replace(/^grok-/, 'Grok ').replace(/-/g, ' '),
      efforts: GROK_EFFORTS,
      maker: 'Grok',
    })),
    ...(defaultModel && { defaultModel }),
  };
}

/** The prompt goes in a file (`--prompt-file`): no quoting or length limits on Windows. */
export function grokArgs(request: RunRequest): { args: string[]; cleanup: () => void } {
  assertSafeModel(request.model);
  assertSafeEffort(request.effort);
  assertSafeSession(request.sessionId);
  const dir = mkdtempSync(join(tmpdir(), 'conclave-grok-'));
  const file = join(dir, 'prompt.md');
  writeFileSync(file, request.prompt);
  const args = [
    '--prompt-file',
    file,
    '--output-format',
    'streaming-json',
    '--no-auto-update',
    '--no-subagents',
    ...permissionArgs(request.role ?? 'chat', request.readOnly ?? true, request.permissions),
  ];
  if (request.model) args.push('--model', request.model);
  if (request.effort) args.push('--effort', request.effort);
  if (request.sessionId) args.push('--resume', request.sessionId);
  for (const d of new Set((request.images ?? []).map((p) => dirname(safeImage(p))))) {
    args.push('--add-dir', d);
  }
  return { args, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function rules(flag: '--allow' | '--deny', tools: string[]): string[] {
  return tools.flatMap((t) => [flag, t]);
}

function permissionArgs(role: Role, readOnly: boolean, permissions?: RunPermissions): string[] {
  const level = permissions?.level ?? 2;
  const writing = !readOnly && role !== 'chat' && role !== 'synthesizer' && level > 1;
  if (writing && level === 5) return ['--permission-mode', 'bypassPermissions'];
  // dontAsk: anything not allowed is refused instead of waiting for an answer.
  if (writing) {
    return [
      '--permission-mode',
      'dontAsk',
      ...rules('--allow', EDIT_TOOLS),
      ...rules('--deny', ['run_terminal_command', ...DENY_ALWAYS]),
    ];
  }
  return [
    '--permission-mode',
    'dontAsk',
    ...rules('--deny', [...EDIT_TOOLS, 'run_terminal_command', ...DENY_ALWAYS]),
  ];
}

/** Command allow-lists aren't verified yet, so levels 3 and 4 wait. */
export function grokPermissionGap(permissions: RunPermissions): string | undefined {
  if (permissions.level === 3 || permissions.level === 4) {
    return 'Grok Build works at levels 1, 2 and 5 in Conclave for now; command allow-lists for levels 3 and 4 are not verified yet.';
  }
  if (permissions.network && permissions.level < 5) {
    return 'Grok Build reaches the network only at level 5 in Conclave.';
  }
  return undefined;
}

export class GrokParser extends TypedEventParser {
  protected on(type: string, message: Record<string, unknown>): EventBody[] {
    switch (type) {
      case 'text':
        return this.delta(str(message.data));
      case 'tool_call':
        return toolCall(message);
      case 'error':
        return this.fail(str(message.message) ?? 'Grok Build failed');
      case 'end':
        return this.end(message);
      default:
        // thought, available_commands, tool_call_update, usage (repeated in end)
        return [];
    }
  }

  private end(message: Record<string, unknown>): EventBody[] {
    const out: EventBody[] = [];
    const sessionId = str(message.sessionId);
    if (sessionId) out.push({ type: 'session', sessionId });
    const usage = isRecord(message.usage) ? message.usage : {};
    const cached = num(usage.cache_read_input_tokens);
    out.push(
      this.usage(
        tokenUsage({
          // Like Claude: input_tokens leaves out the cache reads and writes.
          input: sum(num(usage.input_tokens), cached, num(usage.cache_creation_input_tokens)),
          cached,
          output: num(usage.output_tokens),
        }),
      ),
    );
    const reason = str(message.stopReason);
    if (reason === 'end_turn' || reason === 'max_turns' || reason === 'max_tokens') {
      out.push(this.done());
    } else {
      // "cancelled": it needed a permission headless mode can't ask for; stderr says which.
      this.failed = true;
    }
    return out;
  }
}

function toolCall(message: Record<string, unknown>): EventBody[] {
  const tool = str(message.toolName) ?? 'tool';
  const input = isRecord(message.rawInput) ? message.rawInput : {};
  if (tool === 'run_terminal_command') {
    return [{ type: 'tool.call', tool: 'shell', input: { command: str(input.command) } }];
  }
  const out: EventBody[] = [{ type: 'tool.call', tool, input }];
  const path = str(input.file_path) ?? str(input.target_file) ?? str(input.path);
  if (EDIT_TOOLS.includes(tool) && path) {
    out.push({ type: 'file.edit', path, kind: tool === 'write' ? 'add' : 'update' });
  }
  return out;
}
