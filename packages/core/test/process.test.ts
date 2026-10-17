import { describe, expect, it } from 'vitest';
import { isNotFound, runCommand, streamProcess, type ProcessChunk } from '../src/index.js';

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
});

describe('runCommand', () => {
  it('detects a missing executable', async () => {
    const result = await runCommand('conclave-definitely-not-installed', ['--version']);
    expect(result.code).not.toBe(0);
    expect(isNotFound(result)).toBe(true);
  });
});
