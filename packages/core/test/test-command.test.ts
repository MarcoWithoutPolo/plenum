import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectTestCommand } from '../src/index.js';

const dirs: string[] = [];
function folder(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'plenum-testcmd-'));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('test command detection', () => {
  it('reads it from the file that defines it, and says which', () => {
    const npm = folder({ 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }) });
    expect(detectTestCommand(npm)).toEqual({ command: 'npm test', source: 'package.json' });
    const pnpm = folder({
      'package.json': JSON.stringify({ scripts: { test: 'vitest' } }),
      'pnpm-lock.yaml': '',
    });
    expect(detectTestCommand(pnpm)?.command).toBe('pnpm test');
    expect(detectTestCommand(folder({ 'Cargo.toml': '' }))).toEqual({
      command: 'cargo test',
      source: 'Cargo.toml',
    });
    expect(detectTestCommand(folder({ 'go.mod': '' }))?.command).toBe('go test ./...');
    expect(detectTestCommand(folder({ 'pytest.ini': '' }))?.source).toBe('pytest.ini');
    expect(
      detectTestCommand(folder({ 'pyproject.toml': '[tool.pytest.ini_options]\n' }))?.source,
    ).toBe('pyproject.toml');
    expect(detectTestCommand(folder({ Makefile: 'build:\n\tcc x.c\ntest:\n\t./run\n' }))).toEqual({
      command: 'make test',
      source: 'Makefile',
    });
  });

  it("suggests nothing when there's no test set up", () => {
    // npm's placeholder script is not a test.
    const placeholder = folder({
      'package.json': JSON.stringify({
        scripts: { test: 'echo "Error: no test specified" && exit 1' },
      }),
    });
    expect(detectTestCommand(placeholder)).toBeUndefined();
    expect(detectTestCommand(folder({ 'README.md': '# x' }))).toBeUndefined();
    expect(detectTestCommand(folder({ Makefile: 'build:\n\tcc x.c\n' }))).toBeUndefined();
  });
});
