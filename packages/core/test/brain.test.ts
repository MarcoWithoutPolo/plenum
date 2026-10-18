import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderId, RunRequest } from '../src/index.js';
import {
  Brain,
  FakeAdapter,
  Governor,
  Store,
  adapterMap,
  createProject,
  displayCommand,
  displayPath,
  parsePlan,
  parseReview,
} from '../src/index.js';

const cleanup: string[] = [];
afterEach(() => {
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'core.autocrlf=false',
      ...args,
    ],
    {
      cwd,
      encoding: 'utf8',
    },
  ).trim();

/** A tiny repo whose test command checks that sum.js adds numbers. */
function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'conclave-repo-'));
  cleanup.push(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), '# demo\n');
  writeFileSync(
    join(repo, 'check.js'),
    `const fs = require('fs');
if (!fs.existsSync('sum.js')) { console.error('sum.js is missing'); process.exit(1); }
const sum = require('./sum.js');
if (sum(2, 3) !== 5) { console.error('sum(2, 3) should be 5, got ' + sum(2, 3)); process.exit(1); }
console.log('ok');
`,
  );
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  return repo;
}

const writeSum = (body: string) => (req: RunRequest) => {
  writeFileSync(join(req.cwd, 'sum.js'), `module.exports = (a, b) => ${body};\n`);
};

const PLAN = JSON.stringify({
  done: false,
  tasks: [{ title: 'Add sum', spec: 'Create sum.js exporting (a, b) => a + b.' }],
});
const DONE = '```json\n{"done": true, "reason": "sum.js works"}\n```';
const APPROVE = '{"approve": true, "issues": [], "summary": "Looks right"}';

interface Setup {
  claude?: ConstructorParameters<typeof FakeAdapter>[0];
  codex?: ConstructorParameters<typeof FakeAdapter>[0];
  maxAttempts?: number;
}

async function setup(opts: Setup = {}) {
  const repo = makeRepo();
  const home = mkdtempSync(join(tmpdir(), 'conclave-home-'));
  cleanup.push(home);
  const store = new Store(':memory:');
  let plans = 0;
  const claude = new FakeAdapter(
    opts.claude ?? {
      reply: (req) => (req.role === 'planner' ? (plans++ === 0 ? PLAN : DONE) : APPROVE),
    },
    { id: 'claude' },
  );
  const codex = new FakeAdapter(opts.codex ?? { reply: 'Created sum.js', act: writeSum('a + b') }, {
    id: 'codex',
  });
  const adapters = adapterMap([claude, codex]);
  const ready = [{ provider: 'claude' as ProviderId }, { provider: 'codex' as ProviderId }];
  const project = await createProject(store, ready, {
    repoPath: repo,
    goal: 'Ship a working sum function',
    testCommand: 'node check.js',
    ...(opts.maxAttempts && { maxAttempts: opts.maxAttempts }),
  });
  const brain = new Brain({ store, adapters, cwd: home }, project.id, { home });
  return { repo, home, store, claude, codex, project, brain };
}

