import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import type { AgentEvent, ProviderStatus, Role } from '@conclave/shared';
import { isNotFound, runCommand } from '../process.js';
import type { RunPermissions } from './permissions.js';
import {
  assertSafeEffort,
  assertSafeModel,
  defaultExec,
  isRecord,
  looksLikeLimit,
  num,
  runCli,
  str,
  type CliAdapterOptions,
  type EventBody,
  type Exec,
  type LineParser,
} from './cli.js';
import type { Adapter, Capabilities, LoginCommand, ModelList, RunRequest } from './types.js';

/**
 * Prompts go on the command line: agy has no stdin prompt in print mode, and
 * agy.exe is a native program, so Windows allows about 32k characters.
 * Longer prompts are written to a temp file the agent is told to read.
 */
const MAX_ARG_PROMPT = 24_000;

/** File tools whose `Path` parameter is the file being written. */
const FILE_TOOLS = new Set([
  'write_file',
  'write_to_file',
  'replace_file_content',
  'multi_replace_file_content',
  'sed_file',
  'notebook_edit',
]);

/**
 * Drives Google's Antigravity CLI (`agy`), which replaced the Gemini CLI for
 * Google subscribers in June 2026. Format recorded from agy 1.4.6
 * (see test/fixtures/antigravity).
 */
export class AntigravityAdapter implements Adapter {
  permissionGap = antigravityPermissionGap;
  readonly id = 'antigravity' as const;
  readonly displayName = 'Antigravity';
  readonly capabilities: Capabilities = {
    models: [],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    readOnly: true,
    resume: true,
    streaming: true,
    // Headless agy has no image option, but it reads image files with its own tools (shown
    // live, test/live-vision.test.ts): screenshots are named in the prompt, their folders added.
    vision: 'files',
  };
  private readonly exec: Exec;
  private readonly explicitCommand: string | undefined;

  constructor(opts: CliAdapterOptions = {}) {
    this.exec = opts.exec ?? defaultExec;
    this.explicitCommand = opts.command;
  }

  /** `agy` on PATH, or where its installer puts it (PATH only updates in new terminals). */
  private get command(): string {
    if (this.explicitCommand) return this.explicitCommand;
    const candidates =
      process.platform === 'win32'
        ? [
            join(
              process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'),
              'agy',
              'bin',
              'agy.exe',
            ),
          ]
        : [join(homedir(), '.local', 'bin', 'agy'), '/usr/local/bin/agy'];
    return candidates.find((c) => existsSync(c)) ?? 'agy';
  }

  async detect(): Promise<ProviderStatus> {
    const version = await runCommand(this.command, ['--version']);
    if (version.code !== 0) {
      return {
        provider: 'antigravity',
        installed: false,
        auth: 'unknown',
        detail: isNotFound(version)
          ? 'Antigravity CLI (agy) not found'
          : version.stderr.trim().split('\n')[0],
      };
    }
    const status: ProviderStatus = {
      provider: 'antigravity',
      installed: true,
      version: version.stdout.trim().split(/\s+/).at(-1) ?? version.stdout.trim(),
      auth: 'unknown',
    };
    // Listing models needs a signed-in account (or an API key), and costs no usage.
    const models = await runCommand(this.command, ['models'], { timeoutMs: 30_000 });
    const listed = parseModels(models.stdout);
    if (models.code === 0 && listed.length) {
      status.auth = 'signed_in';
      status.detail = `Google account · ${listed.length} models`;
    } else {
      status.auth = 'signed_out';
      status.detail = (models.stderr || models.stdout).trim().split('\n').at(-1) || 'Not signed in';
    }
    return status;
  }

  login(): LoginCommand {
    return {
      command: this.command,
      args: [],
      hint: 'Antigravity opens your browser to sign in with your Google account. Close the terminal when it shows the prompt.',
    };
  }

  async models(): Promise<ModelList> {
    const result = await runCommand(this.command, ['models'], { timeoutMs: 30_000 });
    return { models: parseModels(result.stdout) };
  }

  async *run(request: RunRequest): AsyncGenerator<AgentEvent> {
    const { args, cleanup } = antigravityArgs(request);
    try {
      yield* runCli(
        'antigravity',
        this.exec,
        {
          command: this.command,
          args,
          cwd: request.cwd,
          ...(request.signal && { signal: request.signal }),
          ...(request.timeoutMs && { timeoutMs: request.timeoutMs }),
        },
        new AntigravityParser(),
      );
    } finally {
      cleanup();
    }
  }
}

