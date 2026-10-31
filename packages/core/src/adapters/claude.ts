import { dirname } from 'node:path';
import {
  markOlder,
  type ModelOption,
  type ProviderStatus,
  type Role,
  type Usage,
} from '@conclave/shared';
import { safeCommands, type RunPermissions } from './permissions.js';
import { runCommand } from '../process.js';
import {
  assertSafeEffort,
  assertSafeModel,
  assertSafeSession,
  ClaudeStreamParser,
  defaultExec,
  detectVersion,
  isRecord,
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

const INITIALIZE = {
  type: 'control_request',
  request_id: 'conclave-models',
  request: { subtype: 'initialize' },
};

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const READ_ONLY_TOOLS = 'Read,Grep,Glob';

/**
 * Drives the official Claude Code CLI in headless mode:
 * `claude -p --output-format stream-json`, prompt on stdin.
 * Format recorded from Claude Code 2.1.x (see test/fixtures/claude).
 */
export class ClaudeAdapter implements Adapter {
  permissionGap = claudePermissionGap;
  readonly id = 'claude' as const;
  readonly displayName = 'Claude Code';
  readonly capabilities: Capabilities = {
    models: ['fable', 'opus', 'sonnet', 'haiku'],
    defaultModel: 'sonnet',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    readOnly: true,
    resume: true,
    streaming: true,
    quietMs: QUIET_MS,
    // Its Read tool opens image files.
    vision: 'files',
  };
  private readonly command: string;
  private readonly exec: Exec;

  constructor(opts: CliAdapterOptions = {}) {
    this.command = opts.command ?? 'claude';
    this.exec = opts.exec ?? defaultExec;
  }

  async detect(): Promise<ProviderStatus> {
    const found = await detectVersion('claude', this.command, {
      missing: 'Claude Code CLI not found on PATH',
    });
    if (!found.installed) return found.status;
    const status: ProviderStatus = {
      provider: 'claude',
      installed: true,
      version: found.version,
      auth: 'unknown',
    };
    const auth = await runCommand(this.command, ['auth', 'status']);
    try {
      // Only the fields we need are read; account identifiers are never kept.
      const parsed: unknown = JSON.parse(auth.stdout);
      if (isRecord(parsed)) {
        status.auth = parsed.loggedIn === true ? 'signed_in' : 'signed_out';
        const plan = str(parsed.subscriptionType);
        const method = str(parsed.authMethod);
        if (plan || method)
          status.detail = [method, plan && `${plan} plan`].filter(Boolean).join(', ');
      }
    } catch {
      status.detail = 'Could not read sign-in status';
    }
    return status;
  }

  login(): LoginCommand {
    return {
      command: this.command,
      args: ['auth', 'login'],
      hint: 'Your browser opens the Claude sign-in page. Sign in there, then come back.',
    };
  }

  /**
   * Every model the signed-in account can use, from the CLI's own start-up handshake
   * (stream-json `initialize`): no prompt is sent, so it costs no usage.
   */
  async models(): Promise<ModelList> {
    const result = await runCommand(
      this.command,
      [
        '-p',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose',
        '--strict-mcp-config',
      ],
      {
        stdin: `${JSON.stringify(INITIALIZE)}\n`,
        timeoutMs: 30_000,
      },
    );
    for (const line of result.stdout.split(/\r?\n/)) {
      if (!line.includes('control_response')) continue;
      try {
        const message: unknown = JSON.parse(line);
        if (!isRecord(message) || !isRecord(message.response)) continue;
        const listed = parseClaudeModels(message.response.response);
        if (listed.models.length) return listed;
      } catch {
        // not the handshake line
      }
    }
    return { models: [] };
  }

  run(request: RunRequest) {
    return runCli(
      'claude',
      this.exec,
      {
        command: this.command,
        args: claudeArgs(request),
        cwd: request.cwd,
        stdin: request.prompt,
        ...(request.signal && { signal: request.signal }),
        ...(request.timeoutMs && { timeoutMs: request.timeoutMs }),
      },
      new ClaudeParser(),
    );
  }
}

/**
 * The `models` of Claude Code's initialize response: aliases (opus, sonnet) and pinned ids, each
 * with its effort levels. "Default" names the model the CLI picks on its own.
 */
/** Claude Code's aliases, weakest to strongest. */
const CLAUDE_TIERS = ['haiku', 'sonnet', 'opus', 'fable'];

export function parseClaudeModels(response: unknown): ModelList {
  if (!isRecord(response) || !Array.isArray(response.models)) return { models: [] };
  const resolved: Record<string, string> = {};
  let defaultResolved: string | undefined;
  const models: ModelOption[] = [];
  for (const m of response.models) {
    if (!isRecord(m)) continue;
    const id = str(m.value);
    if (!id || !/^[\w.:/[\]-]+$/.test(id)) continue;
    const target = str(m.resolvedModel);
    if (id === 'default') {
      defaultResolved = target;
      continue;
    }
    if (target) resolved[id] = target;
    const efforts = Array.isArray(m.supportedEffortLevels)
      ? m.supportedEffortLevels.flatMap((e) => (typeof e === 'string' ? [e] : []))
      : [];
    const label = str(m.displayName);
    const description = str(m.description);
    const tier = CLAUDE_TIERS.indexOf(id) + 1;
    models.push({
      id,
      ...(label && { label }),
      ...(description && { description }),
      ...(efforts.length && { efforts }),
      maker: 'Claude',
      ...(tier > 0 && { tier }),
    });
  }
  // The alias that stands for the default, so "Default" is marked on its model.
  const defaultModel = models.find(
    (m) => defaultResolved && resolved[m.id] === defaultResolved,
  )?.id;
  return { models: markOlder(models, resolved), ...(defaultModel && { defaultModel }) };
}

export function claudeArgs(request: RunRequest): string[] {
  assertSafeModel(request.model);
  assertSafeEffort(request.effort);
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    // Skip the user's MCP servers: they add a lot of context to every prompt.
    '--strict-mcp-config',
    // Headless: anything that would need a permission prompt is denied, never left hanging.
    '--permission-prompts',
    'none',
  ];
  if (request.model) args.push('--model', request.model);
  if (request.effort) args.push('--effort', request.effort);
  assertSafeSession(request.sessionId);
  if (request.sessionId) args.push('--resume', request.sessionId);
  args.push(...toolArgs(request.role ?? 'chat', request.readOnly ?? true, request.permissions));
  // Screenshots live outside the worktree: let it read their folders.
  for (const dir of new Set((request.images ?? []).map((p) => dirname(safeImage(p))))) {
    args.push('--add-dir', dir);
  }
  return args;
}

