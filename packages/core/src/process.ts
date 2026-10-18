import { spawn as nodeSpawn } from 'node:child_process';
import spawn from 'cross-spawn';

export interface ProcessOptions {
  command: string;
  args: string[];
  cwd?: string;
  /** Written to stdin, then stdin is closed. Prompts go here so they never hit command-line limits or quoting. */
  stdin?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type ProcessChunk =
  | { kind: 'line'; line: string }
  | { kind: 'stderr'; text: string }
  | { kind: 'exit'; code: number | null; error?: string };

/**
 * Run a CLI and stream its stdout line by line. cross-spawn resolves npm
 * `.cmd` shims and escapes arguments correctly on Windows.
 * Always ends with exactly one `exit` chunk; never throws for process failures.
 */
export async function* streamProcess(opts: ProcessOptions): AsyncGenerator<ProcessChunk> {
  const queue: ProcessChunk[] = [];
  let wake: (() => void) | undefined;
  let finished = false;
  const push = (chunk: ProcessChunk) => {
    queue.push(chunk);
    wake?.();
  };

  const child = spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let spawnError: string | undefined;
  let killedReason: string | undefined;
  const kill = (reason: string) => {
    if (child.exitCode !== null || child.killed) return;
    killedReason = reason;
    child.kill();
  };
  const onAbort = () => kill('Cancelled');
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  if (opts.signal?.aborted) onAbort();
  const timer = opts.timeoutMs
    ? setTimeout(() => kill(`Timed out after ${opts.timeoutMs} ms`), opts.timeoutMs)
    : undefined;

  let buffered = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (data: string) => {
    buffered += data;
    let nl: number;
    while ((nl = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, nl).replace(/\r$/, '');
      buffered = buffered.slice(nl + 1);
      if (line.trim()) push({ kind: 'line', line });
    }
  });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (text: string) => push({ kind: 'stderr', text }));
  child.on('error', (err) => {
    spawnError = err.message;
  });
  child.on('close', (code) => {
    if (buffered.trim()) push({ kind: 'line', line: buffered.replace(/\r$/, '') });
    buffered = '';
    if (timer) clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
    const error = killedReason ?? spawnError;
    push({ kind: 'exit', code, ...(error !== undefined && { error }) });
    finished = true;
  });

  child.stdin?.on('error', () => {});
  child.stdin?.end(opts.stdin ?? '');

  try {
    while (true) {
      const next = queue.shift();
      if (next) {
        yield next;
        if (next.kind === 'exit') return;
        continue;
      }
      if (finished) return;
      await new Promise<void>((resolve) => (wake = resolve));
      wake = undefined;
    }
  } finally {
    kill('Stopped by caller');
  }
}

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

/** Run a short command to completion (version checks, auth status). */
export async function runCommand(
  command: string,
  args: string[],
  opts: Omit<ProcessOptions, 'command' | 'args'> = {},
): Promise<CommandResult> {
  const lines: string[] = [];
  let stderr = '';
  for await (const chunk of streamProcess({ timeoutMs: 20_000, ...opts, command, args })) {
    if (chunk.kind === 'line') lines.push(chunk.line);
    else if (chunk.kind === 'stderr') stderr += chunk.text;
    else
      return {
        code: chunk.code,
        stdout: lines.join('\n'),
        stderr,
        ...(chunk.error !== undefined && { error: chunk.error }),
      };
  }
  return { code: null, stdout: lines.join('\n'), stderr, error: 'No exit reported' };
}

/** True when the failure means the executable isn't on PATH. */
export function isNotFound(result: CommandResult): boolean {
  return /ENOENT|command not found|is not recognized as an internal or external command/i.test(
    `${result.error ?? ''} ${result.stderr}`,
  );
}

export interface ShellResult {
  code: number | null;
  /** The last part of stdout and stderr, interleaved as they arrived. */
  output: string;
  timedOut: boolean;
  durationMs: number;
}

/**
 * Run a user-provided shell command (a project's test command) in `cwd`.
 * On timeout or abort the whole process tree is killed.
 */
export function runShell(
  command: string,
  opts: { cwd: string; timeoutMs?: number; signal?: AbortSignal; maxOutput?: number },
): Promise<ShellResult> {
  const started = Date.now();
  const max = opts.maxOutput ?? 12_000;
  return new Promise((resolve) => {
    const child = nodeSpawn(command, {
      cwd: opts.cwd,
      shell: true,
      windowsHide: true,
      env: { ...process.env, CI: '1', FORCE_COLOR: '0' },
    });
    let output = '';
    let timedOut = false;
    const add = (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-max);
    };
    child.stdout?.on('data', add);
    child.stderr?.on('data', add);
    const killTree = () => {
      if (child.exitCode !== null || child.pid === undefined) return;
      if (process.platform === 'win32') {
        nodeSpawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      } else {
        child.kill('SIGKILL');
      }
    };
    const timer = setTimeout(
      () => {
        timedOut = true;
        killTree();
      },
      opts.timeoutMs ?? 15 * 60_000,
    );
    const onAbort = () => killTree();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (err) => add(Buffer.from(`\n${err.message}\n`)));
    child.on('close', (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ code, output, timedOut, durationMs: Date.now() - started });
    });
  });
}
