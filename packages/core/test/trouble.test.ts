import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderId, RunRequest } from '../src/index.js';
import { adapterMap, Brain, createProject, FakeAdapter, Store } from '../src/index.js';

/**
 * The trouble suite (v0.9.2 L5): one project on fake AIs where every kind of trouble the loop
 * recovers from happens once. It must all merge within a fixed budget of builds and reviews, so a
 * change that brings back wasted work (rebuilding from nothing, re-reviewing, starting over on a
 * conflict) fails here, in seconds and without spending any usage.
 */

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
    { cwd, encoding: 'utf8' },
  ).trim();

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'conclave-trouble-'));
  cleanup.push(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'legacy.js'), 'module.exports = "old";\n');
  writeFileSync(
    join(repo, 'check.js'),
    `const fs = require('fs');
if (fs.existsSync('sum.js') && require('./sum.js')(2, 3) !== 5) { console.error('sum is wrong'); process.exit(1); }
if (fs.existsSync('mul.js') && require('./mul.js')(2, 3) !== 6) { console.error('mul is wrong'); process.exit(1); }
console.log('ok');
`,
  );
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  return repo;
}

const PLAN = JSON.stringify({
  done: false,
  tasks: [
    { title: 'Add sum', spec: 'sum.js exports (a, b) => a + b.' },
    { title: 'Add mul', spec: 'mul.js exports (a, b) => a * b.' },
    { title: 'Remove legacy', spec: 'Delete legacy.js.' },
    { title: 'Add notes', spec: 'notes.txt says what the module does.' },
  ],
});
const DONE = '{"done": true, "reason": "all four tasks are in"}';
const APPROVE = '{"approve": true, "issues": [], "summary": "Looks right"}';
const task = (req: RunRequest) => /^(?:YOUR )?TASK: (.+)$/m.exec(req.prompt)?.[1] ?? '';
const integrationTree = (repo: string) =>
  git(repo, 'worktree', 'list', '--porcelain')
    .split('\n\n')
    .find((w) => w.includes('branch refs/heads/conclave/integration'))!
    .split('\n')[0]!
    .slice('worktree '.length);

