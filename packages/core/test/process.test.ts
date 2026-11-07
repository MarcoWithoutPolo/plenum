import { spawn as nodeSpawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isNotFound,
  killTree,
  runCommand,
  runShell,
  streamProcess,
  type ProcessChunk,
} from '../src/index.js';

const node = process.execPath;

async function all(iter: AsyncIterable<ProcessChunk>): Promise<ProcessChunk[]> {
  const out: ProcessChunk[] = [];
  for await (const c of iter) out.push(c);
  return out;
}

describe('streamProcess', () => {
  it('streams stdout lines, passes stdin and reports the exit code', async () => {
    const script =
      "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{console.log('a');console.log(s.toUpperCase());process.exit(3)})";
    const chunks = await all(
      streamProcess({ command: node, args: ['-e', script], stdin: 'hello' }),
    );
    expect(chunks.filter((c) => c.kind === 'line').map((c) => c.kind === 'line' && c.line)).toEqual(
      ['a', 'HELLO'],
    );
    expect(chunks.at(-1)).toEqual({ kind: 'exit', code: 3 });
  });

  it('kills the process on timeout', async () => {
    const chunks = await all(
      streamProcess({ command: node, args: ['-e', 'setTimeout(()=>{},60000)'], timeoutMs: 200 }),
    );
    const exit = chunks.at(-1);
    expect(exit?.kind).toBe('exit');
    expect(exit?.kind === 'exit' && exit.error).toMatch(/Timed out/);
  });

  it('kills the process when aborted', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const chunks = await all(
      streamProcess({
        command: node,
        args: ['-e', 'setTimeout(()=>{},60000)'],
        signal: controller.signal,
      }),
    );
    const exit = chunks.at(-1);
    expect(exit?.kind === 'exit' && exit.error).toBe('Cancelled');
  });

  // A CLI that started a server and left it running: a README task once sat "building" for 46
  // minutes after its 44 seconds of work, because the server still held the output open.
  it('ends soon after the exit when something it started keeps the output open', async () => {
    const leftover = "setTimeout(()=>console.log('late'),1000);setTimeout(()=>{},30000)";
    const script = `const c=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(leftover)}],{stdio:'inherit',detached:${process.platform === 'win32'}});console.log(c.pid);c.unref()`;
    const started = Date.now();
    const chunks = await all(streamProcess({ command: node, args: ['-e', script] }));
    expect(Date.now() - started).toBeLessThan(20_000);
    const lines = chunks.flatMap((c) => (c.kind === 'line' ? [c.line] : []));
    // What it printed during the wait still counts, and a clean exit stays clean.
    expect(lines).toContain('late');
    expect(chunks.at(-1)).toEqual({ kind: 'exit', code: 0 });
    const pid = Number(lines[0]);
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const end = Date.now() + 8000;
    while (alive() && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    const still = alive();
    if (still) process.kill(pid);
    expect(still).toBe(false);
  }, 40_000);

  // A CLI started through an npm .cmd shim, running a shell of its own: on Windows, stopping
  // it must take the whole tree down, or the shell keeps the worktree locked (live scenario 9).
  it.skipIf(process.platform !== 'win32')(
    'kills what the process started too, when aborted',
    async () => {
      const controller = new AbortController();
      // Like an npm-installed CLI: a .cmd shim (cmd.exe) that runs node, which prints its pid.
      const dir = mkdtempSync(join(tmpdir(), 'conclave-shim-'));
      writeFileSync(join(dir, 'cli.js'), 'console.log(process.pid);setTimeout(()=>{},60000)');
      writeFileSync(join(dir, 'cli.cmd'), `@"${node}" "%~dp0cli.js" %*\r\n`);
      let grandchild = 0;
      for await (const c of streamProcess({
        command: join(dir, 'cli.cmd'),
        args: [],
        signal: controller.signal,
      })) {
        if (c.kind === 'line' && !grandchild) {
          grandchild = Number(c.line);
          controller.abort();
        }
      }
      expect(grandchild).toBeGreaterThan(0);
      const alive = () => {
        try {
          process.kill(grandchild, 0);
          return true;
        } catch {
          return false;
        }
      };
      const end = Date.now() + 5000;
      while (alive() && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
      expect(alive()).toBe(false);
    },
  );
});

describe('runCommand', () => {
  it('detects a missing executable', async () => {
    const result = await runCommand('conclave-definitely-not-installed', ['--version']);
    expect(result.code).not.toBe(0);
    expect(isNotFound(result)).toBe(true);
  });
});

describe('killTree (E6)', () => {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it('kills what a process started even after that process has exited', async () => {
    // The parent starts a long-running child, prints its pid, and exits: the child is an orphan,
    // as npm's children were when a dev server's shell died first.
    const parent = nodeSpawn(
      process.execPath,
      [
        '-e',
        // On Windows a Node child dies with its parent unless detached; a shell's (cmd → npm)
        // doesn't, so detach it there to get the orphan the shell would leave.
        `const c = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: ${process.platform === 'win32'} }); console.log(c.pid); setTimeout(() => process.exit(0), 300);`,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'], detached: process.platform !== 'win32' },
    );
    let out = '';
    parent.stdout!.on('data', (d: Buffer) => (out += d.toString()));
    await new Promise((r) => parent.once('exit', r));
    const orphan = Number(out.trim());
    expect(alive(orphan)).toBe(true);
    await killTree(parent);
    await new Promise((r) => setTimeout(r, 300));
    const still = alive(orphan);
    if (still) process.kill(orphan);
    expect(still).toBe(false);
  }, 30_000);
});

describe('runCommand keeps blank lines (E13)', () => {
  it('returns output exactly, empty lines included (a diff needs them)', async () => {
    const r = await runCommand(process.execPath, [
      '-e',
      "process.stdout.write(['a', '', '  ', 'b', ''].join(String.fromCharCode(10)))",
    ]);
    expect(r.stdout.split('\n')).toEqual(['a', '', '  ', 'b']);
  });
});

describe('runShell stops everything it started (E6)', () => {
  it('a timeout returns soon even when a child keeps the output open', async () => {
    // The shell starts a child that holds stdout and runs for a minute.
    const started = Date.now();
    const r = await runShell(
      `"${process.execPath}" -e "setInterval(() => console.log('tick'), 200)"`,
      { cwd: process.cwd(), timeoutMs: 1_000 },
    );
    expect(r.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(12_000);
  }, 30_000);
});
