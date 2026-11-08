import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, SCHEMA_VERSION } from '../src/store/db.js';

const cleanup: string[] = [];
afterEach(() => {
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

const db = fileURLToPath(new URL('../src/store/db.ts', import.meta.url));
const root = fileURLToPath(new URL('../../../', import.meta.url));

/** Open the database in a separate process, as the app and the CLI each do. */
function opener(path: string): Promise<{ code: number | null; err: string }> {
  return new Promise((done) => {
    const p = spawn(
      process.execPath,
      [
        '--conditions=development',
        '--import',
        'tsx',
        '-e',
        `import(${JSON.stringify(pathToFileURL(db).href)}).then((m) => m.openDatabase(${JSON.stringify(path)}).close())`,
      ],
      { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let err = '';
    p.stderr.on('data', (d: Buffer) => (err += d.toString()));
    p.on('close', (code) => done({ code, err }));
  });
}

describe('Migrations with several processes (E11)', () => {
  it('four processes opening a new database at once all succeed, each step once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plenum-migrate-'));
    cleanup.push(dir);
    const path = join(dir, 'plenum.db');
    const results = await Promise.all([1, 2, 3, 4].map(() => opener(path)));
    for (const r of results)
      expect(
        r.code,
        r.err
          .split('\n')
          .filter((l) => !/Experimental|trace-warnings/.test(l))
          .join('\n'),
      ).toBe(0);
    const d = openDatabase(path);
    expect((d.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(
      SCHEMA_VERSION,
    );
    d.close();
  }, 60_000);
});
