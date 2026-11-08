import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type Page } from '@playwright/test';

// Private test, scenario 8 (v0.7): on your real accounts and Plenum data, two projects at
// once with lanes, steering from the board and the Chat tab, quiet hours and Pause everything
// set mid-run, shared lane caps, and a desktop notification while the window is in the
// background. Spends real usage: PLENUM_SCENARIO=8 only. Your settings are put back at the end.
test.skip(process.env.PLENUM_SCENARIO !== '8', 'set PLENUM_SCENARIO=8 to run');

const here = dirname(fileURLToPath(import.meta.url));
const shots = join(here, 'screenshots', 'scenario-8');
const sqlite = process.getBuiltinModule('node:sqlite');
const DB = join(homedir(), '.plenum', 'plenum.db');
const CAPS: Record<string, number> = { claude: 2, codex: 2, antigravity: 1 };

function query<T>(sql: string, ...args: (string | number)[]): T[] {
  const db = new sqlite.DatabaseSync(DB, { readOnly: true });
  try {
    return db.prepare(sql).all(...args) as T[];
  } finally {
    db.close();
  }
}

function repo(name: string): string {
  const dir = join(homedir(), 'plenum-scenario-8', name);
  mkdirSync(dir, { recursive: true });
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir });
  git('init', '-q', '-b', 'main');
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify({ name, version: '0.1.0', private: true, scripts: { test: 'node --test' } }, null, 2)}\n`,
  );
  writeFileSync(join(dir, 'README.md'), `# ${name}\n`);
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

const checks: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

/** Brain events since `since` for these projects, as "provider: message". */
const eventsSince = (ids: string[], since: number) =>
  query<{ provider: string | null; message: string; at: number; project_id: string }>(
    `SELECT provider, message, at, project_id FROM brain_events WHERE at >= ? AND project_id IN (${ids.map(() => '?').join(',')}) ORDER BY at`,
    since,
    ...ids,
  );
const STARTS = /^(Planning with|Reviewing with|Building:|Attempt \d+:)/;