const NETWORK_TOOLS = ['WebFetch', 'WebSearch'];
const SHELL_TOOLS = ['Bash', 'PowerShell'];

function toolArgs(role: Role, readOnly: boolean, permissions?: RunPermissions): string[] {
  // Pure conversation needs no tools, which also keeps each prompt cheap.
  if (role === 'chat' || role === 'synthesizer') return ['--tools', ''];
  const level = permissions?.level ?? 2;
  if (readOnly || level === 1) {
    return ['--tools', READ_ONLY_TOOLS, '--permission-mode', 'dontAsk'];
  }
  if (level === 5) return ['--permission-mode', 'bypassPermissions'];
  const network = permissions?.network ?? false;
  const denied = network ? [] : [...NETWORK_TOOLS];
  const allowed: string[] = [];
  // Claude Code runs commands with Bash, or with PowerShell on Windows: rules cover both.
  if (level === 2) denied.push(...SHELL_TOOLS);
  if (level === 3) {
    for (const c of safeCommands(permissions?.commands)) {
      allowed.push(...SHELL_TOOLS.map((tool) => `${tool}(${c})`));
    }
  }
  if (level === 4) allowed.push(...SHELL_TOOLS);
  return [
    '--permission-mode',
    'acceptEdits',
    ...(allowed.length ? ['--allowedTools', allowed.join(',')] : []),
    ...(denied.length ? ['--disallowedTools', denied.join(',')] : []),
  ];
}

