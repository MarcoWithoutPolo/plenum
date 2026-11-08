import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  checker,
  events,
  launch,
  openProject,
  pkg,
  repo,
  settled,
  stamp,
  status,
  tasks,
  waitFor,
} from './scenario-kit.js';

// Private tests, scenarios 22–23 (v0.9.1, the faster loop), on your real accounts and Plenum
// data. They spend real usage. Pick them: PLENUM_SCENARIO=22,23.
const which = (process.env.PLENUM_SCENARIO ?? '').split(',').map((s) => s.trim());

type Api = <T>(fn: string, ...args: unknown[]) => Promise<T>;

const GOAL =
  'A tiny clamp module: clamp.js exporting clamp(n, min, max), with node:test tests in test/clamp.test.js for values below, inside and above the range. npm test runs node --test. Keep it to that one function.';

function clampRepo(scenario: string, name: string) {
  return repo(scenario, name, { 'package.json': pkg(name), 'README.md': `# ${name}\n` });
}

async function start(page: Page, api: Api, input: Record<string, unknown>) {
  const p = await api<{ id: string }>('projects.create', input);
  await api('projects.start', p.id);
  await openProject(page, String(input.name));
  return p.id;
}

const finished = (id: string) =>
  status(id).status === 'done' || (settled(id) && tasks(id).some((t) => t.status === 'merged'));

const hhmm = (d: Date) =>
  `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

// ── 22: a reviewer asks for one small change; the retry continues from the kept commit ───────
test('scenario 22: a review send-back continues from the last attempt', async () => {
  test.skip(!which.includes('22'), 'set PLENUM_SCENARIO=22 to run');
  test.setTimeout(40 * 60_000);
  const { checks, check } = checker();
  const { app, page, shot, api } = await launch('22');
  try {
    const name = `kept-${stamp}`;
    const dir = clampRepo('22', name);
    const id = await start(page, api, {
      repoPath: dir,
      name,
      goal: GOAL,
      routing: {
        planner: [{ provider: 'claude', model: 'haiku' }],
        builder: [{ provider: 'claude', model: 'haiku' }],
        reviewer: [{ provider: 'codex' }],
      },
      adaptiveTeam: false,
      maxAttempts: 3,
      askPolicy: 'decide',
    });
    // A decision the builder never saw: the reviewer should ask for it, the fix lands on top.
    await waitFor(page, () => tasks(id).some((t) => t.status === 'building'), 10 * 60_000, 3_000);
    await api(
      'decisions.add',
      id,
      'Documentation',
      'Every exported function has a JSDoc comment that includes one @example line.',
    );
    await waitFor(page, () => finished(id), 30 * 60_000);
    await shot('done');
    const log = events(id).map((e) => e.message);
    const sentBack = log.find((m) => /^Sent back \(/.test(m));
    check('22: the reviewer asked for a change', Boolean(sentBack), sentBack?.slice(0, 200) ?? '');
    check(
      '22: the send-back kept the work',
      log.some((m) => m.includes('the next attempt continues from')),
      '',
    );
    check(
      '22: the retry continued from it',
      log.some((m) => m.startsWith('Continuing from')),
      log.filter((m) => /^(Building|Attempt|Continuing)/.test(m)).join(' | '),
    );
    const t = tasks(id);
    check(
      '22: it merged',
      t.some((x) => x.status === 'merged'),
      t.map((x) => `${x.title}: ${x.status}`).join('; '),
    );
    const clamp = readClamp(dir);
    check('22: the fix is in the merged code', /@example/.test(clamp), clamp.slice(0, 120));
  } finally {
    console.log(`\nSCENARIO 22: ${checks.filter((c) => c.ok).length} of ${checks.length} passed`);
    await app.close();
  }
  expect(checks.filter((c) => !c.ok)).toEqual([]);
});

function readClamp(dir: string): string {
  try {
    return execFileSync('git', ['show', 'plenum/integration:clamp.js'], {
      cwd: dir,
      encoding: 'utf8',
    });
  } catch {
    try {
      return readFileSync(join(dir, 'clamp.js'), 'utf8');
    } catch {
      return '';
    }
  }
}

// ── 23: the only reviewer is unavailable after a build; it parks and is reviewed without a rebuild
test('scenario 23: a tested build parks until a reviewer is free', async () => {
  test.skip(!which.includes('23'), 'set PLENUM_SCENARIO=23 to run');
  test.setTimeout(40 * 60_000);
  const { checks, check } = checker();
  const { app, page, shot, api } = await launch('23');
  try {
    const name = `parked-${stamp}`;
    const id = await start(page, api, {
      repoPath: clampRepo('23', name),
      name,
      goal: GOAL,
      routing: {
        planner: [{ provider: 'claude', model: 'haiku' }],
        builder: [{ provider: 'claude', model: 'haiku' }],
        reviewer: [{ provider: 'codex' }],
      },
      adaptiveTeam: false,
      askPolicy: 'decide',
    });
    // Codex, the only reviewer, gets quiet hours while the build runs: nothing new starts on it.
    await waitFor(page, () => tasks(id).some((t) => t.status === 'building'), 10 * 60_000, 3_000);
    const now = Date.now();
    await api('settings.update', {
      limits: {
        quietHours: [
          {
            days: [0, 1, 2, 3, 4, 5, 6],
            from: hhmm(new Date(now - 60 * 60_000)),
            to: hhmm(new Date(now + 60 * 60_000)),
            providers: ['codex'],
          },
        ],
      },
    });
    const parked = await waitFor(
      page,
      () => events(id).some((e) => /parked until a reviewer/.test(e.message)),
      20 * 60_000,
      5_000,
    );
    await shot('parked');
    check('23: the tested build parked', parked, status(id).status_reason ?? '');
    const label = await page
      .getByText('Built, waiting for a reviewer')
      .first()
      .isVisible()
      .catch(() => false);
    check('23: the task list says it is waiting for a reviewer', label, '');
    const builds = () =>
      events(id).filter((e) => /^(Building|Attempt \d+):/.test(e.message)).length;
    const before = builds();
    await api('settings.update', { limits: { quietHours: [] } });
    await waitFor(page, () => finished(id), 20 * 60_000);
    await shot('done');
    const log = events(id).map((e) => e.message);
    check(
      '23: it was reviewed from the parked build',
      log.some((m) => m.startsWith('Resuming the parked build')),
      '',
    );
    check('23: nothing was built again', builds() === before, `${before} → ${builds()} builds`);
    const t = tasks(id);
    check(
      '23: it merged, reviewed by Codex',
      t.some((x) => x.status === 'merged' && x.reviewed_by === 'codex'),
      t.map((x) => `${x.title}: ${x.status}, reviewed by ${x.reviewed_by}`).join('; '),
    );
  } finally {
    await api('settings.update', { limits: { quietHours: [] } }).catch(() => undefined);
    console.log(`\nSCENARIO 23: ${checks.filter((c) => c.ok).length} of ${checks.length} passed`);
    await app.close();
  }
  expect(checks.filter((c) => !c.ok)).toEqual([]);
});