test('scenario 8: two projects, lanes, steering, quiet hours, pause, notifications', async () => {
  test.setTimeout(80 * 60_000);
  mkdirSync(shots, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const { PLENUM_DEMO: _d, PLENUM_HOME: _h, ...env } = process.env;
  const app = await electron.launch({
    args: [join(here, '../out/main/index.js')],
    env: env as Record<string, string>,
  });
  // Record every desktop notification the app shows (it still shows on your screen).
  await app.evaluate(({ Notification }) => {
    const g = globalThis as unknown as { shown: string[] };
    g.shown = [];
    const show = Notification.prototype.show;
    Notification.prototype.show = function (this: Electron.Notification) {
      g.shown.push(`${this.title}: ${this.body}`);
      return show.call(this);
    };
  });
  const page: Page = await app.firstWindow();
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
  const original = await api<{ limits: unknown; notifications: unknown }>('settings.get');
  const status = (id: string) =>
    query<{ status: string; status_reason: string | null }>(
      'SELECT status, status_reason FROM projects WHERE id = ?',
      id,
    )[0]!;
  const sample: { building: Record<string, number>; at: number }[] = [];
  const sampleLanes = () => {
    const rows = query<{ built_by: string; n: number }>(
      "SELECT built_by, COUNT(*) AS n FROM tasks WHERE status = 'building' GROUP BY built_by",
    );
    sample.push({
      building: Object.fromEntries(rows.map((r) => [r.built_by, r.n])),
      at: Date.now(),
    });
  };
  const sampler = setInterval(sampleLanes, 10_000);

  try {
    await page.setViewportSize({ width: 1320, height: 860 });

    // ── Two projects, both with 2 lanes and decide-and-tell ─────────────
    type P = { id: string; name: string };
    const create = async (name: string, goal: string): Promise<P> => {
      const repoPath = repo(name);
      const p = await api<P>('projects.create', {
        repoPath,
        name,
        goal,
        maxParallel: 2,
        askPolicy: 'decide',
      });
      return p;
    };
    const a = await create(
      `strings-${stamp}`,
      'A dependency-free Node.js package with three independent modules, each with its own node:test file in test/: src/case.js (camelCase, snakeCase, kebabCase), src/pad.js (padLeft, padRight, center) and src/count.js (countWords, countLines, countChars). index.js re-exports everything. npm test runs node --test.',
    );
    await api('projects.start', a.id);
    await page
      .getByRole('complementary')
      .getByRole('button', { name: /^Projects/ })
      .click();
    await page
      .getByRole('button', { name: new RegExp(a.name) })
      .first()
      .click();
    const board = page.getByRole('region', { name: 'Tasks' });
    await expect(board.getByRole('listitem').first()).toBeVisible({ timeout: 6 * 60_000 });
    await shot('a-planned');

    // ── Board: add and edit a task while it runs ────────────────────────
    await board.getByRole('button', { name: 'Add a task' }).click();
    const add = page.getByRole('dialog', { name: 'Add a task' });
    await add
      .getByRole('textbox', { name: 'Title' })
      .fill('Add src/trim.js with trimStart and trimEnd');
    await add
      .getByRole('textbox', { name: /What to do/ })
      .fill(
        'Create src/trim.js exporting trimStart(text, chars) and trimEnd(text, chars), with tests in test/trim.test.js, and re-export them from index.js.',
      );
    await add.getByRole('button', { name: 'Add task' }).click();
    await expect(board).toContainText('Add src/trim.js', { timeout: 10_000 });
    await board.getByRole('button', { name: /^Actions for Add src\/trim\.js/ }).click();
    await page.getByRole('button', { name: 'Edit…' }).click();
    const edit = page.getByRole('dialog', { name: 'Edit task' });
    await edit
      .getByRole('textbox', { name: 'Title' })
      .fill('Add src/trim.js with trimStart, trimEnd and trimBoth');
    await edit.getByRole('button', { name: 'Save' }).click();
    await expect(board).toContainText('trimBoth');
    check('board: add and edit a task mid-run', true);
    await shot('a-board-edited');

    // ── Chat: a real planner proposes, we apply ─────────────────────────
    await page.getByRole('tab', { name: 'Chat' }).click();
    await page
      .getByRole('textbox', { name: 'Message to the project' })
      .fill(
        'Also add src/repeat.js with repeat(text, times) and its tests, as its own task that can start right away. And record the decision that every function throws a TypeError when its text argument is not a string.',
      );
    await page.getByRole('button', { name: 'Send' }).click();
    const proposal = page.getByRole('group', { name: 'Proposed changes' });
    await expect(proposal).toBeVisible({ timeout: 6 * 60_000 });
    await shot('a-chat-proposal');
    const proposed = await proposal.innerText();
    console.log('PROPOSAL:\n' + proposed);
    check(
      'chat: the planner proposes an add_task',
      /Add “/.test(proposed),
      proposed.split('\n')[0] ?? '',
    );
    check('chat: the planner proposes a decision', /Decision:/.test(proposed));
    await proposal.getByRole('button', { name: /^Apply/ }).click();
    const chat = page.getByRole('region', { name: 'Chat' });
    await expect(chat).toContainText(/Added “|Decision:/, { timeout: 20_000 });
    const applied = await chat.innerText();
    check('chat: applied without errors', !/Not done/.test(applied), applied.slice(-300));
    await expect(board).toContainText(/repeat/i, { timeout: 10_000 });
    check('chat: the new task is on the board', true);
    const decided = query<{ answer: string }>(
      "SELECT answer FROM decisions WHERE project_id = ? AND source = 'you'",
      a.id,
    );
    check(
      'chat: the decision is recorded as yours',
      decided.length > 0,
      decided.map((d) => d.answer).join('; '),
    );
    await shot('a-chat-applied');
    await page.getByRole('tab', { name: 'Activity' }).click();

    // ── A second project at the same time ───────────────────────────────
    const b = await create(
      `clamp-${stamp}`,
      'A dependency-free Node.js module clamp.js exporting clamp(n, min, max) and inRange(n, min, max), with node:test tests in test/ and a README with examples. npm test runs node --test.',
    );
    await api('projects.start', b.id);
    await page.waitForTimeout(20_000);
    const both = [a, b].map((p) => status(p.id).status);
    check(
      'two projects run at once',
      both.every((s) => ['running', 'waiting'].includes(s)),
      both.join(', '),
    );

    // ── Quiet hours on Claude, set mid-run ──────────────────────────────
    const now = new Date();
    const hhmm = (d: Date) =>
      `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const quietFrom = hhmm(new Date(now.getTime() - 60 * 60_000));
    const quietTo = hhmm(new Date(now.getTime() + 60 * 60_000));
    await api('settings.update', {
      limits: {
        quietHours: [
          { days: [0, 1, 2, 3, 4, 5, 6], from: quietFrom, to: quietTo, providers: ['claude'] },
        ],
      },
    });
    const quietAt = Date.now();
    await page.getByRole('button', { name: /^Settings/ }).click();
    await shot('settings-quiet');
    await page
      .getByRole('complementary')
      .getByRole('button', { name: /^Projects/ })
      .click();
    await page.waitForTimeout(4 * 60_000);
    const quietStarts = eventsSince([a.id, b.id], quietAt + 5_000).filter(
      (e) => e.provider === 'claude' && STARTS.test(e.message),
    );
    check(
      'quiet hours: nothing new starts on Claude',
      quietStarts.length === 0,
      quietStarts.map((e) => e.message).join(' | '),
    );
    const others = eventsSince([a.id, b.id], quietAt).filter(
      (e) => e.provider !== 'claude' && STARTS.test(e.message),
    );
    check(
      'quiet hours: work goes on with the other AIs',
      others.length > 0,
      `${others.length} steps started`,
    );
    await api('settings.update', { limits: { quietHours: [] } });

    // ── Pause everything ────────────────────────────────────────────────
    await api('settings.update', { limits: { pauseAll: true } });
    const pausedAt = Date.now();
    await page.waitForTimeout(3 * 60_000);
    const pausedStarts = eventsSince([a.id, b.id], pausedAt + 5_000).filter((e) =>
      STARTS.test(e.message),
    );
    check(
      'pause everything: no new steps start',
      pausedStarts.length === 0,
      pausedStarts.map((e) => e.message).join(' | '),
    );
    const waits = eventsSince([a.id, b.id], pausedAt).filter((e) =>
      /you paused everything/.test(e.message),
    );
    check(
      'pause everything: the wait says why',
      waits.length > 0,
      waits[0]?.message ?? 'no wait event',
    );
    await shot('paused');
    await api('settings.update', { limits: { pauseAll: false } });
    const resumedAt = Date.now();

    // ── In the background until both finish; a notification should appear ─
    console.log(
      '\n>>> The window goes to the background now. Watch for a Plenum notification. <<<\n',
    );
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.minimize());
    const until = Date.now() + 45 * 60_000;
    for (;;) {
      await page.waitForTimeout(30_000);
      const s = [a, b].map((p) => status(p.id));
      console.log(
        new Date().toLocaleTimeString(),
        s.map((x) => `${x.status} ${x.status_reason ?? ''}`).join(' | '),
      );
      if (s.every((x) => ['needs_you', 'done', 'paused', 'stopped', 'idle'].includes(x.status)))
        break;
      if (Date.now() > until) {
        console.log('Time is up.');
        break;
      }
    }
    const resumed = eventsSince([a.id, b.id], resumedAt).filter((e) => STARTS.test(e.message));
    check('after unpausing, work resumes', resumed.length > 0, `${resumed.length} steps started`);
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      w?.restore();
      w?.focus();
    });
    const shown = await app.evaluate(() => (globalThis as unknown as { shown: string[] }).shown);
    console.log('NOTIFICATIONS:\n' + shown.join('\n'));
    check(
      'a desktop notification was shown while in the background',
      shown.length > 0,
      shown.join(' | '),
    );
    const done = [a, b].map((p) => status(p.id).status);
    check(
      'both projects finished',
      done.every((s) => s === 'done'),
      done.join(', '),
    );
    for (const p of [a, b]) {
      await page
        .getByRole('complementary')
        .getByRole('button', { name: /^Projects/ })
        .click();
      await page
        .getByRole('button', { name: new RegExp(p.name) })
        .first()
        .click();
      await shot(`final-${p.name.split('-')[0]}`);
    }

    // ── Lanes and shared caps, from the samples ─────────────────────────
    const over = sample.filter((s) =>
      Object.entries(s.building).some(([p, k]) => k > (CAPS[p] ?? 1)),
    );
    check(
      'shared lane caps held across both projects',
      over.length === 0,
      JSON.stringify(over[0]?.building ?? {}),
    );
    const peak = Math.max(
      ...sample.map((s) => Object.values(s.building).reduce((x, y) => x + y, 0)),
    );
    check('lanes: more than one task built at once', peak >= 2, `peak ${peak} building at once`);
    const merges = query<{ message: string }>(
      "SELECT message FROM brain_events WHERE project_id IN (?, ?) AND message LIKE 'Re-tested%'",
      a.id,
      b.id,
    );
    console.log(`merge queue re-tests: ${merges.length}`);
  } finally {
    clearInterval(sampler);
    await api('settings.update', original).catch(() => undefined);
    console.log('\n--- CHECKS ---');
    for (const c of checks)
      console.log(
        `${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  (${c.detail.slice(0, 300)})` : ''}`,
      );
    await app.close();
  }
  expect(checks.filter((c) => !c.ok).map((c) => c.name)).toEqual([]);
});