describe('Brain', () => {
  it('plans, builds, tests, reviews and merges, then reports the goal met', async () => {
    const { repo, store, brain, project, claude, codex } = await setup();
    const outcome = await brain.run({ maxRounds: 10 });

    expect(outcome.kind).toBe('done');
    const tasks = store.projects.listTasks(project.id);
    expect(tasks.map((t) => [t.title, t.status, t.builtBy, t.reviewedBy])).toEqual([
      ['Add sum', 'merged', 'codex', 'claude'],
    ]);

    // The work is on the integration branch; the user's checkout is untouched.
    expect(git(repo, 'show', 'conclave/integration:sum.js')).toContain('a + b');
    expect(existsSync(join(repo, 'sum.js'))).toBe(false);
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(git(repo, 'log', '--oneline', 'main')).not.toContain('conclave');

    // Roles: Claude planned and reviewed (read-only), Codex built (may write).
    expect(codex.requests.map((r) => [r.role, r.readOnly])).toEqual([['builder', false]]);
    expect(claude.requests.map((r) => r.role)).toEqual(['planner', 'reviewer', 'planner']);
    expect(claude.requests[1]!.prompt).toContain('+module.exports = (a, b) => a + b;');

    expect(store.projects.get(project.id)?.status).toBe('done');
    const approvals = store.projects.approvals(project.id, 'pending');
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.kind).toBe('push');

    const kinds = store.projects.events(project.id).map((e) => e.kind);
    expect(kinds).toEqual(
      expect.arrayContaining([
        'start',
        'plan',
        'task',
        'commit',
        'verify',
        'review',
        'merge',
        'done',
        'approval',
      ]),
    );
  });

  it('sends failing work back with the test output, then merges the fix', async () => {
    let attempt = 0;
    const { store, brain, project, codex } = await setup({
      codex: {
        reply: 'done',
        act: (req) => writeSum(attempt++ === 0 ? 'a - b' : 'a + b')(req),
      },
    });
    const outcome = await brain.run({ maxRounds: 10 });

    expect(outcome.kind).toBe('done');
    const [task] = store.projects.listTasks(project.id);
    expect(task?.status).toBe('merged');
    expect(task?.attempts).toBe(1);
    expect(codex.requests[1]!.prompt).toContain('THE PREVIOUS ATTEMPT WAS SENT BACK');
    expect(codex.requests[1]!.prompt).toContain('sum(2, 3) should be 5, got -1');
  });

  it('passes reviewer issues to the next attempt', async () => {
    let plans = 0;
    let reviews = 0;
    const { store, brain, project, codex } = await setup({
      claude: {
        reply: (req) =>
          req.role === 'planner'
            ? plans++ === 0
              ? PLAN
              : DONE
            : reviews++ === 0
              ? '{"approve": false, "issues": ["Add a comment explaining sum"], "summary": "Almost"}'
              : APPROVE,
      },
    });
    await brain.run({ maxRounds: 10 });
    expect(store.projects.listTasks(project.id)[0]?.status).toBe('merged');
    expect(codex.requests[1]!.prompt).toContain('Add a comment explaining sum');
  });

  it('gives up on a task after maxAttempts and keeps going', async () => {
    const { store, brain, project } = await setup({
      codex: { reply: 'done', act: writeSum('a * b') },
      maxAttempts: 2,
    });
    const outcomes = [];
    for (let i = 0; i < 3; i++) outcomes.push((await brain.round()).kind);
    expect(outcomes).toEqual(['planned', 'retry', 'failed']);
    const [task] = store.projects.listTasks(project.id);
    expect(task?.status).toBe('failed');
    expect(task?.feedback).toContain('should be 5, got 6');
  });

  it('routes building to the next provider when one hits its usage limit', async () => {
    let plans = 0;
    const { store, brain, project, claude, codex } = await setup({
      codex: {
        reply: '',
        limitWhen: () => ({ message: 'Codex weekly limit', resetsAt: Date.now() + 3_600_000 }),
      },
      claude: {
        reply: (req) =>
          req.role === 'planner'
            ? plans++ === 0
              ? PLAN
              : DONE
            : req.role === 'builder'
              ? 'built'
              : APPROVE,
        act: (req) => {
          if (req.role === 'builder') writeSum('a + b')(req);
        },
      },
    });
    const outcome = await brain.run({ maxRounds: 10 });
    expect(outcome.kind).toBe('done');
    expect(codex.requests).toHaveLength(1);
    expect(claude.requests.map((r) => r.role)).toContain('builder');
    const [task] = store.projects.listTasks(project.id);
    expect(task?.builtBy).toBe('claude');
    // Nobody else was free, so Claude also reviewed its own work, and said so.
    expect(
      store.projects.events(project.id).some((e) => e.message.includes('no other provider free')),
    ).toBe(true);
  });

  it('waits until the earliest reset when every provider is out of headroom', async () => {
    const { store, project } = await setup();
    const resetsAt = Date.now() + 2 * 3_600_000;
    for (const provider of ['claude', 'codex'] as const) {
      store.recordQuota({
        provider,
        window: 'five_hour',
        utilization: 0.97,
        resetsAt,
        at: Date.now(),
      });
    }
    const brain = new Brain({ store, adapters: adapterMap([]), cwd: '.' }, project.id, {
      home: mkdtempSync(join(tmpdir(), 'conclave-home-')),
    });
    const slept: number[] = [];
    const outcome = await brain.run({ maxRounds: 2, sleep: async (ms) => void slept.push(ms) });
    expect(outcome).toMatchObject({ kind: 'waiting', until: resetsAt });
    expect(slept).toHaveLength(2);
    expect(slept[0]).toBeGreaterThan(29 * 60_000); // capped at 30 minutes per nap
    expect(store.projects.get(project.id)?.status).toBe('running');
  });

  it('puts interrupted tasks back in the queue on restart', async () => {
    const { store, brain, project, home } = await setup();
    await brain.round(); // plan
    const [task] = store.projects.listTasks(project.id);
    store.projects.updateTask(task!.id, { status: 'building' }); // as if the app crashed mid-build

    const restarted = new Brain(
      {
        store,
        adapters: adapterMap([
          new FakeAdapter({ reply: APPROVE }, { id: 'claude' }),
          new FakeAdapter({ reply: 'x', act: writeSum('a + b') }, { id: 'codex' }),
        ]),
        cwd: home,
      },
      project.id,
      { home },
    );
    await restarted.start();
    expect(store.projects.getTask(task!.id)?.status).toBe('queued');
    expect(store.projects.events(project.id).at(-1)?.message).toContain('1 interrupted task');
    expect((await restarted.round()).kind).toBe('merged');
  });

  it('stops when the project is stopped', async () => {
    const { store, brain, project } = await setup();
    await brain.round();
    brain.stop('Stopped by you');
    expect(await brain.round()).toEqual({ kind: 'stopped', reason: 'Stopped by you' });
    expect(store.projects.get(project.id)?.status).toBe('stopped');
  });

  it('sends back an attempt that changed nothing', async () => {
    const { brain } = await setup({ codex: { reply: 'Nothing to do' } });
    await brain.round();
    const outcome = await brain.round();
    expect(outcome).toMatchObject({
      kind: 'retry',
      reason: 'No files were changed. Make the change the task asks for.',
    });
  });

  it('refuses a folder that is not a git repository', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'conclave-norepo-'));
    cleanup.push(dir);
    await expect(
      createProject(new Store(':memory:'), [{ provider: 'claude' }], { repoPath: dir, goal: 'x' }),
    ).rejects.toThrow(/not a git repository/);
  });

  it('keeps the merged result readable from the integration worktree', async () => {
    const { home, project, brain } = await setup();
    await brain.run({ maxRounds: 10 });
    const integration = join(home, 'projects', project.id, 'integration', 'sum.js');
    expect(readFileSync(integration, 'utf8')).toContain('a + b');
  });
});