export function parseModels(text: string): { id: string; label?: string }[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.split('\t'))
    .filter((parts) => parts.length >= 2 && /^[\w.:-]+$/.test(parts[0]!.trim()))
    .map(([id, label]) => ({ id: id!.trim(), label: label!.trim() }));
}

/** Execution mode per role: read-only roles plan, builders may edit, level 5 runs freely. */
function modeArgs(role: Role, readOnly: boolean, permissions?: RunPermissions): string[] {
  if (role === 'chat' || role === 'synthesizer' || role === 'planner' || role === 'reviewer')
    return ['--mode', 'plan'];
  const level = permissions?.level ?? 2;
  if (readOnly || level === 1) return ['--mode', 'plan'];
  if (level === 5) return ['--mode', 'auto', '--dangerously-skip-permissions'];
  // Print mode denies commands it would have to ask about, so edit-only is enforced.
  return ['--mode', 'accept-edits'];
}

/** agy can edit-only or run freely, with nothing in between that Conclave can verify. */
export function antigravityPermissionGap(permissions: RunPermissions): string | undefined {
  if (permissions.level === 3 || permissions.level === 4) {
    return "Antigravity can't limit which commands run or block the network, so it works at levels 2 and 5 only.";
  }
  if (permissions.network && permissions.level < 5) {
    return "Antigravity can't grant network access on its own; it has it only at level 5.";
  }
  return undefined;
}

/**
 * agy's print mode denies every shell command it can't ask about, and a denied command ends
 * the turn with an empty answer. Saying so up front keeps agents on their file tools
 * (verified on agy 1.4.6: builds edit files and reviews answer in JSON).
 */
export const NO_SHELL_NOTE =
  'IMPORTANT: This session has no shell. Running any command (git, npm, node, tests, anything) is denied and ends your turn with no answer. Use only your file tools to read, search and edit files. The system runs the tests itself.';

const NO_SHELL_REMINDER =
  'Reminder: do not run any command, not even the tests; the system runs them after you finish.';

export function antigravityArgs(request: RunRequest): { args: string[]; cleanup: () => void } {
  assertSafeModel(request.model);
  assertSafeEffort(request.effort);
  const fullAccess = !(request.readOnly ?? true) && request.permissions?.level === 5;
  const chat = request.role === 'chat' || request.role === 'synthesizer' || !request.role;
  let prompt = request.prompt;
  let cleanup = () => {};
  const extra: string[] = [];
  if (prompt.length > MAX_ARG_PROMPT) {
    const dir = mkdtempSync(join(tmpdir(), 'conclave-agy-'));
    const file = join(dir, 'instructions.md');
    writeFileSync(file, prompt);
    prompt = `Your full instructions are in the file ${file}. Read that whole file first, then follow it exactly. It is part of this request, not part of the project.`;
    extra.push('--add-dir', dir);
    cleanup = () => rmSync(dir, { recursive: true, force: true });
  }
  // Screenshots live outside the worktree: let it read their folders.
  for (const dir of new Set((request.images ?? []).map((p) => dirname(safeImage(p))))) {
    extra.push('--add-dir', dir);
  }
  if (!fullAccess && !chat) prompt = `${NO_SHELL_NOTE}\n\n${prompt}\n\n${NO_SHELL_REMINDER}`;
  // Slash-command expansion stays on (turning it off makes agy ignore --mode), so a prompt
  // must never start with "/".
  if (prompt.trimStart().startsWith('/')) prompt = `Request: ${prompt}`;
  if (request.sessionId && !/^[\w-]+$/.test(request.sessionId))
    throw new Error('Invalid session id');
  const args = [
    // agy reads the prompt as --print's value, so the two stay together.
    `--print=${prompt}`,
    '--output-format',
    'stream-json',
    ...modeArgs(request.role ?? 'chat', request.readOnly ?? true, request.permissions),
    ...(request.model ? ['--model', request.model] : []),
    ...(request.effort ? ['--effort', request.effort] : []),
    ...(request.sessionId ? ['--conversation', request.sessionId] : []),
    ...extra,
  ];
  return { args, cleanup };
}