describe('Trouble suite (v0.9.2)', () => {
  it('recovers from every kind of trouble within its budget', async () => {
    const repo = makeRepo();
    const home = mkdtempSync(join(tmpdir(), 'conclave-home-'));
    cleanup.push(home);
    const seen = new Map<string, number>();
    const once = (key: string) => {
      const n = seen.get(key) ?? 0;
      seen.set(key, n + 1);
      return n === 0;
    };

    // Builders (Codex first, Claude as the fallback) share one script.
    const build = async (req: RunRequest): Promise<void> => {
      const t = task(req);
      if (t === 'Add sum') {
        // Trouble: the first build fails the tests.
        const body = once('sum') ? 'a - b' : 'a + b';
        writeFileSync(join(req.cwd, 'sum.js'), `module.exports = (a, b) => ${body};\n`);
      } else if (t === 'Add mul') {
        // Trouble: the first build hangs past the stall watchdog.
        if (once('mul-stall')) await sleep(1_500);
        const extra = seen.get('mul-review') ? ' // checked' : '';
        writeFileSync(join(req.cwd, 'mul.js'), `module.exports = (a, b) => a * b;${extra}\n`);
      } else if (t === 'Add notes') {
        writeFileSync(join(req.cwd, 'notes.txt'), 'Adds and multiplies numbers.\n');
      }
    };
    const builderReply = (req: RunRequest) =>
      task(req) === 'Remove legacy' ? 'Removed it.\nDELETE: legacy.js' : 'Done.';

    const review = (req: RunRequest): string => {
      const t = task(req);
      // Trouble: the first review of mul asks for a change.
      if (t === 'Add mul' && once('mul-review'))
        return '{"approve": false, "issues": ["Note that mul was checked"], "summary": "Almost"}';
      if (t === 'Remove legacy' && existsSync(join(req.cwd, 'legacy.js')))
        return '{"approve": false, "issues": ["legacy.js is still there"], "summary": "Not deleted"}';
      // Trouble: newer work lands while notes is reviewed, so its merge conflicts.
      if (t === 'Add notes' && once('notes-conflict')) {
        const tree = integrationTree(repo);
        writeFileSync(join(tree, 'notes.txt'), 'Written by someone else.\n');
        git(tree, 'add', '-A');
        git(tree, 'commit', '-q', '-m', 'newer notes');
      }
      return APPROVE;
    };

    let plans = 0;
    const claude = new FakeAdapter(
      {
        reply: (req) =>
          req.role === 'planner'
            ? plans++ === 0
              ? PLAN
              : DONE
            : req.role === 'reviewer'
              ? review(req)
              : builderReply(req),
        act: (req) => (req.role === 'builder' ? build(req) : undefined),
      },
      { id: 'claude' },
    );
    const codex = new FakeAdapter(
      { reply: builderReply, act: build },
      { id: 'codex', quietMs: 400, efforts: ['low', 'medium', 'high'] },
    );
    // Gemini fails as a planner, and its first review hits a limit that lifts a second later.
    const gemini = new FakeAdapter(
      {
        reply: (req) => (req.role === 'reviewer' ? review(req) : ''),
        failWhen: (req) => (req.role === 'planner' ? 'Gemini crashed' : undefined),
        limitWhen: (req) =>
          req.role === 'reviewer' && once('gemini-limit')
            ? { message: 'Quota exceeded. Try later.', resetsAt: Date.now() + 1_000 }
            : undefined,
      },
      { id: 'gemini' },
    );
    const store = new Store(':memory:');
    const ids: ProviderId[] = ['claude', 'codex', 'gemini'];
    const project = await createProject(
      store,
      ids.map((provider) => ({ provider })),
      {
        repoPath: repo,
        goal: 'Small math module',
        testCommand: 'node check.js',
        maxAttempts: 3,
        routing: {
          planner: [{ provider: 'gemini' }, { provider: 'claude' }],
          builder: [{ provider: 'codex' }, { provider: 'claude' }],
          reviewer: [{ provider: 'gemini' }, { provider: 'claude' }],
        },
      },
    );
    const brain = new Brain(
      { store, adapters: adapterMap([claude, codex, gemini]), cwd: home },
      project.id,
      { home },
    );

    // Waits are real but short: the only one is for Gemini's one-second limit.
    const outcome = await brain.run({ maxRounds: 40, sleep: (ms) => sleep(Math.min(ms, 2_000)) });
    const log = store.projects.events(project.id).map((e) => e.message);
    expect(outcome.kind, log.join('\n')).toBe('done');

    const tasks = store.projects.listTasks(project.id);
    expect(tasks.map((t) => `${t.title}: ${t.status}`)).toEqual([
      'Add sum: merged',
      'Add mul: merged',
      'Remove legacy: merged',
      'Add notes: merged',
    ]);
    const files = git(repo, 'ls-tree', '--name-only', 'conclave/integration').split('\n');
    expect(files).not.toContain('legacy.js');
    expect(git(repo, 'show', 'conclave/integration:notes.txt')).not.toContain('<<<<<<<');

    // Every recovery happened, each the cheap way.
    const has = (re: RegExp) =>
      expect(
        log.some((m) => re.test(m)),
        `${re}\n${log.join('\n')}`,
      ).toBe(true);
    has(/^Gemini stopped .*; asking Claude instead|Gemini.*asking Claude instead/);
    has(/^Sent back \(1\/3\): The tests failed.*continues from/);
    has(/went quiet/);
    has(/asked for changes.*continues from/);
    has(/^Deleted legacy\.js as/);
    has(/^Merge conflict with newer work; the builder resolves it on this build$/);
    has(/conflicts in notes\.txt, which the builder resolves$/);
    expect(log.filter((m) => m.startsWith('Continuing from')).length).toBeGreaterThanOrEqual(3);
    // Resolving a conflict by keeping its own side still counts as resolving it.
    expect(log.some((m) => m.includes('changed nothing'))).toBe(false);

    // The budget: one build per task, plus one per trouble that needs a builder
    // (failed tests, the stall, the change request, the conflict); one review per task, plus the
    // limited one, the change request and the conflict.
    const runs = [claude, codex, gemini].flatMap((a) => a.requests);
    const builds = runs.filter((r) => r.role === 'builder').length;
    const reviews = runs.filter((r) => r.role === 'reviewer').length;
    expect(builds).toBeLessThanOrEqual(8);
    expect(reviews).toBeLessThanOrEqual(7);
  }, 120_000);
});
