import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runCommand, runShell, streamProcess } from '../src/process.js';
import { jobLauncher, quoteArg } from '../src/winjob.js';

const win = process.platform === 'win32';
const dir = mkdtempSync(join(tmpdir(), 'plenum-winjob-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A pretend AI: starts a server in the background, echoes its input and arguments, exits 7. */
const cli = join(dir, 'cli.js');
writeFileSync(
  cli,
  `const { spawn } = require('node:child_process');
const s = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
s.unref();
require('node:fs').writeFileSync(process.argv[2], String(s.pid));
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  console.log(JSON.stringify({ input, args: process.argv.slice(3) }));
  process.exit(7);
});`,
);

describe('quoting a Windows command line like Node does (1.0.1 S3)', () => {
  it.each([
    ['plain', 'plain'],
    ['', '""'],
    ['two words', '"two words"'],
    ['say "hi"', '"say \\"hi\\""'],
    ['C:\\a b\\', '"C:\\a b\\\\"'],
    ['C:\\path\\x', 'C:\\path\\x'],
    ['a\\\\"b', '"a\\\\\\\\\\"b"'],
  ])('%s', (arg, quoted) => {
    expect(quoteArg(arg)).toBe(quoted);
  });
});

describe.skipIf(!win)('Windows job objects (1.0.1 S3)', () => {
  it('compiles the launcher once', async () => {
    const exe = await jobLauncher();
    expect(exe).toMatch(/plenum-job-[0-9a-f]+\.exe$/);
    expect(await jobLauncher()).toBe(exe);
  }, 120_000);

  it('passes input, arguments, output and the exit code through, and ends what the run left behind', async () => {
    const pidFile = join(dir, 'server-1.pid');
    const args = ['two words', 'say "hi"', 'C:\\a b\\', ''];
    let out = '';
    let exit: number | null = null;
    for await (const chunk of streamProcess({
      command: process.execPath,
      args: [cli, pidFile, ...args],
      stdin: 'from stdin',
      contain: true,
    })) {
      if (chunk.kind === 'line') out += chunk.line;
      if (chunk.kind === 'exit') exit = chunk.code;
    }
    expect(exit).toBe(7);
    expect(JSON.parse(out)).toEqual({ input: 'from stdin', args });
    const server = Number(readFileSync(pidFile, 'utf8'));
    await expect.poll(() => alive(server), { timeout: 5000 }).toBe(false);
  }, 120_000);

  it('without it, the server outlives the run (what 1.0 did)', async () => {
    const pidFile = join(dir, 'server-2.pid');
    for await (const chunk of streamProcess({
      command: process.execPath,
      args: [cli, pidFile],
    }))
      void chunk;
    const server = Number(readFileSync(pidFile, 'utf8'));
    expect(alive(server)).toBe(true);
    process.kill(server);
  }, 60_000);

  it('a test command that starts a server and exits leaves nothing running', async () => {
    const pidFile = join(dir, 'server-3.pid');
    const run = await runShell(`"${process.execPath}" "${cli}" "${pidFile}" x < nul`, { cwd: dir });
    expect(run.code).toBe(7);
    const server = Number(readFileSync(pidFile, 'utf8'));
    await expect.poll(() => alive(server), { timeout: 5000 }).toBe(false);
  }, 120_000);

  it('a stop ends the run and everything it started', async () => {
    const pidFile = join(dir, 'server-4.pid');
    const stop = new AbortController();
    const slow = join(dir, 'slow.js');
    writeFileSync(
      slow,
      `const { spawn } = require('node:child_process');
const s = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
require('node:fs').writeFileSync(process.argv[2], String(s.pid));
console.log('started');
setInterval(() => {}, 1000);`,
    );
    for await (const chunk of streamProcess({
      command: process.execPath,
      args: [slow, pidFile],
      contain: true,
      signal: stop.signal,
    })) {
      if (chunk.kind === 'line') stop.abort();
    }
    const server = Number(readFileSync(pidFile, 'utf8'));
    await expect.poll(() => alive(server), { timeout: 10_000 }).toBe(false);
  }, 120_000);

  it('a program that does not exist reads as not found', async () => {
    const r = await (async () => {
      let stderr = '';
      let error: string | undefined;
      for await (const chunk of streamProcess({
        command: 'plenum-no-such-program',
        args: [],
        contain: true,
      })) {
        if (chunk.kind === 'stderr') stderr += chunk.text;
        if (chunk.kind === 'exit') error = chunk.error;
      }
      return { stderr, error };
    })();
    expect(`${r.error ?? ''} ${r.stderr}`).toMatch(/ENOENT|not recognized/);
  }, 60_000);

  it('npm shims (.cmd) still run through it', async () => {
    const r = await runCommand('npm', ['--version'], { contain: true, timeoutMs: 60_000 });
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  }, 120_000);
});