function safeImage(path: string): string {
  if (!isAbsolute(path) || !/\.png$/i.test(path) || /[\r\n"]/.test(path)) {
    throw new Error(`Not a screenshot path: ${path}`);
  }
  return path;
}

export class AntigravityParser implements LineParser {
  failed = false;
  private readonly announced = new Set<number>();
  private text = '';
  /** The last command agy's headless permission check refused. */
  private denied: string | undefined;
  private edited = false;

  parse(message: unknown): EventBody[] {
    if (!isRecord(message)) return [];
    switch (message.event) {
      case 'init': {
        const id = str(message.conversation_id);
        return id ? [{ type: 'session', sessionId: id }] : [];
      }
      case 'step_update':
        return this.step(message.step_update);
      case 'result':
        return this.result(message.result);
      default:
        return [];
    }
  }

  private step(step: unknown): EventBody[] {
    if (!isRecord(step)) return [];
    const out: EventBody[] = [];
    if (step.step_type === 'agent_response') {
      const delta = str(step.text_delta);
      if (delta) {
        this.text += delta;
        out.push({ type: 'message.delta', text: delta });
      }
      return out;
    }
    if (step.step_type === 'tool') {
      const index = num(step.step_index);
      if (step.state === 'ERROR') {
        // Denials read "permission check failed for unsandboxed "<command>": user denied ...".
        const info = isRecord(step.tool_info) ? step.tool_info : {};
        const params = isRecord(info.parameters) ? info.parameters : {};
        const error = isRecord(info.error) ? (str(info.error.message) ?? '') : '';
        const quoted = /permission check failed for \w+ "([^"]+)"/.exec(error)?.[1];
        if (quoted || /denied/i.test(error) || step.tool_name === 'run_command') {
          this.denied = quoted ?? str(params.CommandLine) ?? this.denied;
        }
      }
      // Each tool step arrives twice (ACTIVE, then DONE or ERROR); report it once.
      if (index === undefined || this.announced.has(index)) return out;
      this.announced.add(index);
      const tool = str(step.tool_name) ?? 'tool';
      const info = isRecord(step.tool_info) ? step.tool_info : {};
      const params = isRecord(info.parameters) ? info.parameters : {};
      if (tool === 'run_command') {
        out.push({ type: 'tool.call', tool: 'shell', input: { command: str(params.CommandLine) } });
      } else {
        out.push({ type: 'tool.call', tool, input: params });
      }
      const path = str(params.Path) ?? str(params.TargetFile) ?? str(params.AbsolutePath);
      if (FILE_TOOLS.has(tool) && path) {
        this.edited = true;
        out.push({
          type: 'file.edit',
          path,
          kind: tool === 'write_file' || tool === 'write_to_file' ? 'add' : 'update',
        });
      }
    }
    return out;
  }

  private result(result: unknown): EventBody[] {
    if (!isRecord(result)) return [];
    const out: EventBody[] = [];
    const usage = isRecord(result.usage) ? result.usage : {};
    const input = num(usage.input_tokens);
    const cached = num(usage.cache_read_tokens);
    const output = (num(usage.output_tokens) ?? 0) + (num(usage.thinking_tokens) ?? 0);
    out.push({
      type: 'usage',
      usage: {
        ...(input !== undefined && { inputTokens: input + (cached ?? 0) }),
        ...(cached !== undefined && { cachedInputTokens: cached }),
        outputTokens: output,
      },
    });
    const answer = (str(result.response) ?? this.text).trim();
    const deniedActions = Array.isArray(result.denied_actions) ? result.denied_actions.length : 0;
    if (result.status === 'SUCCESS' && (answer || !deniedActions)) {
      out.push({ type: 'message.done', text: answer });
      return out;
    }
    if (result.status === 'SUCCESS' && this.edited) {
      // The edits are real; only the wrap-up was cut short. Tests and review judge the result.
      out.push({
        type: 'message.done',
        text: `Edited files, then stopped when ${this.denied ? `\`${this.denied}\`` : 'a command'} was denied.`,
      });
      return out;
    }
    this.failed = true;
    // "SUCCESS" with no answer after a denied command: agy gave up on the turn.
    const error =
      result.status === 'SUCCESS'
        ? `Antigravity stopped without an answer: it tried to run ${this.denied ? `\`${this.denied}\`` : 'a command'}, which headless mode denies.`
        : (str(result.error) ?? `Antigravity stopped: ${String(result.status)}`).split('\n')[0]!;
    out.push(
      looksLikeLimit(error)
        ? { type: 'rate_limit', message: error }
        : { type: 'error', message: error },
    );
    return out;
  }
}
