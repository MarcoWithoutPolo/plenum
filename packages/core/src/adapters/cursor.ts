import { dirname, join } from 'node:path';
import {
  groupVariants,
  markOlder,
  type AgentEvent,
  type ProviderStatus,
  type Role,
  type Usage,
} from '@conclave/shared';
import { runCommand } from '../process.js';
import type { RunPermissions } from './permissions.js';
import {
  assertSafeModel,
  assertSafeSession,
  ClaudeStreamParser,
  defaultExec,
  detectVersion,
  homeDirs,
  isRecord,
  locateCli,
  num,
  runCli,
  safeImage,
  str,
  tokenUsage,
  type CliAdapterOptions,
  type EventBody,
  type Exec,
} from './kit/index.js';
import type { Adapter, Capabilities, LoginCommand, ModelList, RunRequest } from './types.js';
import { QUIET_MS } from './types.js';

/**
 * Drives Cursor's agent CLI headless: `cursor-agent -p --output-format stream-json`, prompt on
 * stdin. Always called as `cursor-agent`: Grok Build's installer takes over the `agent` name.
 * Format recorded from cursor-agent 2026.10.22 (see test/fixtures/cursor). In print mode
 * without --force it applies file edits but refuses shell commands and web fetches (checked
 * live), which is exactly level 2.
 */
export class CursorAdapter implements Adapter {
  permissionGap = cursorPermissionGap;
  readonly id = 'cursor' as const;
  readonly displayName = 'Cursor';
  readonly capabilities: Capabilities = {
    models: ['auto'],
    defaultModel: 'auto',
    readOnly: true,
    resume: true,
    streaming: true,
    quietMs: QUIET_MS,
    // It opens image files named in the prompt with its read tool.
    vision: 'files',
  };
  private readonly exec: Exec;
  private readonly explicitCommand: string | undefined;

  constructor(opts: CliAdapterOptions = {}) {
    this.exec = opts.exec ?? defaultExec;
    this.explicitCommand = opts.command;
  }

  private get command(): string {
    return (
      this.explicitCommand ??
      locateCli('cursor-agent', {
        windows: [join(homeDirs.localAppData, 'cursor-agent', 'cursor-agent.cmd')],
        unix: [join(homeDirs.home, '.local', 'bin', 'cursor-agent')],
      })
    );
  }

  async detect(): Promise<ProviderStatus> {
    const found = await detectVersion('cursor', this.command, {
      missing: 'Cursor CLI (cursor-agent) not found',
    });
    if (!found.installed) return found.status;
    const status: ProviderStatus = {
      provider: 'cursor',
      installed: true,
      version: found.version,
      auth: 'unknown',
    };
    // "✓ Logged in as <email>": only the fact is kept, never the account name.
    // Its launcher goes through PowerShell, slow when every CLI is checked at once.
    const auth = await runCommand(this.command, ['status'], { timeoutMs: 90_000 });
    const text = `${auth.stdout}\n${auth.stderr}`;
    if (/logged in/i.test(text) && !/not logged in/i.test(text)) {
      status.auth = 'signed_in';
      status.detail = 'Cursor account';
    } else {
      status.auth = 'signed_out';
    }
    return status;
  }

  login(): LoginCommand {
    return {
      command: this.command,
      args: ['login'],
      hint: 'Your browser opens the Cursor sign-in page. Sign in there, then come back.',
    };
  }

  /** `cursor-agent models`: about 270 ids, grouped into one row per model with its efforts. */
  async models(): Promise<ModelList> {
    const result = await runCommand(this.command, ['models'], { timeoutMs: 120_000 });
    return parseCursorModels(result.stdout);
  }

  run(request: RunRequest): AsyncIterable<AgentEvent> {
    return runCli(
      'cursor',
      this.exec,
      {
        command: this.command,
        args: cursorArgs(request),
        cwd: request.cwd,
        stdin: request.prompt,
        ...(request.signal && { signal: request.signal }),
        ...(request.timeoutMs && { timeoutMs: request.timeoutMs }),
      },
      new CursorParser(),
    );
  }
}

