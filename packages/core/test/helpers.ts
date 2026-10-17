import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Exec, ProcessChunk, ProcessOptions } from '../src/index.js';

const fixtures = fileURLToPath(new URL('../../../test/fixtures/', import.meta.url));

export function fixtureLines(name: string): string[] {
  return readFileSync(fixtures + name, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean);
}

/** An Exec that replays a recorded CLI run instead of spawning the CLI. */
export function replay(
  name: string,
  exitCode = 0,
  stderr = '',
): Exec & { calls: ProcessOptions[] } {
  const calls: ProcessOptions[] = [];
  const exec = async function* (opts: ProcessOptions): AsyncGenerator<ProcessChunk> {
    calls.push(opts);
    for (const line of fixtureLines(name)) yield { kind: 'line', line };
    if (stderr) yield { kind: 'stderr', text: stderr };
    yield { kind: 'exit', code: exitCode };
  };
  return Object.assign(exec, { calls });
}