/** Claude's Bash tool has no network sandbox on every platform, so "offline commands" can't be promised. */
export function claudePermissionGap(permissions: RunPermissions): string | undefined {
  if (permissions.level === 4 && !permissions.network) {
    return "Claude Code can't block the network for the commands it runs, so it can't work at level 4 offline. Allow network for level 4, or use level 3 or 5.";
  }
  return undefined;
}

export class ClaudeParser extends ClaudeStreamParser {
  protected readonly cliName = 'Claude Code';
  private readonly streamedMessages = new Set<string>();

  protected event(message: Record<string, unknown>): EventBody[] {
    switch (message.type) {
      case 'stream_event': {
        const event = message.event;
        if (!isRecord(event) || event.type !== 'content_block_delta' || !isRecord(event.delta))
          return [];
        const text = event.delta.type === 'text_delta' ? str(event.delta.text) : undefined;
        if (!text) return [];
        const id = str(message.api_message_id);
        if (id) this.streamedMessages.add(id);
        return [{ type: 'message.delta', text }];
      }

      case 'assistant':
        return this.assistant(message.message);

      case 'rate_limit_event':
        return rateLimit(message.rate_limit_info);

      default:
        return [];
    }
  }

  private assistant(msg: unknown): EventBody[] {
    if (!isRecord(msg) || !Array.isArray(msg.content)) return [];
    const out: EventBody[] = [];
    const streamed = str(msg.id) !== undefined && this.streamedMessages.has(str(msg.id)!);
    for (const block of msg.content) {
      if (!isRecord(block)) continue;
      if (block.type === 'text' && !streamed && str(block.text)) {
        out.push({ type: 'message.delta', text: str(block.text)! });
      } else if (block.type === 'tool_use' && str(block.name)) {
        const tool = str(block.name)!;
        // Commands show up as one "shell" tool, whichever shell Claude Code used.
        out.push({
          type: 'tool.call',
          tool: SHELL_TOOLS.includes(tool) ? 'shell' : tool,
          input: block.input,
        });
        const path = isRecord(block.input)
          ? (str(block.input.file_path) ?? str(block.input.notebook_path))
          : undefined;
        if (FILE_TOOLS.has(tool) && path) {
          out.push({ type: 'file.edit', path, kind: tool === 'Write' ? 'add' : 'update' });
        }
      }
    }
    return out;
  }

  protected usage(result: Record<string, unknown>): Usage {
    const usage = isRecord(result.usage) ? result.usage : {};
    // Claude counts cache writes and reads apart from input_tokens; Conclave's inputTokens is all of them.
    const cached = num(usage.cache_read_input_tokens);
    return tokenUsage({
      input:
        (num(usage.input_tokens) ?? 0) +
        (num(usage.cache_creation_input_tokens) ?? 0) +
        (cached ?? 0),
      cached,
      output: num(usage.output_tokens),
      costUsd: num(result.total_cost_usd),
    });
  }
}

function rateLimit(info: unknown): EventBody[] {
  if (!isRecord(info)) return [];
  const out: EventBody[] = [];
  const windows = isRecord(info.unifiedWindows) ? info.unifiedWindows : {};
  for (const [window, value] of Object.entries(windows)) {
    if (!isRecord(value)) continue;
    const utilization = num(value.utilization);
    const resetsAt = num(value.resetsAt);
    out.push({
      type: 'quota',
      window,
      ...(utilization !== undefined && { utilization }),
      ...(resetsAt !== undefined && { resetsAt: resetsAt * 1000 }),
    });
  }
  const status = str(info.status);
  if (status && status !== 'allowed' && status !== 'allowed_warning') {
    const resetsAt = num(info.resetsAt);
    out.push({
      type: 'rate_limit',
      message: `Claude usage limit reached (${str(info.rateLimitType) ?? 'unknown window'})`,
      ...(resetsAt !== undefined && { resetsAt: resetsAt * 1000 }),
    });
  }
  return out;
}