/** Lines like `gpt-5.3-codex-high - Codex 5.3 High`; "(current, default)" marks the default. */
export function parseCursorModels(text: string): ModelList {
  let defaultModel: string | undefined;
  const entries = text.split(/\r?\n/).flatMap((line) => {
    const m = /^([\w.:/[\]-]+) - (.+)$/.exec(line.trim());
    if (!m) return [];
    const label = m[2]!.replace(/\s*\((?:current, )?default\)|\s*\(current\)/i, '').trim();
    if (/\(.*default\)/i.test(m[2]!)) defaultModel = m[1]!;
    return [{ id: m[1]!, label }];
  });
  return {
    models: markOlder(groupVariants(entries)),
    ...(defaultModel && { defaultModel }),
  };
}

export function cursorArgs(request: RunRequest): string[] {
  assertSafeModel(request.model);
  assertSafeSession(request.sessionId);
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--stream-partial-output',
    // Conclave runs it only in its own worktrees and temp folders.
    '--trust',
    ...modeArgs(request.role ?? 'chat', request.readOnly ?? true, request.permissions),
  ];
  // Without --model it runs the account's saved model, which a free plan can refuse even
  // though `models` lists Auto as the default: name it.
  args.push('--model', request.model ?? 'auto');
  if (request.sessionId) args.push('--resume', request.sessionId);
  for (const dir of new Set((request.images ?? []).map((p) => dirname(safeImage(p))))) {
    args.push('--add-dir', dir);
  }
  return args;
}

function modeArgs(role: Role, readOnly: boolean, permissions?: RunPermissions): string[] {
  if (role === 'chat' || role === 'synthesizer' || readOnly) return ['--mode', 'ask'];
  const level = permissions?.level ?? 2;
  if (level === 1) return ['--mode', 'ask'];
  if (level === 5) return ['--force'];
  // Level 2: print mode without --force edits files and refuses commands and web fetches.
  return [];
}

/** Without a per-run rule file, Cursor runs either no commands or all of them. */
export function cursorPermissionGap(permissions: RunPermissions): string | undefined {
  if (permissions.level === 3 || permissions.level === 4) {
    return "Cursor can't limit which commands run from Conclave, so it works at levels 1, 2 and 5 only.";
  }
  if (permissions.network && permissions.level < 5) {
    return 'Cursor only reaches the network at level 5.';
  }
  return undefined;
}

/** Cursor's tool names in stream-json, as they appear in `tool_call` events. */
const EDIT_CALLS = new Set(['editToolCall', 'writeToolCall', 'multiEditToolCall']);

export class CursorParser extends ClaudeStreamParser {
  protected readonly cliName = 'Cursor';
  /** Text streamed since the last whole message, which repeats it. */
  private streamed = false;

  protected event(message: Record<string, unknown>): EventBody[] {
    if (message.type === 'assistant') return this.assistant(message);
    if (message.type === 'tool_call' && message.subtype === 'started') {
      return toolCall(message.tool_call);
    }
    return [];
  }

  private assistant(message: Record<string, unknown>): EventBody[] {
    const msg = isRecord(message.message) ? message.message : {};
    const content = Array.isArray(msg.content) ? msg.content : [];
    const text = content
      .filter(isRecord)
      .map((b) => (b.type === 'text' ? (str(b.text) ?? '') : ''))
      .join('');
    // With --stream-partial-output, pieces carry a timestamp; the whole message follows without.
    if (num(message.timestamp_ms) !== undefined) {
      this.streamed = true;
      return text ? [{ type: 'message.delta', text }] : [];
    }
    if (this.streamed) {
      this.streamed = false;
      return [];
    }
    return text ? [{ type: 'message.delta', text }] : [];
  }

  protected usage(result: Record<string, unknown>): Usage {
    const usage = isRecord(result.usage) ? result.usage : {};
    // Cursor reports OpenAI-style counts: inputTokens already includes the cache reads.
    return tokenUsage({
      input: num(usage.inputTokens),
      cached: num(usage.cacheReadTokens),
      output: num(usage.outputTokens),
    });
  }
}

function toolCall(call: unknown): EventBody[] {
  if (!isRecord(call)) return [];
  const [kind, body] = Object.entries(call)[0] ?? [];
  if (!kind || !isRecord(body)) return [];
  const args = isRecord(body.args) ? body.args : {};
  if (kind === 'shellToolCall') {
    return [{ type: 'tool.call', tool: 'shell', input: { command: str(args.command) } }];
  }
  const tool = kind.replace(/ToolCall$/, '');
  const out: EventBody[] = [{ type: 'tool.call', tool, input: args }];
  const path = str(args.path);
  if (EDIT_CALLS.has(kind) && path) out.push({ type: 'file.edit', path, kind: 'update' });
  return out;
}