describe('Governor', () => {
  const reading = (provider: ProviderId, utilization: number, resetsAt: number | null, at = 0) => ({
    provider,
    window: 'five_hour',
    utilization,
    resetsAt,
    at,
  });

  it('skips providers near their limit and ignores readings past their reset', () => {
    let now = 1_000;
    const readings = [reading('codex', 0.95, 5_000)];
    const g = new Governor(() => readings, { now: () => now });
    expect(g.pick([{ provider: 'codex' }, { provider: 'claude' }])).toEqual({
      seat: { provider: 'claude' },
    });
    now = 6_000;
    expect(g.pick([{ provider: 'codex' }, { provider: 'claude' }])).toEqual({
      seat: { provider: 'codex' },
    });
  });

  it('backs off after a limit without a reset time, doubling each time', () => {
    let now = 0;
    const g = new Governor(() => [], { now: () => now, baseBackoffMs: 1000 });
    g.observe('codex', { ok: false, rateLimited: { message: 'limit' } });
    expect(g.availability('codex')).toEqual({ ok: false, reason: 'limit', until: 1000 });
    now = 1000;
    g.observe('codex', { ok: false, rateLimited: { message: 'limit' } });
    expect(g.availability('codex')).toMatchObject({ until: 3000 });
    g.observe('codex', { ok: true });
    expect(g.availability('codex')).toEqual({ ok: true });
  });

  it('prefers providers not in the avoid list, falling back to them', () => {
    const g = new Governor(() => []);
    expect(g.pick([{ provider: 'claude' }, { provider: 'codex' }], ['claude'])).toEqual({
      seat: { provider: 'codex' },
    });
    expect(g.pick([{ provider: 'claude' }], ['claude'])).toEqual({ seat: { provider: 'claude' } });
  });

  it('reports the earliest reset when nobody is free', () => {
    const g = new Governor(
      () => [reading('claude', 1, 9_000, 0), reading('codex', 0.99, 4_000, 0)],
      { now: () => 0 },
    );
    expect(g.pick([{ provider: 'claude' }, { provider: 'codex' }])).toMatchObject({
      seat: null,
      until: 4_000,
    });
  });
});

describe('agent replies', () => {
  it('reads plans from fenced, bare or wrapped JSON', () => {
    expect(parsePlan(DONE, 5)).toEqual({ done: true, reason: 'sum.js works' });
    expect(parsePlan(`Sure! Here you go: ${PLAN} Let me know.`, 5)).toEqual({
      done: false,
      tasks: [{ title: 'Add sum', spec: 'Create sum.js exporting (a, b) => a + b.' }],
    });
    expect(
      parsePlan('{"tasks": [{"title": "", "spec": "x"}, {"title": "a", "spec": "b"}]}', 5),
    ).toEqual({
      done: false,
      tasks: [{ title: 'a', spec: 'b' }],
    });
    expect(parsePlan('no json here', 5)).toBeUndefined();
  });

  it('reads review verdicts', () => {
    expect(parseReview(APPROVE)).toEqual({ approve: true, issues: [], summary: 'Looks right' });
    expect(parseReview('{"approve": "yes"}')).toBeUndefined();
  });
});

describe('log formatting', () => {
  it('strips shell wrappers from commands', () => {
    expect(
      displayCommand(
        '"C:\\\\WINDOWS\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -Command \'npm.cmd test\'',
      ),
    ).toBe('npm.cmd test');
    expect(displayCommand('/bin/bash -lc "npm test"')).toBe('npm test');
    expect(displayCommand('git status')).toBe('git status');
  });

  it('shows worktree paths relative to the worktree', () => {
    const cwd = join(tmpdir(), 'wt');
    expect(displayPath(join(cwd, 'src', 'a.js'), cwd)).toBe('src/a.js');
    expect(displayPath('b.js', cwd)).toBe('b.js');
  });
});
