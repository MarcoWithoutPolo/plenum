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
  builderPlan,
  countsAsAttempt,
  effortUp,
  parsePlan,
  parseReview,
  providerProblems,
  retryFailed,
  retryTask,
  sameWork,
  skipTask,
} from '../src/index.js';
import { taskProgress } from '@conclave/shared';

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
  retryStrategy?: 'same' | 'escalate' | 'ask';
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
    efforts: ['low', 'medium', 'high', 'xhigh'],
  });
  const adapters = adapterMap([claude, codex]);
  const ready = [{ provider: 'claude' as ProviderId }, { provider: 'codex' as ProviderId }];
  const project = await createProject(store, ready, {
    repoPath: repo,
    goal: 'Ship a working sum function',
    testCommand: 'node check.js',
    ...(opts.maxAttempts && { maxAttempts: opts.maxAttempts }),
    ...(opts.retryStrategy && { retryStrategy: opts.retryStrategy }),
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

  it('pauses instead of re-planning work that already failed', async () => {
    const { store, brain, project } = await setup({
      codex: { reply: 'done', act: writeSum('a * b') },
      claude: { reply: (req) => (req.role === 'planner' ? PLAN : APPROVE) },
      maxAttempts: 1,
    });
    const outcome = await brain.run({ maxRounds: 20 });
    expect(outcome).toMatchObject({
      kind: 'idle',
      reason: expect.stringContaining('already failed'),
    });
    expect(store.projects.listTasks(project.id)).toHaveLength(1);
    expect(store.projects.get(project.id)?.status).toBe('paused');
  });

  it('pauses after several tasks in a row fail', async () => {
    let n = 0;
    const { store, brain, project } = await setup({
      codex: { reply: 'done', act: writeSum('a * b') },
      claude: {
        reply: (req) =>
          req.role === 'planner'
            ? JSON.stringify({
                done: false,
                tasks: [{ title: `Try ${++n}`, spec: 'Create sum.js' }],
              })
            : APPROVE,
      },
      maxAttempts: 1,
    });
    const outcome = await brain.run({ maxRounds: 20 });
    expect(outcome).toMatchObject({
      kind: 'idle',
      reason: expect.stringContaining('3 tasks in a row failed'),
    });
    expect(store.projects.listTasks(project.id).map((t) => t.status)).toEqual([
      'failed',
      'failed',
      'failed',
    ]);
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

  it('moves work to the next builder when one hits a spend cap, without charging attempts', async () => {
    let plans = 0;
    const { store, brain, project } = await setup({
      codex: { reply: '', fail: 'You hit your spend cap set by the owner of your workspace.' },
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
    expect((await brain.run({ maxRounds: 10 })).kind).toBe('done');
    const [task] = store.projects.listTasks(project.id);
    expect(task).toMatchObject({ status: 'merged', builtBy: 'claude', attempts: 0 });
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
      reason: 'Codex finished without changing any files',
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

describe('Failure recovery', () => {
  it('records what kind of failure stopped an attempt, and whose problem it was', async () => {
    const { store, brain, project } = await setup({
      codex: { reply: 'done', act: writeSum('a * b') },
      maxAttempts: 1,
    });
    await brain.round();
    await brain.round();
    const [task] = store.projects.listTasks(project.id);
    expect(task).toMatchObject({ status: 'failed', attempts: 1 });
    expect(task?.lastFailure).toMatchObject({
      kind: 'tests',
      summary: 'The tests failed (exit 1)',
      provider: 'codex',
    });
    expect(task?.lastFailure?.detail).toContain('should be 5, got 6');
  });

  it('gives a CLI crash one free retry before it counts', async () => {
    let builds = 0;
    const { store, brain, project } = await setup({
      codex: {
        reply: 'done',
        act: writeSum('a + b'),
        failWhen: (req) =>
          req.role === 'builder' && builds++ === 0 ? 'socket hang up' : undefined,
      },
      maxAttempts: 1,
    });
    expect((await brain.run({ maxRounds: 10 })).kind).toBe('done');
    const [task] = store.projects.listTasks(project.id);
    expect(task).toMatchObject({ status: 'merged', attempts: 0, freeRetries: 1 });
    expect(
      store.projects
        .events(project.id)
        .some((e) => e.message.includes('not counted as an attempt')),
    ).toBe(true);
  });

  it('never counts a usage limit, gives conflicts two free rebuilds and crashes one', () => {
    expect(countsAsAttempt('limit', 0)).toBe(false);
    expect(countsAsAttempt('limit', 9)).toBe(false);
    expect(countsAsAttempt('conflict', 0)).toBe(false);
    expect(countsAsAttempt('conflict', 1)).toBe(false);
    expect(countsAsAttempt('conflict', 2)).toBe(true);
    expect(countsAsAttempt('crash', 0)).toBe(false);
    expect(countsAsAttempt('crash', 1)).toBe(true);
    expect(countsAsAttempt('tests', 0)).toBe(true);
    expect(countsAsAttempt('review', 0)).toBe(true);
    expect(countsAsAttempt('no_changes', 0)).toBe(true);
  });

  it('raises effort on attempt 2 and switches builder on attempt 3 when escalating', async () => {
    const { store, brain, project, codex, claude } = await setup({
      codex: { reply: 'done', act: writeSum('a * b') },
      claude: {
        reply: (req) =>
          req.role === 'planner' ? PLAN : req.role === 'builder' ? 'built' : APPROVE,
        act: (req) => {
          if (req.role === 'builder') writeSum('a * b')(req);
        },
      },
      maxAttempts: 3,
    });
    expect(store.projects.get(project.id)?.retryStrategy).toBe('escalate');
    store.projects.update(project.id, {
      routing: { ...project.routing, builder: [{ provider: 'codex' }, { provider: 'claude' }] },
    });
    for (let i = 0; i < 4; i++) await brain.round();
    const builds = [
      ...codex.requests.filter((r) => r.role === 'builder').map((r) => `codex@${r.effort ?? '-'}`),
      ...claude.requests
        .filter((r) => r.role === 'builder')
        .map((r) => `claude@${r.effort ?? '-'}`),
    ];
    expect(builds).toEqual(['codex@-', 'codex@high', 'claude@high']);
    const log = store.projects.events(project.id).map((e) => e.message);
    expect(log.some((m) => m.includes('Attempt 3') && m.includes('switching to Claude'))).toBe(
      true,
    );
  });

  it('keeps the same team with the "same" strategy', () => {
    const project = {
      routing: { builder: [{ provider: 'codex' }, { provider: 'claude' }] },
      retryStrategy: 'same',
    } as never;
    const task = { attempts: 2, builtBy: 'codex', pinnedSeat: null } as never;
    expect(builderPlan(project, task, new Map()).seats.map((s) => s.provider)).toEqual([
      'codex',
      'claude',
    ]);
  });

  it('steps effort up within what the provider supports', () => {
    expect(effortUp(undefined, ['low', 'medium', 'high'])).toBe('high');
    expect(effortUp('high', ['low', 'medium', 'high'])).toBe('high');
    expect(effortUp('high', undefined)).toBe('xhigh');
    expect(effortUp('xhigh', undefined, 'xhigh')).toBe('xhigh');
    expect(effortUp('low', ['low', 'medium'])).toBe('medium');
  });

  it('retries a failed task with a pinned seat and fresh attempts, for that task only', async () => {
    let plans = 0;
    const { store, brain, project, claude } = await setup({
      codex: {
        reply: (req) => (req.role === 'reviewer' ? APPROVE : 'done'),
        act: (req) => {
          if (req.role === 'builder') writeSum('a * b')(req);
        },
      },
      claude: {
        reply: (req) =>
          req.role === 'planner'
            ? plans++ === 0
              ? JSON.stringify({
                  done: false,
                  tasks: [
                    { title: 'Add sum', spec: 'Create sum.js' },
                    { title: 'Document it', spec: 'Add a README line' },
                  ],
                })
              : DONE
            : req.role === 'builder'
              ? 'built'
              : APPROVE,
        act: (req) => {
          if (req.role === 'builder') writeSum('a + b')(req);
        },
      },
      maxAttempts: 1,
    });
    await brain.round(); // plan
    await brain.round(); // Add sum fails on Codex
    const [first, second] = store.projects.listTasks(project.id);
    expect(first?.status).toBe('failed');

    const retried = retryTask(store.projects, first!.id, {
      seat: { provider: 'claude', effort: 'high' },
    });
    expect(retried).toMatchObject({
      status: 'queued',
      attempts: 0,
      pinnedSeat: { provider: 'claude' },
    });
    await brain.round();
    expect(store.projects.getTask(first!.id)?.status).toBe('merged');
    const build = claude.requests.find((r) => r.role === 'builder');
    expect(build?.effort).toBe('high');
    expect(store.projects.getTask(second!.id)?.pinnedSeat).toBeNull();
  });

  it('skips a task so it leaves the progress total', async () => {
    const { store, brain, project } = await setup({
      codex: { reply: 'done', act: writeSum('a * b') },
      maxAttempts: 1,
    });
    await brain.round();
    await brain.round();
    const [task] = store.projects.listTasks(project.id);
    expect(taskProgress(store.projects.listTasks(project.id))).toMatchObject({
      total: 1,
      failed: 1,
    });
    skipTask(store.projects, task!.id);
    expect(taskProgress(store.projects.listTasks(project.id))).toMatchObject({
      total: 0,
      failed: 0,
      skipped: 1,
    });
    expect(() => skipTask(store.projects, task!.id)).toThrow(/Only failed/);
  });

  it('finds a provider causing repeated failures and retries them all with another AI', async () => {
    const { store, project } = await setup();
    const tasks = store.projects.addTasks(project.id, [
      { title: 'One', spec: 'x' },
      { title: 'Two', spec: 'x' },
      { title: 'Three', spec: 'x' },
    ]);
    const crash = {
      kind: 'crash' as const,
      summary: 'Codex stopped with an error',
      detail: 'boom',
      provider: 'codex' as const,
      model: null,
      at: 1,
    };
    for (const t of tasks.slice(0, 2)) {
      store.projects.updateTask(t.id, { status: 'failed', attempts: 3, lastFailure: crash });
    }
    const problems = providerProblems(store.projects.listTasks(project.id));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ provider: 'codex', kind: 'crash' });
    expect(problems[0]?.tasks).toHaveLength(2);

    const retried = retryFailed(
      store.projects,
      project.id,
      { provider: 'codex' },
      { seat: { provider: 'claude' } },
    );
    expect(retried.map((t) => [t.title, t.status, t.pinnedSeat?.provider])).toEqual([
      ['One', 'queued', 'claude'],
      ['Two', 'queued', 'claude'],
    ]);
  });
});

describe('One piece of work, one task', () => {
  it('lets the planner take over a failed task by id, so the total does not grow', async () => {
    let plans = 0;
    let failedId = '';
    const { store, brain, project, claude } = await setup({
      codex: {
        reply: 'done',
        act: (req) => writeSum(req.prompt.includes('YOUR TASK: Add sum') ? 'a * b' : 'a + b')(req),
      },
      claude: {
        reply: (req) => {
          if (req.role !== 'planner') return APPROVE;
          plans++;
          if (plans === 1) return PLAN;
          if (plans === 2) {
            failedId = /- (k_\w+): Add sum/.exec(req.prompt)?.[1] ?? '';
            return JSON.stringify({
              done: false,
              tasks: [
                { title: 'Write sum.js from scratch', spec: 'Create sum.js', replaces: failedId },
              ],
            });
          }
          return DONE;
        },
      },
      maxAttempts: 1,
    });
    expect((await brain.run({ maxRounds: 10 })).kind).toBe('done');
    expect(failedId).toMatch(/^k_/);
    expect(claude.requests.filter((r) => r.role === 'planner')[1]?.prompt).toContain('"replaces"');
    const tasks = store.projects.listTasks(project.id);
    expect(tasks.map((t) => [t.title, t.status])).toEqual([
      ['Add sum', 'replaced'],
      ['Write sum.js from scratch', 'merged'],
    ]);
    expect(tasks[0]?.replacedBy).toBe(tasks[1]?.id);
    expect(taskProgress(tasks)).toMatchObject({ merged: 1, total: 1, failed: 0 });
  });

  it('links a re-proposal with a clearly similar title even without "replaces"', () => {
    expect(
      sameWork(
        'Add particle burst and screen shake on every button press',
        'Add particle burst on every press in fx.js',
      ),
    ).toBe(true);
    expect(
      sameWork(
        'Add combo counter with escalating effects and sound-free juice',
        'Add combo counter with timed decay and escalating tiers',
      ),
    ).toBe(true);
    expect(sameWork('Add tests for parser', 'Add tests for lexer')).toBe(false);
    expect(
      sameWork('Add fx.js hook called on every button activation', 'Add keyboard support'),
    ).toBe(false);
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
