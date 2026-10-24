import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
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

// Private tests, scenarios 9–13 (v0.8), on your real accounts and Conclave data. Scenarios 9,
// 11 and 13 spend real usage; 10 and 12 run no AI. Pick them: CONCLAVE_SCENARIO=9,10,11,12,13.
// Scenario 14 (can each AI read a screenshot) is packages/core/test/live-vision.test.ts.
const which = (process.env.CONCLAVE_SCENARIO ?? '').split(',').map((s) => s.trim());
const here = dirname(fileURLToPath(import.meta.url));
const sqlite = process.getBuiltinModule('node:sqlite');
const DB = join(homedir(), '.conclave', 'conclave.db');
const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

function query<T>(sql: string, ...args: (string | number)[]): T[] {
  const db = new sqlite.DatabaseSync(DB, { readOnly: true });
  try {
    return db.prepare(sql).all(...args) as T[];
  } finally {
    db.close();
  }
}

function repo(scenario: string, name: string, files: Record<string, string>): string {
  const dir = join(homedir(), `conclave-scenario-${scenario}`, name);
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

const pkg = (name: string, extra: Record<string, unknown> = {}) =>
  `${JSON.stringify({ name, version: '0.1.0', private: true, scripts: { test: 'node --test' }, ...extra }, null, 2)}\n`;

type Check = { name: string; ok: boolean; detail: string };
function checker() {
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail = '') => {
    checks.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  };
  return { checks, check };
}

async function launch(scenario: string) {
  const shots = join(here, 'screenshots', `scenario-${scenario}`);
  mkdirSync(shots, { recursive: true });
  const { CONCLAVE_DEMO: _d, CONCLAVE_HOME: _h, ...env } = process.env;
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
          window.conclave as unknown as Record<string, Record<string, (...x: unknown[]) => unknown>>
        )[group]!;
        return g[method]!(...(a as unknown[]));
      },
      [fn, args] as const,
    ) as Promise<T>;
  return { app, page, shot, api };
}

const status = (id: string) =>
  query<{ status: string; status_reason: string | null }>(
    'SELECT status, status_reason FROM projects WHERE id = ?',
    id,
  )[0]!;
const events = (id: string) =>
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
const tasks = (id: string) =>
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
async function waitFor(page: Page, done: () => boolean, ms: number, every = 15_000) {
  const end = Date.now() + ms;
  while (!done() && Date.now() < end) await page.waitForTimeout(every);
  return done();
}
const settled = (id: string) =>
  ['done', 'paused', 'stopped', 'needs_you', 'idle'].includes(status(id).status);

async function openProject(page: Page, name: string) {
  await page
    .getByRole('complementary')
    .getByRole('button', { name: /^Projects/ })
    .click();
  await page
    .getByRole('button', { name: new RegExp(`^${name}`) })
    .first()
    .click();
}

