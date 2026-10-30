import type { ProviderStatus } from '@conclave/shared';
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
} from './kit/index.js';
import type { Adapter, Capabilities, LoginCommand, RunRequest } from './types.js';

/**
 * Drives the official Gemini CLI in headless mode: `gemini -o stream-json`.
 *
 * Unverified: Google stopped accepting "Gemini Code Assist for individuals"
 * sign-ins from this CLI, so no output has been recorded yet. It works with a
 * GEMINI_API_KEY the user sets in their own environment; the parser follows
 * the CLI's documented stream-json events and must be checked against a real
 * recording before it is relied on.
 */
export class GeminiAdapter implements Adapter {
  readonly id = 'gemini' as const;
  readonly displayName = 'Gemini';
  readonly capabilities: Capabilities = {
    models: [],
    readOnly: true,
    resume: false,
    streaming: true,
  };
  private readonly command: string;
  private readonly exec: Exec;

  constructor(opts: CliAdapterOptions = {}) {
    this.command = opts.command ?? 'gemini';
    this.exec = opts.exec ?? defaultExec;
  }

  async detect(): Promise<ProviderStatus> {
    const version = await runCommand(this.command, ['--version']);
    if (version.code !== 0) {
      return {
        provider: 'gemini',
        installed: false,
        auth: 'unknown',
        detail: isNotFound(version) ? 'Gemini CLI not found on PATH' : version.stderr.trim(),
      };
    }
    const hasKey = Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
    return {
      provider: 'gemini',
      installed: true,
      version: version.stdout.trim(),
      auth: hasKey ? 'signed_in' : 'unknown',
      detail: hasKey
        ? 'Using your API key from the environment'
        : 'Google sign-in for individuals no longer works with this CLI; set GEMINI_API_KEY to use it',
    };
  }

  login(): LoginCommand {
    return {
      command: this.command,
      args: [],
      hint: 'Choose a sign-in method in the Gemini CLI, or set GEMINI_API_KEY in your environment.',
    };
  }

  run(request: RunRequest) {
    assertSafeModel(request.model);
    const args = [
      '-o',
      'stream-json',
      '--approval-mode',
      (request.readOnly ?? true) ? 'plan' : 'auto_edit',
    ];
    if (request.model) args.push('-m', request.model);
    // -p switches to headless mode and is appended to stdin, where the real prompt goes.
    args.push('-p', ' ');
    return runCli(
      'gemini',
      this.exec,
      {
        command: this.command,
        args,
        cwd: request.cwd,
        stdin: request.prompt,
        ...(request.signal && { signal: request.signal }),
        ...(request.timeoutMs && { timeoutMs: request.timeoutMs }),
      },
      new GeminiParser(),
    );
  }
}

export class GeminiParser implements LineParser {
  failed = false;
  private text = '';

  parse(message: unknown): EventBody[] {
    if (!isRecord(message)) return [];
    switch (message.type) {
      case 'init': {
        const id = str(message.session_id);
        const model = str(message.model);
        return id ? [{ type: 'session', sessionId: id, ...(model && { model }) }] : [];
      }
      case 'message': {
        const content = str(message.content);
        if (message.role !== 'assistant' || !content) return [];
        this.text += content;
        return [{ type: 'message.delta', text: content }];
      }
      case 'tool_use':
        return [
          { type: 'tool.call', tool: str(message.tool_name) ?? 'tool', input: message.parameters },
        ];
      case 'error':
        this.failed = true;
        return [{ type: 'error', message: str(message.message) ?? 'Gemini failed' }];
      case 'result': {
        const stats = isRecord(message.stats) ? message.stats : {};
        const input = num(stats.input_tokens);
        const output = num(stats.output_tokens);
        const out: EventBody[] = [
          {
            type: 'usage',
            usage: {
              ...(input !== undefined && { inputTokens: input }),
              ...(output !== undefined && { outputTokens: output }),
            },
          },
        ];
        if (message.status === 'success') out.unshift({ type: 'message.done', text: this.text });
        else {
          this.failed = true;
          out.push({ type: 'error', message: str(message.error) ?? 'Gemini run failed' });
        }
        return out;
      }
      default:
        return [];
    }
  }
}
