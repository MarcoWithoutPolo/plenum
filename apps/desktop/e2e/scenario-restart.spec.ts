import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';

// Private test, scenario 7: close the app mid-run, reopen and resume; then kill it outright
// mid-run, reopen and resume. Checks that no work is duplicated and counts stay honest.
// Real accounts and Conclave data; spends real usage: CONCLAVE_SCENARIO=7 only.
test.skip(process.env.CONCLAVE_SCENARIO !== '7', 'set CONCLAVE_SCENARIO=7 to run');

const here = dirname(fileURLToPath(import.meta.url));
const shots = join(here, 'screenshots', 'scenario-7');
const sqlite = process.getBuiltinModule('node:sqlite');

interface TaskRow {
  id: string;
  title: string;
  status: string;
  attempts: number;
  replaced_by: string | null;
}

function state(name: string) {
  const db = new sqlite.DatabaseSync(join(homedir(), '.conclave', 'conclave.db'), {
    readOnly: true,
  });
  try {
    const p = db
      .prepare(
        'SELECT id, status, status_reason FROM projects WHERE name = ? ORDER BY created_at DESC',
      )
      .get(name) as { id: string; status: string; status_reason: string | null } | undefined;
    if (!p) return undefined;
    const tasks = db
      .prepare(
        'SELECT id, title, status, attempts, replaced_by FROM tasks WHERE project_id = ? ORDER BY priority',
      )
      .all(p.id) as unknown as TaskRow[];
    return { ...p, tasks };
  } finally {
    db.close();
  }
}

const counts = (tasks: TaskRow[]) =>
  Object.fromEntries(
    [...new Set(tasks.map((t) => t.status))].map((s) => [
      s,
      tasks.filter((t) => t.status === s).length,
    ]),
  );

/** Same work twice: identical titles that aren't linked as a replacement. */
function duplicates(tasks: TaskRow[]): string[] {
  const live = tasks.filter((t) => t.status !== 'replaced');
  const seen = new Map<string, number>();
  for (const t of live) seen.set(t.title.toLowerCase(), (seen.get(t.title.toLowerCase()) ?? 0) + 1);
  return [...seen].filter(([, n]) => n > 1).map(([t]) => t);
}

function killTree(pid: number) {
  if (process.platform === 'win32') {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    process.kill(-pid, 'SIGKILL');
  }
}

const { CONCLAVE_DEMO: _d, CONCLAVE_HOME: _h, ...env } = process.env;
const launch = () =>
  electron.launch({
    args: [join(here, '../out/main/index.js')],
    env: env as Record<string, string>,
  });

async function openProject(page: Page, name: string) {
  await page.setViewportSize({ width: 1320, height: 860 });
  await page
    .getByRole('complementary')
    .getByRole('button', { name: /^Projects/ })
    .click();
  await page
    .getByRole('button', { name: new RegExp(name) })
    .first()
    .click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(name);
}

async function waitFor(
  name: string,
  test: (s: NonNullable<ReturnType<typeof state>>) => boolean,
  ms: number,
) {
  const until = Date.now() + ms;
  for (;;) {
    const s = state(name);
    if (s && test(s)) return s;
    if (Date.now() > until)
      throw new Error(
        `Timed out; last state: ${JSON.stringify(s && counts(s.tasks))} ${s?.status}`,
      );
    await new Promise((r) => setTimeout(r, 5_000));
  }
}

function report(label: string, name: string) {
  const s = state(name)!;
  console.log(
    `\n[${new Date().toLocaleTimeString()}] ${label}: ${s.status} · ${s.status_reason ?? ''}`,
  );
  console.log('   counts', JSON.stringify(counts(s.tasks)));
  const stuck = s.tasks.filter((t) => ['building', 'verifying', 'reviewing'].includes(t.status));
  if (stuck.length) console.log('   in flight:', stuck.map((t) => t.title).join(' | '));
  const dup = duplicates(s.tasks);
  console.log('   duplicates:', dup.length ? dup.join(' | ') : 'none');
  return s;
}

