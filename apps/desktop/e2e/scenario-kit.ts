import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';

// Shared by the private live scenarios (scenario-visual and scenario-more): the real app on your
// real accounts and Plenum data, driven through its own API and read back from its database.
export const here = dirname(fileURLToPath(import.meta.url));
export const sqlite = process.getBuiltinModule('node:sqlite');
export const DB = join(homedir(), '.plenum', 'plenum.db');
export const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

export function query<T>(sql: string, ...args: (string | number)[]): T[] {
  const db = new sqlite.DatabaseSync(DB, { readOnly: true });
  try {
    return db.prepare(sql).all(...args) as T[];
  } finally {
    db.close();
  }
}

export function repo(scenario: string, name: string, files: Record<string, string>): string {
  const dir = join(homedir(), `plenum-scenario-${scenario}`, name);
  mkdirSync(dir, { recursive: true });
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir });
  git('init', '-q', '-b', 'main');
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  git('add', '-A');
  git(
    '-c',
    'user.name=Scenario',
    '-c',
    'user.email=scenario@localhost',
    'commit',
    '-q',
    '-m',
    'init',
  );
  return dir;
}

export const pkg = (name: string, extra: Record<string, unknown> = {}) =>
  `${JSON.stringify({ name, version: '0.1.0', private: true, scripts: { test: 'node --test' }, ...extra }, null, 2)}\n`;

export type Check = { name: string; ok: boolean; detail: string };
export function checker() {
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail = '') => {
    checks.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  };
  return { checks, check };
}

export async function launch(scenario: string, extra: Record<string, string> = {}) {
  const shots = join(here, 'screenshots', `scenario-${scenario}`);
  mkdirSync(shots, { recursive: true });
  const { PLENUM_DEMO: _d, PLENUM_HOME: _h, ...rest } = process.env;
  const env = { ...rest, ...extra };
  const app: ElectronApplication = await electron.launch({
    args: [join(here, '../out/main/index.js')],
    env: env as Record<string, string>,
  });
  const page: Page = await app.firstWindow();
  await page.setViewportSize({ width: 1320, height: 900 });
  let n = 0;
  const shot = (label: string) =>
    page.screenshot({ path: join(shots, `${String(++n).padStart(2, '0')}-${label}.png`) });
  const api = <T>(fn: string, ...args: unknown[]) =>
    page.evaluate(
      ([f, a]) => {
        const [group, method] = (f as string).split('.') as [string, string];
        const g = (
          window.plenum as unknown as Record<string, Record<string, (...x: unknown[]) => unknown>>
        )[group]!;
        return g[method]!(...(a as unknown[]));
      },
      [fn, args] as const,
    ) as Promise<T>;
  return { app, page, shot, api };
}

export const status = (id: string) =>
  query<{ status: string; status_reason: string | null }>(
    'SELECT status, status_reason FROM projects WHERE id = ?',
    id,
  )[0]!;
export const events = (id: string) =>
  query<{
    kind: string;
    message: string;
    provider: string | null;
    task_id: string | null;
    at: number;
  }>(
    'SELECT kind, message, provider, task_id, at FROM brain_events WHERE project_id = ? ORDER BY id',
    id,
  );
export const tasks = (id: string) =>
  query<{
    id: string;
    title: string;
    status: string;
    built_by: string | null;
    reviewed_by: string | null;
  }>(
    'SELECT id, title, status, built_by, reviewed_by FROM tasks WHERE project_id = ? ORDER BY priority',
    id,
  );

/** Poll the database until `done` says so, or the time is up. */
export async function waitFor(page: Page, done: () => boolean, ms: number, every = 15_000) {
  const end = Date.now() + ms;
  while (!done() && Date.now() < end) await page.waitForTimeout(every);
  return done();
}
export const settled = (id: string) =>
  ['done', 'paused', 'stopped', 'needs_you', 'idle'].includes(status(id).status);

export async function openProject(page: Page, name: string) {
  await page
    .getByRole('complementary')
    .getByRole('button', { name: /^Projects/ })
    .click();
  await page
    .getByRole('button', { name: new RegExp(`^${name}`) })
    .first()
    .click();
}