// ── 9: a static web app, 2 lanes: shots for every task, a real visual review ─────────────
test('scenario 9: a static tip calculator, screenshots and a real visual review', async () => {
  test.skip(!which.includes('9'), 'set CONCLAVE_SCENARIO=9 to run');
  test.setTimeout(75 * 60_000);
  const { checks, check } = checker();
  const { app, page, shot, api } = await launch('9');
  try {
    const name = `tips-${stamp}`;
    const p = await api<{ id: string }>('projects.create', {
      repoPath: repo('9', name, { 'package.json': pkg(name), 'README.md': `# ${name}\n` }),
      name,
      goal: 'A static tip calculator web page: index.html, style.css and app.js at the top of the repo, no build step and no dependencies. Inputs for the bill amount, a tip percentage (buttons for 10, 15 and 20% plus a custom field) and the number of people; it shows the tip and the total per person, updating as you type. A light and a dark theme that follow the system setting, a layout that works on a 390px-wide phone without sideways scrolling, readable contrast and buttons at least 44px tall. The arithmetic lives in calc.js, which works both in the page and in node:test tests in test/. npm test runs node --test.',
      maxParallel: 2,
      askPolicy: 'decide',
    });
    await api('projects.start', p.id);
    await openProject(page, name);
    const finished = await waitFor(page, () => settled(p.id), 60 * 60_000);
    await shot('board');
    const s = status(p.id);
    check(
      'the project finished',
      finished && s.status === 'done',
      `${s.status}: ${s.status_reason ?? ''}`,
    );

    const all = tasks(p.id).filter((t) => t.status === 'merged');
    const sets = query<{ task_id: string }>(
      'SELECT DISTINCT task_id FROM snapshot_sets WHERE project_id = ? AND task_id IS NOT NULL',
      p.id,
    ).map((r) => r.task_id);
    const log = events(p.id);
    // A task merged before there was a page has nothing to screenshot; every other one has shots.
    const firstShot = log.find((e) => e.message.startsWith('Screenshots:'))?.at ?? Infinity;
    const later = all.filter(
      (t) => (log.find((e) => e.task_id === t.id && e.kind === 'merge')?.at ?? 0) >= firstShot,
    );
    const missing = later.filter((t) => !sets.includes(t.id));
    check(
      'screenshots for every task once there was a page',
      later.length > 0 && missing.length === 0,
      `${sets.length} task(s) with shots; missing: ${missing.map((t) => t.title).join(', ') || 'none'}`,
    );
    const broken = log.filter((e) => /Screenshots couldn't be taken/.test(e.message));
    check(
      'no screenshot run failed',
      broken.length === 0,
      broken.map((e) => e.message).join(' | '),
    );
    const seen = query<{ provider: string; n: number; tokens: number }>(
      `SELECT provider, COUNT(*) AS n, SUM(image_tokens) AS tokens FROM agent_runs
       WHERE ref_id = ? AND role = 'reviewer' AND image_tokens > 0 GROUP BY provider`,
      p.id,
    );
    check(
      'a reviewer that can see looked at the screenshots',
      seen.length > 0,
      seen.map((r) => `${r.provider}: ${r.n} review(s), ~${r.tokens} image tokens`).join('; '),
    );
    const visual = log.filter((e) => /found visual problems/.test(e.message));
    const approvals = log.filter((e) => e.message.startsWith('Approved'));
    console.log(
      `INFO  visual issues found: ${visual.length}${visual.map((e) => `\n      ${e.provider}: ${e.message}`).join('')}`,
    );
    console.log(
      `INFO  approvals: ${approvals.map((e) => `\n      ${e.provider}: ${e.message}`).join('')}`,
    );
    check(
      'a visual review caught something, or approved with the shots',
      visual.length > 0 || seen.length > 0,
      `${visual.length} visual send-back(s)`,
    );
    const sameAi = tasks(p.id).filter((t) => t.built_by && t.built_by === t.reviewed_by);
    check(
      'no task was reviewed by the AI that built it',
      sameAi.length === 0,
      sameAi.map((t) => t.title).join(', '),
    );

    // The drawer of the last task with shots.
    const last = all.filter((t) => sets.includes(t.id)).at(-1);
    if (last) {
      await page
        .getByRole('region', { name: 'Tasks' })
        .getByRole('button', {
          name: new RegExp(`^${last.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
        })
        .first()
        .click();
      const drawer = page.getByRole('dialog', { name: last.title });
      await drawer.getByRole('region', { name: 'Screenshots' }).scrollIntoViewIfNeeded();
      await shot('screenshots');
      await page.keyboard.press('Escape');
    }
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    await page.waitForTimeout(3000);
    await shot('preview');
  } finally {
    console.log(`\nSCENARIO 9: ${checks.filter((c) => c.ok).length} of ${checks.length} passed`);
    await app.close();
  }
  expect(checks.filter((c) => !c.ok)).toEqual([]);
});

// ── 10: a Vite app: asks once, the preview loads the dev server, stop leaves nothing ──────
test('scenario 10: a Vite dev server preview', async () => {
  test.skip(!which.includes('10'), 'set CONCLAVE_SCENARIO=10 to run');
  test.setTimeout(10 * 60_000);
  const { checks, check } = checker();
  const name = `vite-${stamp}`;
  const dir = repo('10', name, {
    'package.json': pkg(name, { scripts: { dev: 'vite', test: 'node --test' }, type: 'module' }),
    'index.html':
      '<!doctype html><html><head><title>Vite</title></head><body><h1 id="t">Hello from Vite</h1><script type="module" src="/main.js"></script></body></html>\n',
    'main.js': "document.getElementById('t').dataset.ready = 'yes';\n",
    '.gitignore': 'node_modules/\n',
  });
  execFileSync('npm', ['install', '--save-dev', 'vite@7', '--no-audit', '--no-fund'], {
    cwd: dir,
    shell: process.platform === 'win32',
    stdio: 'ignore',
  });
  const { app, page, shot, api } = await launch('10');
  try {
    const p = await api<{ id: string }>('projects.create', {
      repoPath: dir,
      name,
      goal: 'A Vite page.',
    });
    const first = await api<{ kind: string; command?: string; runs?: string }>(
      'projects.preview',
      p.id,
    );
    check(
      'the first preview asks before running npm run dev',
      first.kind === 'needs_approval' && first.command === 'npm run dev',
      JSON.stringify(first),
    );
    await openProject(page, name);
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    const pane = page.getByRole('region', { name: /^Preview: / });
    await expect(pane.getByRole('group', { name: 'Allow the preview command' })).toBeVisible();
    await shot('approval');
    await pane.getByRole('button', { name: 'Allow for this project' }).click();
    const frame = pane.frameLocator('iframe');
    const loaded = await frame
      .getByRole('heading', { name: 'Hello from Vite' })
      .waitFor({ timeout: 90_000 })
      .then(
        () => true,
        () => false,
      );
    const ready = await frame
      .locator('#t')
      .getAttribute('data-ready')
      .catch(() => null);
    check(
      'the pane loads the dev server, with its script running',
      loaded && ready === 'yes',
      `ready=${ready}`,
    );
    await shot('preview');
    const again = await api<{ kind: string; url?: string }>('projects.preview', p.id);
    check('allowed once, it opens without asking', again.kind === 'ready', again.kind);
    const url = again.url ? new URL(again.url) : undefined;
    await api('projects.stopPreview', p.id);
    await page.waitForTimeout(1500);
    const listening = (host: string) =>
      new Promise<boolean>((resolve) => {
        const c = connect(Number(url!.port), host);
        c.once('connect', () => (c.destroy(), resolve(true)));
        c.once('error', () => resolve(false));
      });
    // Both loopbacks: Vite on Windows listens on ::1 only.
    const open = url ? (await listening('127.0.0.1')) || (await listening('::1')) : true;
    check('stopping leaves nothing listening', !open, url?.href ?? 'no url');
    // Any process still running from the project's folder (the check itself left out).
    const left =
      process.platform === 'win32'
        ? Number(
            execFileSync(
              'powershell',
              [
                '-NoProfile',
                '-Command',
                `@(Get-CimInstance Win32_Process | Where-Object { $_.Name -ne 'powershell.exe' -and $_.CommandLine -like '*${name}*' }).Count`,
              ],
              { encoding: 'utf8' },
            ).trim(),
          )
        : Number(
            execFileSync('sh', ['-c', `pgrep -f '${name}' | grep -v "^$$\\$" | wc -l`], {
              encoding: 'utf8',
            }).trim(),
          );
    check('no dev-server process is left', left === 0, `${left} process(es)`);
    await api('projects.remove', p.id);
  } finally {
    console.log(`\nSCENARIO 10: ${checks.filter((c) => c.ok).length} of ${checks.length} passed`);
    await app.close();
  }
  expect(checks.filter((c) => !c.ok)).toEqual([]);
});

// ── 11: Antigravity reviews slowly; the review time budget asks a faster AI too ─────────
test('scenario 11: the review time budget', async () => {
  test.skip(!which.includes('11'), 'set CONCLAVE_SCENARIO=11 to run');
  test.setTimeout(45 * 60_000);
  const { checks, check } = checker();
  const { app, page, shot, api } = await launch('11');
  try {
    const name = `units-${stamp}`;
    const p = await api<{ id: string }>('projects.create', {
      repoPath: repo('11', name, { 'package.json': pkg(name), 'README.md': `# ${name}\n` }),
      name,
      goal: 'A dependency-free Node.js module src/units.js that converts between at least 40 units of length, mass, volume and temperature, table-driven, with convert(value, from, to) and a list() of units, plus node:test tests in test/ that cover every unit. npm test runs node --test.',
      // Antigravity reviews first, in the order you set; Claude is the faster backup.
      routing: {
        planner: [{ provider: 'claude' }],
        builder: [{ provider: 'codex' }],
        reviewer: [{ provider: 'antigravity' }, { provider: 'claude' }],
      },
      adaptiveTeam: false,
      maxAttempts: 2,
      askPolicy: 'decide',
    });
    await api('projects.start', p.id);
    await openProject(page, name);
    const budget = () =>
      events(p.id).find((e) => /hasn't answered in .+; asking .+ too/.test(e.message));
    const answered = () =>
      events(p.id).find((e) => / first; stopped .+'s review$| gave no verdict$/.test(e.message));
    const reviewed = () =>
      events(p.id).some(
        (e) =>
          e.kind === 'review' &&
          /^(Approved|Changes requested|.+ found visual problems)/.test(e.message),
      );
    await waitFor(page, () => Boolean(answered()) || (reviewed() && settled(p.id)), 40 * 60_000);
    await shot('activity');
    const b = budget();
    const a = answered();
    check(
      'a slow review got a backup after its budget',
      Boolean(b),
      b?.message ?? 'Antigravity answered within its budget every time',
    );
    check('the first verdict won, and the other review stopped', Boolean(a), a?.message ?? '');
    const runs = query<{ provider: string; ok: number; cancelled: number; duration_ms: number }>(
      "SELECT provider, ok, cancelled, duration_ms FROM agent_runs WHERE ref_id = ? AND role = 'reviewer' ORDER BY id",
      p.id,
    );
    console.log(
      `INFO  reviews: ${runs.map((r) => `${r.provider} ${Math.round(r.duration_ms / 1000)}s${r.cancelled ? ' (cancelled)' : r.ok ? '' : ' (failed)'}`).join(', ')}`,
    );
    check(
      'the stopped review is marked cancelled',
      !a || / gave no verdict$/.test(a.message) || runs.some((r) => r.cancelled === 1),
      '',
    );
    const sameAi = tasks(p.id).filter((t) => t.built_by && t.built_by === t.reviewed_by);
    check('no same-AI review', sameAi.length === 0, sameAi.map((t) => t.title).join(', '));
    await api('projects.stop', p.id);
  } finally {
    console.log(`\nSCENARIO 11: ${checks.filter((c) => c.ok).length} of ${checks.length} passed`);
    await app.close();
  }
  expect(checks.filter((c) => !c.ok)).toEqual([]);
});

// ── 12: Codex can't work right now: the start-up check says what changes, before anything runs
test('scenario 12: the start-up check', async () => {
  test.skip(!which.includes('12'), 'set CONCLAVE_SCENARIO=12 to run');
  test.setTimeout(10 * 60_000);
  const { checks, check } = checker();
  const { app, page, shot, api } = await launch('12');
  const original = await api<{ limits: { quietHours: unknown[] } }>('settings.get');
  try {
    // Simulated: quiet hours for Codex from now for an hour (put back at the end).
    const now = new Date();
    const hhmm = (d: Date) =>
      `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const later = new Date(now.getTime() + 60 * 60_000);
    await api('settings.update', {
      limits: {
        quietHours: [
          ...original.limits.quietHours,
          { days: [now.getDay()], from: hhmm(now), to: hhmm(later), providers: ['codex'] },
        ],
      },
    });
    const name = `check-${stamp}`;
    const p = await api<{ id: string }>('projects.create', {
      repoPath: repo('12', name, { 'package.json': pkg(name), 'README.md': `# ${name}\n` }),
      name,
      goal: 'A small greet() helper with a test.',
    });
    const team = await api<{ project: { routing: unknown } }>('projects.get', p.id).catch(
      () => null,
    );
    console.log(`INFO  team: ${JSON.stringify(team?.project.routing ?? {})}`);
    await openProject(page, name);
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    const note = page.getByRole('group', { name: 'Before you start' });
    const shown = await note.waitFor({ timeout: 15_000 }).then(
      () => true,
      () => false,
    );
    const text = shown ? await note.innerText() : '';
    check(
      'the start-up check explains the change',
      shown && /Codex is in quiet hours until .+\. Building moves to /.test(text),
      text.replace(/\s+/g, ' ').slice(0, 300),
    );
    await shot('start-check');
    const runs = query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM agent_runs WHERE ref_id = ?',
      p.id,
    )[0]!.n;
    check(
      'nothing ran before you chose',
      runs === 0 && status(p.id).status === 'idle',
      `${runs} run(s), ${status(p.id).status}`,
    );
    await note.getByRole('button', { name: 'Close' }).click();
    await api('projects.remove', p.id);
  } finally {
    await api('settings.update', { limits: { quietHours: original.limits.quietHours } });
    console.log(`\nSCENARIO 12: ${checks.filter((c) => c.ok).length} of ${checks.length} passed`);
    await app.close();
  }
  expect(checks.filter((c) => !c.ok)).toEqual([]);
});

// ── 13: skip a running task from the chat: only its lane stops ───────────────────────────
test('scenario 13: skip a running task from the chat', async () => {
  test.skip(!which.includes('13'), 'set CONCLAVE_SCENARIO=13 to run');
  test.setTimeout(60 * 60_000);
  const { checks, check } = checker();
  const { app, page, shot, api } = await launch('13');
  try {
    const name = `strings-${stamp}`;
    const p = await api<{ id: string }>('projects.create', {
      repoPath: repo('13', name, { 'package.json': pkg(name), 'README.md': `# ${name}\n` }),
      name,
      goal: 'A dependency-free Node.js package with three independent modules, each with its own node:test file in test/: src/case.js (camelCase, snakeCase, kebabCase), src/pad.js (padLeft, padRight, center) and src/count.js (countWords, countLines, countChars). index.js re-exports everything. npm test runs node --test.',
      maxParallel: 2,
      askPolicy: 'decide',
    });
    await api('projects.start', p.id);
    await openProject(page, name);
    // Wait for two tasks building at once, then ask the chat to skip one of them.
    const building = () => tasks(p.id).filter((t) => t.status === 'building');
    await waitFor(page, () => building().length >= 2 || settled(p.id), 20 * 60_000, 3_000);
    const target = building()[0];
    check(
      'two lanes were building',
      building().length >= 2,
      building()
        .map((t) => t.title)
        .join(', '),
    );
    if (!target) throw new Error('No task was building.');
    const other = building().find((t) => t.id !== target.id);
    await page.getByRole('tab', { name: /Chat/ }).click();
    const { planner } = await api<{
      planner: { id: string; actions: { type: string; id?: string }[] };
    }>(
      'projects.steer',
      p.id,
      `Please skip the task "${target.title}" now, even though it's being built; I don't need it.`,
    );
    const at = planner.actions.findIndex((a) => a.type === 'skip_task' && a.id === target.id);
    check('the planner proposed skipping it', at >= 0, JSON.stringify(planner.actions));
    await page.waitForTimeout(1500);
    await shot('chat-proposal');
    if (at >= 0) await api('projects.applySteering', planner.id, [at]);
    await waitFor(
      page,
      () =>
        events(p.id).some((e) => e.message === `Stopped work on ${target.title}: you skipped it`),
      3 * 60_000,
      2_000,
    );
    const t = tasks(p.id).find((x) => x.id === target.id)!;
    check('that task stopped and is skipped', t.status === 'skipped', t.status);
    const o = other && tasks(p.id).find((x) => x.id === other.id)!;
    check(
      'the other lane kept going',
      !o || ['building', 'verifying', 'reviewing', 'merging', 'merged'].includes(o.status),
      o?.status ?? '',
    );
    await shot('board-after-skip');
    await waitFor(page, () => settled(p.id), 40 * 60_000);
    const all = tasks(p.id);
    const merged = all.filter((x) => x.status === 'merged').length;
    const counted = all.filter((x) => !['skipped', 'replaced'].includes(x.status)).length;
    const skippedRuns = query<{ ok: number; cancelled: number }>(
      "SELECT ok, cancelled FROM agent_runs WHERE task_id = ? AND role = 'builder' ORDER BY id DESC LIMIT 1",
      target.id,
    )[0];
    check(
      'its stopped build is recorded as cancelled, not failed',
      skippedRuns?.cancelled === 1,
      JSON.stringify(skippedRuns ?? null),
    );
    const s = status(p.id);
    check(
      'the project finished, with the skipped task out of the total',
      s.status === 'done' && merged === counted,
      `${s.status}; ${merged} of ${counted} merged; ${all.length - counted} left out`,
    );
    await shot('done');
  } finally {
    console.log(`\nSCENARIO 13: ${checks.filter((c) => c.ok).length} of ${checks.length} passed`);
    await app.close();
  }
  expect(checks.filter((c) => !c.ok)).toEqual([]);
});
