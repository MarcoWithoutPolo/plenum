import type { ProviderStatus, Role } from '@conclave/shared';
import { runCommand, isNotFound } from '../process.js';
import {
  assertSafeModel,
  defaultExec,
  isRecord,
  num,
  runCli,
  str,
  type CliAdapterOptions,
  type EventBody,
  type Exec,
  type LineParser,
} from './cli.js';
import type { Adapter, Capabilities, LoginCommand, RunRequest } from './types.js';

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const READ_ONLY_TOOLS = 'Read,Grep,Glob';

/**
 * Drives the official Claude Code CLI in headless mode:
 * `claude -p --output-format stream-json`, prompt on stdin.
 * Format recorded from Claude Code 2.1.x (see test/fixtures/claude).
 */
export class ClaudeAdapter implements Adapter {
  readonly id = 'claude' as const;
  readonly displayName = 'Claude Code';
  readonly capabilities: Capabilities = {
    models: ['fable', 'opus', 'sonnet', 'haiku'],
    defaultModel: 'sonnet',
    readOnly: true,
    resume: true,
    streaming: true,
  };
  private readonly command: string;
  private readonly exec: Exec;

  constructor(opts: CliAdapterOptions = {}) {
    this.command = opts.command ?? 'claude';
    this.exec = opts.exec ?? defaultExec;
  }

  async detect(): Promise<ProviderStatus> {
    const version = await runCommand(this.command, ['--version']);
    if (version.code !== 0) {
      return {
        provider: 'claude',
        installed: false,
        auth: 'unknown',
        detail: isNotFound(version) ? 'Claude Code CLI not found on PATH' : version.stderr.trim(),
      };
    }
    const status: ProviderStatus = {
      provider: 'claude',
      installed: true,
      version: version.stdout.trim().split(/\s+/)[0] ?? version.stdout.trim(),
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

export function claudeArgs(request: RunRequest): string[] {
  assertSafeModel(request.model);
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
  if (request.sessionId) {
    if (!/^[\w-]+$/.test(request.sessionId)) throw new Error('Invalid session id');
    args.push('--resume', request.sessionId);
  }
  args.push(...toolArgs(request.role ?? 'chat', request.readOnly ?? true));
  return args;
}

function toolArgs(role: Role, readOnly: boolean): string[] {
  // Pure conversation needs no tools, which also keeps each prompt cheap.
  if (role === 'chat' || role === 'synthesizer') return ['--tools', ''];
  if (readOnly) return ['--tools', READ_ONLY_TOOLS, '--permission-mode', 'dontAsk'];
  return ['--permission-mode', 'acceptEdits'];
}

export class ClaudeParser implements LineParser {
  failed = false;
  private readonly streamedMessages = new Set<string>();

  parse(message: unknown): EventBody[] {
    if (!isRecord(message)) return [];
    // Ignore subagent traffic; only the main conversation is the answer.
    if (message.parent_tool_use_id) return [];

    switch (message.type) {
      case 'system':
        if (message.subtype === 'init' && str(message.session_id)) {
          const model = str(message.model);
          return [
            { type: 'session', sessionId: str(message.session_id)!, ...(model && { model }) },
          ];
        }
        return [];

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

      case 'result':
        return this.result(message);

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
        out.push({ type: 'tool.call', tool, input: block.input });
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

  private result(message: Record<string, unknown>): EventBody[] {
    const out: EventBody[] = [];
    const usage = isRecord(message.usage) ? message.usage : {};
    // Same convention as OpenAI: inputTokens counts every input token, cachedInputTokens the cache reads among them.
    const cached = num(usage.cache_read_input_tokens);
    const input =
      (num(usage.input_tokens) ?? 0) +
      (num(usage.cache_creation_input_tokens) ?? 0) +
      (cached ?? 0);
    const output = num(usage.output_tokens);
    const cost = num(message.total_cost_usd);
    out.push({
      type: 'usage',
      usage: {
        inputTokens: input,
        ...(cached !== undefined && { cachedInputTokens: cached }),
        ...(output !== undefined && { outputTokens: output }),
        ...(cost !== undefined && { costUsd: cost }),
      },
    });
    const text = str(message.result) ?? '';
    if (
      message.is_error === true ||
      (message.subtype !== undefined && message.subtype !== 'success')
    ) {
      this.failed = true;
      out.push({
        type: 'error',
        message: text || `Claude Code stopped: ${String(message.subtype)}`,
      });
    } else {
      out.push({ type: 'message.done', text });
    }
    return out;
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
