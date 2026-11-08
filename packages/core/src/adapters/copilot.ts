import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentEvent, ModelOption, ProviderStatus, Role } from '@plenum/shared';
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
  runCli,
  safeImage,
  str,
  TypedEventParser,
  type CliAdapterOptions,
  type EventBody,
  type Exec,
} from './kit/index.js';
import type { Adapter, Capabilities, LoginCommand, ModelList, RunRequest } from './types.js';
import { QUIET_MS } from './types.js';

const SHELL_TOOLS = new Set(['shell', 'bash', 'powershell']);

/**
 * Drives GitHub's Copilot CLI headless: prompt on stdin, `--output-format json` (one event per
 * line). Format recorded from Copilot CLI 1.0.105 on Copilot Free (see test/fixtures/copilot).
 * Permissions are its tool rules, checked live: level 2 applies patches while `shell` and URL
 * access are denied. It has no model list or status command: the models it may use arrive with
 * each run (`availableModels`), and sign-in shows once it has run here.
 */
export class CopilotAdapter implements Adapter {
  permissionGap = copilotPermissionGap;
  readonly id = 'copilot' as const;
  readonly displayName = 'GitHub Copilot';
  readonly capabilities: Capabilities = {
    models: ['auto'],
    defaultModel: 'auto',
    readOnly: true,
    resume: true,
    streaming: true,
    quietMs: QUIET_MS,
    // --attachment adds a picture to the prompt.
    vision: 'native',
  };
  private readonly exec: Exec;
  private readonly explicitCommand: string | undefined;
  private readonly home: string;

  constructor(opts: CliAdapterOptions & { home?: string } = {}) {
    this.exec = opts.exec ?? defaultExec;
    this.explicitCommand = opts.command;
    this.home = opts.home ?? process.env.COPILOT_HOME ?? join(homeDirs.home, '.copilot');
  }

  private get command(): string {
    return (
      this.explicitCommand ??
      locateCli('copilot', { windows: [join(homeDirs.appData, 'npm', 'copilot.cmd')] })
    );
  }

  async detect(): Promise<ProviderStatus> {
    const found = await detectVersion('copilot', this.command, {
      missing: 'GitHub Copilot CLI not found',
      // "GitHub Copilot CLI 1.0.105."
      version: (out) => /(\d+\.\d+\.\d+)/.exec(out)?.[1],
    });
    if (!found.installed) return found.status;
    // No status command, and its credentials are never read: a session folder means it has
    // run here signed in. Only the folder names are listed.
    let ran = false;
    try {
      ran = readdirSync(join(this.home, 'session-state')).length > 0;
    } catch {
      ran = false;
    }
    return {
      provider: 'copilot',
      installed: true,
      version: found.version,
      auth: ran ? 'signed_in' : 'unknown',
      detail: ran ? 'GitHub account' : 'Sign in with your GitHub account to use it',
    };
  }

  login(): LoginCommand {
    return {
      command: this.command,
      args: ['login'],
      hint: 'Copilot shows a code and opens GitHub. Enter the code there and approve.',
    };
  }

  /** "Auto", plus the models its runs said this plan may use. */
  async models(): Promise<ModelList> {
    const learned: ModelOption[] = [...CopilotParser.availableModels].map((id) => ({ id }));
    return {
      models: [
        {
          id: 'auto',
          label: 'Auto',
          description: 'Copilot picks the best model your plan allows',
        },
        ...learned,
      ],
      defaultModel: 'auto',
    };
  }

  run(request: RunRequest): AsyncIterable<AgentEvent> {
    return runCli(
      'copilot',
      this.exec,
      {
        command: this.command,
        args: copilotArgs(request),
        cwd: request.cwd,
        stdin: request.prompt,
        ...(request.signal && { signal: request.signal }),
        ...(request.timeoutMs && { timeoutMs: request.timeoutMs }),
      },
      new CopilotParser(),
    );
  }
}