test('scenario 7: close and kill mid-run, reopen, resume, nothing duplicated', async () => {
  test.setTimeout(55 * 60_000);
  mkdirSync(shots, { recursive: true });
  const name = `wordcount-restart-${new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-')}`;
  let n = 0;
  let app: ElectronApplication = await launch();
  let page = await app.firstWindow();
  const shot = (label: string) =>
    page.screenshot({ path: join(shots, `${String(++n).padStart(2, '0')}-${label}.png`) });

  try {
    // CONCLAVE_SCENARIO7_RESUME=1 resumes an existing run and goes straight to the hard kill.
    const resume = process.env.CONCLAVE_SCENARIO7_RESUME === '1';
    if (!resume) {
      // Create and start, skipping the questions to keep the run short.
      await page.setViewportSize({ width: 1320, height: 860 });
      await page
        .getByRole('complementary')
        .getByRole('button', { name: /^Projects/ })
        .click();
      await page.getByRole('button', { name: 'New project' }).click();
      const dialog = page.getByRole('dialog', { name: 'New project' });
      await dialog.getByRole('radio', { name: /Create a new folder/ }).click();
      await dialog.getByRole('textbox', { name: 'Folder name' }).fill(name);
      await dialog.getByRole('button', { name: 'Create folder and continue' }).click();
      await dialog
        .getByRole('textbox', { name: 'Goal' })
        .fill(
          'A dependency-free Node.js module wordcount.js exporting count(text) that returns { words, lines, chars } (words split on whitespace, lines on \\n, chars as UTF-16 length), with tests runnable by `node --test` and a package.json whose test script is `node --test`.',
        );
      await dialog.getByRole('button', { name: 'Next' }).click();
      // Skip the questions if they're still loading; otherwise start with the recommended answers.
      await dialog
        .getByRole('button', { name: 'Skip questions' })
        .click({ timeout: 10_000 })
        .catch(() => undefined);
      await dialog.getByRole('button', { name: 'Start', exact: true }).click();
      await expect(dialog).toBeHidden({ timeout: 30_000 });

      // 1. A graceful close while a task is being built.
      await waitFor(name, (s) => s.tasks.some((t) => t.status === 'building'), 10 * 60_000);
      report('building, about to close the app', name);
      await shot('before-close');
      await app.close();
      const closed = report('after a normal close', name);
      expect(
        closed.tasks.filter((t) => ['building', 'verifying', 'reviewing'].includes(t.status)),
      ).toEqual([]);

      // Reopen: the project waits for you rather than restarting by surprise.
      app = await launch();
      page = await app.firstWindow();
      await openProject(page, name);
      await shot('reopened-after-close');
      const reopened = report('reopened', name);
      expect(reopened.tasks.length).toBe(closed.tasks.length);
      await page.getByRole('button', { name: /^(Resume|Start)$/ }).click();
    } else {
      await openProject(page, name);
      await page.getByRole('button', { name: /^(Resume|Start)$/ }).click();
    }

    // 2. A hard kill (like a crash or power cut) while work is in flight.
    {
      const mergedBefore = state(name)!.tasks.filter((t) => t.status === 'merged').length;
      await waitFor(
        name,
        (s) =>
          s.tasks.filter((t) => t.status === 'merged').length > mergedBefore &&
          s.tasks.some((t) => ['building', 'verifying', 'reviewing'].includes(t.status)),
        20 * 60_000,
      );
      report('working again, about to kill the app', name);
      await shot('before-kill');
      // Like a crash or power cut: the whole process tree goes at once.
      killTree(app.process().pid!);
      await new Promise((r) => setTimeout(r, 3_000));
    }
    const killed = report('right after the kill (nothing cleaned up yet)', name);
    expect(killed.status).toBe('running');

    app = await launch();
    page = await app.firstWindow();
    await openProject(page, name);
    await shot('reopened-after-kill');
    const recovered = report('reopened after the kill', name);
    expect(recovered.status).toBe('paused');
    expect(recovered.tasks.length).toBe(killed.tasks.length);
    expect(
      recovered.tasks.filter((t) => ['building', 'verifying', 'reviewing'].includes(t.status)),
    ).toEqual([]);
    await page.getByRole('button', { name: /^(Resume|Start)$/ }).click();
    await waitFor(name, (s) => s.status !== 'paused', 60_000);

    // 3. Let it finish (or stop for you), then check the books.
    const end = await waitFor(
      name,
      (s) => ['done', 'paused', 'needs_you', 'stopped'].includes(s.status),
      30 * 60_000,
    );
    await shot('final');
    report('final', name);
    expect(duplicates(end.tasks)).toEqual([]);
    expect(
      end.tasks.filter((t) => ['building', 'verifying', 'reviewing'].includes(t.status)),
    ).toEqual([]);
    const tasksText = await page.getByRole('region', { name: 'Tasks' }).innerText();
    console.log('\n--- TASKS PANEL ---\n' + tasksText.slice(0, 2000));
    const live = end.tasks.filter((t) => !['replaced', 'skipped'].includes(t.status)).length;
    const merged = end.tasks.filter((t) => t.status === 'merged').length;
    expect(tasksText).toContain(`${merged} of ${live} merged`);
    for (const t of end.tasks) console.log(JSON.stringify(t));
  } finally {
    await app.close().catch(() => undefined);
  }
});
