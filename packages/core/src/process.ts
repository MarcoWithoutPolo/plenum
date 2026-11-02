import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';
import spawn from 'cross-spawn';

export interface ProcessOptions {
  command: string;
  args: string[];
  cwd?: string;
  /** Written to stdin, then stdin is closed. Prompts go here so they never hit command-line limits or quoting. */
  stdin?: string;
  /** Keep empty lines (a diff's blank context lines); CLIs' JSON streams skip them. */
  keepBlank?: boolean;
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
    // Its own process group on macOS and Linux, so a stop takes what the CLI started (E6).
    detached: process.platform !== 'win32',
  });

  let spawnError: string | undefined;
  let killedReason: string | undefined;
  const kill = (reason: string) => {
    // Already over: nothing to stop (and no process table to read).
    if (killedReason || child.exitCode !== null || child.signalCode !== null) return;
    killedReason = reason;
    // The child is often an npm shim or a shell: killing it alone leaves the CLI and what it
    // started running (and holding the worktree). Take the whole tree down, everywhere (E6).
    void killTree(child);
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
      if (opts.keepBlank || line.trim()) push({ kind: 'line', line });
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
  // Everything a command prints, blank lines included (git diffs need them, E13).
  for await (const chunk of streamProcess({
    timeoutMs: 20_000,
    keepBlank: true,
    ...opts,
    command,
    args,
  })) {
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

/**
 * Kill a process and everything it started, and wait until they're gone: the whole process group
 * on macOS and Linux (start the child `detached`); on Windows taskkill /T, then a sweep for
 * anything the tree started that outlived its parent (E6).
 */
export async function killTree(child: ChildProcess, timeoutMs = 8000): Promise<void> {
  if (child.pid === undefined) return;
  const exited =
    child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise<void>((r) => child.once('exit', () => r()));
  if (process.platform === 'win32') {
    await killWindowsTree(child.pid, timeoutMs);
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }
  await Promise.race([exited, new Promise((r) => setTimeout(r, timeoutMs).unref())]);
}

/** Run a short Windows command, never waiting past `ms`; resolves with its output. */
function quick(
  command: string,
  args: string[],
  ms: number,
): Promise<{ out: string; code: number | null }> {
  return new Promise((done) => {
    const p = nodeSpawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    p.stdout?.on('data', (d: Buffer) => (out += d.toString('utf8')));
    const timer = setTimeout(() => {
      p.kill();
      done({ out, code: null });
    }, ms).unref();
    p.once('exit', (code) => {
      clearTimeout(timer);
      done({ out, code });
    });
    p.once('error', () => {
      clearTimeout(timer);
      done({ out, code: null });
    });
  });
}

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Kill a process tree on Windows. taskkill /T can stall on a tree that is still starting (npm
 * launching under a shell) and only finds children whose parent is alive, so the rest lived on
 * as orphans, holding the app's output pipes open (E6). Instead: read the process table, end the
 * root and every process descended from it (TerminateProcess, which never waits), and repeat a
 * few times for children that were still being started.
 */
async function killWindowsTree(root: number, timeoutMs: number): Promise<void> {
  // The usual case: the tree is whole, and one taskkill /T ends it. Reading the process table
  // costs a second of CPU, so only when the root is already gone (its children may live on) or
  // taskkill failed or stalled.
  if (isAlive(root)) {
    const { code } = await quick('taskkill', ['/pid', String(root), '/T', '/F'], 3_000);
    if (code === 0) return;
  }
  const known = new Set([root]);
  const end = (pid: number) => {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  };
  end(root);
  for (let round = 0; round < 3; round++) {
    const { out: table } = await quick(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }',
      ],
      timeoutMs,
    );
    const rows = table
      .split(/\r?\n/)
      .map((l) => l.trim().split(' ').map(Number))
      .filter((r) => r.length === 2 && r.every(Number.isFinite)) as [number, number][];
    const found: number[] = [];
    for (let grew = true; grew;) {
      grew = false;
      for (const [pid, parent] of rows) {
        if (known.has(parent) && !known.has(pid) && pid !== process.pid) {
          known.add(pid);
          found.push(pid);
          grew = true;
        }
      }
    }
    // Nothing descended from it: done (one look at the process table, no more).
    if (found.length === 0) return;
    found.forEach(end);
    await new Promise((r) => setTimeout(r, 200).unref());
  }
}

/** Remove a folder a just-stopped process may still be letting go of; never throws. */
export async function removeDir(path: string, attempts = 10): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
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
      // Its own process group on macOS and Linux, so a stop takes everything it started (E6).
      detached: process.platform !== 'win32',
      env: { ...process.env, CI: '1', FORCE_COLOR: '0' },
    });
    let output = '';
    let timedOut = false;
    const add = (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-max);
    };
    child.stdout?.on('data', add);
    child.stderr?.on('data', add);
    let done = false;
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ code, output, timedOut, durationMs: Date.now() - started });
    };
    // Stopped (a timeout, Stop, a skip): the whole tree goes, even what outlived the shell, and
    // the result comes back within seconds even if something still holds the output open (E6).
    const stop = () => {
      void killTree(child);
      setTimeout(() => finish(child.exitCode), 5_000).unref();
    };
    const timer = setTimeout(
      () => {
        timedOut = true;
        stop();
      },
      opts.timeoutMs ?? 15 * 60_000,
    );
    const onAbort = () => stop();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (err) => add(Buffer.from(`\n${err.message}\n`)));
    // Normally 'close' (all output read); after 'exit', give the pipes a moment, no more.
    child.on('exit', (code) => setTimeout(() => finish(code), 5_000).unref());
    child.on('close', (code) => finish(code));
  });
}