export function copilotArgs(request: RunRequest): string[] {
  assertSafeModel(request.model);
  assertSafeEffort(request.effort);
  assertSafeSession(request.sessionId);
  const args = [
    '--output-format',
    'json',
    '--no-ask-user',
    '--no-auto-update',
    '--no-color',
    ...permissionArgs(request.role ?? 'chat', request.readOnly ?? true, request.permissions),
  ];
  if (request.model && request.model !== 'auto') args.push('--model', request.model);
  if (request.effort) args.push('--reasoning-effort', request.effort);
  if (request.sessionId) args.push('--resume', request.sessionId);
  for (const img of request.images ?? []) args.push('--attachment', safeImage(img));
  return args;
}

function permissionArgs(role: Role, readOnly: boolean, permissions?: RunPermissions): string[] {
  const level = permissions?.level ?? 2;
  const writing = !readOnly && role !== 'chat' && role !== 'synthesizer' && level > 1;
  // Never --yolo or --autopilot. Level 5 allows every tool and URL, inside the worktree.
  if (writing && level === 5) return ['--allow-all-tools', '--allow-all-urls'];
  // Its built-in GitHub tools reach the network, so they stay off below level 5.
  const offline = ['--deny-tool=shell', '--deny-tool=url', '--disable-builtin-mcps'];
  return writing ? ['--allow-tool=write', ...offline] : ['--deny-tool=write', ...offline];
}

/** Command allow-lists aren't verified yet, so levels 3 and 4 wait. */
export function copilotPermissionGap(permissions: RunPermissions): string | undefined {
  if (permissions.level === 3 || permissions.level === 4) {
    return 'Copilot works at levels 1, 2 and 5 in Plenum for now; command allow-lists for levels 3 and 4 are not verified yet.';
  }
  if (permissions.network && permissions.level < 5) {
    return 'Copilot reaches the network only at level 5 in Plenum.';
  }
  return undefined;
}

export class CopilotParser extends TypedEventParser {
  /** Models runs reported as available on this plan, for models(). */
  static readonly availableModels = new Set<string>();
  private readonly streamed = new Set<string>();

  protected on(type: string, message: Record<string, unknown>): EventBody[] {
    const data = isRecord(message.data) ? message.data : {};
    switch (type) {
      case 'session.auto_mode_resolved': {
        const available = Array.isArray(data.availableModels) ? data.availableModels : [];
        for (const id of available) {
          if (typeof id === 'string' && /^[\w.:-]+$/.test(id))
            CopilotParser.availableModels.add(id);
        }
        return [];
      }
      case 'assistant.message_delta': {
        const id = str(data.messageId);
        if (id) this.streamed.add(id);
        return this.delta(str(data.deltaContent));
      }
      case 'assistant.message': {
        const id = str(data.messageId);
        if (id && this.streamed.has(id)) return [];
        const text = str(data.content);
        return text ? this.delta(this.answer ? `\n\n${text}` : text) : [];
      }
      case 'tool.execution_start':
        return toolStart(data);
      case 'tool.execution_complete':
        return fileEdits(data);
      case 'result':
        return this.result(message);
      default:
        if (type.endsWith('error')) {
          return this.fail(str(data.message) ?? str(message.message) ?? 'Copilot failed');
        }
        return [];
    }
  }

  private result(message: Record<string, unknown>): EventBody[] {
    const out: EventBody[] = [];
    const sessionId = str(message.sessionId);
    if (sessionId) out.push({ type: 'session', sessionId });
    if (message.exitCode !== undefined && message.exitCode !== 0) {
      this.failed = true;
      return out;
    }
    out.push(this.done());
    return out;
  }
}

function toolStart(data: Record<string, unknown>): EventBody[] {
  const tool = str(data.toolName) ?? 'tool';
  const args = data.arguments;
  if (SHELL_TOOLS.has(tool)) {
    const command = isRecord(args) ? str(args.command) : undefined;
    return [{ type: 'tool.call', tool: 'shell', input: { command } }];
  }
  return [{ type: 'tool.call', tool, input: args }];
}

function fileEdits(data: Record<string, unknown>): EventBody[] {
  if (data.success !== true || !Array.isArray(data.fileEdits)) return [];
  return data.fileEdits.filter(isRecord).flatMap((e): EventBody[] => {
    const path = str(e.path);
    if (!path) return [];
    const kind = e.kind === 'create' ? 'add' : e.kind === 'delete' ? 'delete' : 'update';
    return [{ type: 'file.edit', path, kind }];
  });
}
