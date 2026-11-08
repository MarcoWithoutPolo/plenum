/**
 * The soak (v1.0 Q4): a project with three lanes runs on fake AIs with seeded chaos (failed
 * runs, usage limits, slow answers) for hours, and the process is killed outright every so often
 * and started again. The planner keeps adding batches of 40 tasks until the time is up. It
 * passes when every task merged, nothing merged was ever requeued, the integration branch has
 * every task's file, no worktree is left over, memory stays flat and the database stays small.
 *
 *   npx tsx --conditions=development bench/soak.ts --minutes 10 --restart-every 2
 *   npx tsx --conditions=development bench/soak.ts --minutes 1440 --restart-every 120
 *
 * Results: bench/results/soak-<stamp>/ (summary.md, memory.jsonl, the worker logs).
 */
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  Brain,
  Engine,
  FakeAdapter,
  Store,
  createProject,
  openDatabase,
  type RunRequest,
} from '@conclave/core';

const here = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({
  options: {
    minutes: { type: 'string', default: '10' },
    'restart-every': { type: 'string', default: '2' },
    seed: { type: 'string', default: '1' },
    batch: { type: 'string', default: '40' },
    // Worker mode (spawned by the orchestrator).
    worker: { type: 'boolean', default: false },
    home: { type: 'string' },
    project: { type: 'string' },
    until: { type: 'string' },
    out: { type: 'string' },
  },
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Soak',
      '-c',
      'user.email=soak@example.com',
      '-c',
      'core.autocrlf=false',
      ...args,
    ],
    { cwd, encoding: 'utf8' },
  ).trim();

/** A small seeded generator (mulberry32), so a failing soak can be replayed. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const APPROVE = '{"approve": true, "issues": [], "summary": "ok"}';
const DONE = '{"done": true, "reason": "the soak is over"}';
const BUSY = ['building', 'verifying', 'reviewing', 'merging'];

if (values.worker) await worker();
else await orchestrate();

/** One process's share: run the project until it's done or this process is killed. */
async function worker(): Promise<void> {
  const home = values.home!;
  const until = Number(values.until);
  const batch = Number(values.batch);
  const random = rng(Number(values.seed) + process.pid);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const attempts = new Map<string, number>();
  const item = (req: RunRequest) => /item-(\d+)/.exec(req.prompt)?.[1];

  // Chaos, by role: a builder's first two attempts at a task may fail or hit a limit; every
  // answer takes 20–400 ms.
  const builder = new FakeAdapter(
    {
      reply: 'Done.',
      act: async (req) => {
        await sleep(20 + random() * 380);
        const n = item(req);
        if (!n) return;
        mkdirSync(join(req.cwd, 'items'), { recursive: true });
        writeFileSync(join(req.cwd, 'items', `item-${n}.txt`), `${n}\n`);
      },
      failWhen: (req) => {
        const n = item(req) ?? '';
        const tries = (attempts.get(n) ?? 0) + 1;
        attempts.set(n, tries);
        return tries <= 2 && random() < 0.1 ? 'chaos: the CLI crashed' : undefined;
      },
      limitWhen: () =>
        random() < 0.03
          ? { message: 'Rate limit reached (chaos)', resetsAt: Date.now() + 3000 }
          : undefined,
    },
    // Not recording requests: a day of prompts held in memory is the harness's growth, not
    // Conclave's (the 2026-11-07 soak's "heap grew" flags).
    { id: 'codex', record: false },
  );
  const engine = new Engine({
    home,
    adapters: [
      new FakeAdapter(
        {
          reply: (req) => {
            if (req.role === 'reviewer') return APPROVE;
            if (req.role !== 'planner') return 'ok';
            // A new batch whenever the queue runs dry, until the time is up.
            const tasks = engine.store.projects.listTasks(values.project!);
            if (Date.now() > until) return DONE;
            if (tasks.some((t) => t.status === 'queued')) return '{"done": false, "tasks": []}';
            const start = tasks.length;
            return JSON.stringify({
              done: false,
              tasks: Array.from({ length: batch }, (_, i) => ({
                title: `Add item ${start + i}`,
                spec: `Create items/item-${start + i}.txt containing ${start + i}.`,
              })),
            });
          },
          delayMs: 5,
        },
        { id: 'claude', record: false },
      ),
      builder,
      new FakeAdapter({ reply: APPROVE, delayMs: 5 }, { id: 'gemini', record: false }),
    ],
  });
  const memory = join(values.out!, 'memory.jsonl');
  // What's still in use after a collection, so a real leak isn't confused with a lazy collector.
  const sample = () => {
    (globalThis as { gc?: () => void }).gc?.();
    const { rss, heapUsed, external } = process.memoryUsage();
    const tasks = engine.store.projects.listTasks(values.project!).length;
    appendFileSync(
      memory,
      JSON.stringify({ at: Date.now(), pid: process.pid, rss, heapUsed, external, tasks }) + '\n',
    );
  };
  sample();
  setInterval(sample, 30_000).unref();
  const brain = new Brain(engine, values.project!, { home });
  const outcome = await brain.run();
  console.log(`worker ${process.pid}: ${outcome.kind}`);
  engine.close();
}

/** Start workers, kill each after a while, check the invariants between them, then report. */
async function orchestrate(): Promise<void> {
  const minutes = Number(values.minutes);
  const restartEvery = Number(values['restart-every']) * 60_000;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const out = join(here, 'results', `soak-${stamp}`);
  mkdirSync(out, { recursive: true });
  const home = mkdtempSync(join(tmpdir(), 'conclave-soak-home-'));
  const repo = mkdtempSync(join(tmpdir(), 'conclave-soak-repo-'));
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), '# soak\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');

  const db = join(home, 'conclave.db');
  const setupStore = new Store(openDatabase(db));
  const project = await createProject(
    setupStore,
    [{ provider: 'claude' }, { provider: 'codex' }, { provider: 'gemini' }],
    {
      repoPath: repo,
      goal: 'Add the items, one file each.',
      testCommand: 'node --version',
      routing: {
        planner: [{ provider: 'claude' }],
        builder: [{ provider: 'codex' }],
        reviewer: [{ provider: 'gemini' }, { provider: 'claude' }],
      },
      maxParallel: 3,
      maxAttempts: 5,
      visualReview: false,
      adaptiveTeam: false,
    },
  );
  setupStore.close();
  const until = Date.now() + minutes * 60_000;
  const problems: string[] = [];
  let merged = new Set<string>();
  let restarts = 0;

  const check = (final: boolean) => {
    const store = new Store(openDatabase(db));
    try {
      const tasks = store.projects.listTasks(project.id);
      const now = new Set(tasks.filter((t) => t.status === 'merged').map((t) => t.id));
      for (const id of merged)
        if (!now.has(id))
          problems.push(
            `Task ${id} was merged, then went back to ${tasks.find((t) => t.id === id)?.status}`,
          );
      merged = now;
      if (final) {
        const left = tasks.filter((t) => t.status !== 'merged');
        if (left.length)
          problems.push(
            `${left.length} task(s) not merged: ${left
              .slice(0, 5)
              .map((t) => `${t.title} (${t.status})`)
              .join(', ')}`,
          );
        const busy = tasks.filter((t) => BUSY.includes(t.status));
        if (busy.length) problems.push(`${busy.length} task(s) left busy`);
      }
      return { tasks: tasks.length, merged: now.size };
    } finally {
      store.close();
    }
  };

  const log = join(out, 'workers.log');
  const runWorker = (killAfter: number | null) =>
    new Promise<number | null>((resolve) => {
      const child = spawn(
        process.execPath,
        [
          '--expose-gc',
          '--conditions=development',
          '--import',
          'tsx',
          fileURLToPath(import.meta.url),
          '--worker',
          '--home',
          home,
          '--project',
          project.id,
          '--until',
          String(until),
          '--seed',
          values.seed!,
          '--batch',
          values.batch!,
          '--out',
          out,
        ],
        { cwd: join(here, '..'), stdio: ['ignore', 'pipe', 'pipe'] },
      );
      child.stdout.on('data', (d: Buffer) => appendFileSync(log, d));
      child.stderr.on('data', (d: Buffer) => appendFileSync(log, d));
      const timer =
        killAfter === null
          ? null
          : setTimeout(() => {
              restarts++;
              child.kill('SIGKILL');
            }, killAfter);
      child.on('exit', (code) => {
        if (timer) clearTimeout(timer);
        resolve(code);
      });
    });

  console.log(`Soak: ${minutes} min, killed every ${restartEvery / 60_000} min, results in ${out}`);
  // Killed outright every interval until the time is up; the last one finishes the project.
  while (Date.now() + restartEvery < until) {
    await runWorker(restartEvery);
    const c = check(false);
    console.log(`  restart ${restarts}: ${c.merged}/${c.tasks} merged`);
  }
  const code = await runWorker(null);
  if (code !== 0) problems.push(`The last worker exited with ${code}`);
  const final = check(true);

  // Every merged task's file is on the integration branch.
  const files = git(repo, 'ls-tree', '--name-only', 'conclave/integration', 'items/')
    .split('\n')
    .filter(Boolean).length;
  if (files !== final.merged)
    problems.push(`${files} item files on the branch for ${final.merged} merged tasks`);
  const worktrees = git(repo, 'worktree', 'list', '--porcelain')
    .split('\n')
    .filter((l) => l.startsWith('worktree ')).length;
  // The repo's own checkout and the integration worktree stay; anything else is left over.
  if (worktrees > 2) problems.push(`${worktrees - 2} worktree(s) left over`);

  // Memory stays flat, within each worker's life (restarts would hide a leak) and overall: the
  // last fifth of the samples against the first fifth. A power cut can leave a torn last line.
  const samples = (await import('node:fs'))
    .readFileSync(join(out, 'memory.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('{') && l.endsWith('}'))
    .map((l) => JSON.parse(l) as { rss: number; heapUsed: number; pid: number; at: number });
  for (const pid of new Set(samples.map((s) => s.pid))) {
    // Settled first: the first ten minutes are start-up.
    const life = samples.filter((s) => s.pid === pid);
    const settled = life.filter((s) => s.at - life[0]!.at > 10 * 60_000);
    if (settled.length < 20) continue;
    const from = settled[0]!.heapUsed / 1e6;
    const to = settled.at(-1)!.heapUsed / 1e6;
    if (to > from * 1.5 + 20)
      problems.push(
        `Worker ${pid}: heap in use grew from ${from.toFixed(0)} to ${to.toFixed(0)} MB`,
      );
  }
  const fifth = Math.max(1, Math.floor(samples.length / 5));
  const avg = (xs: { rss: number }[]) => xs.reduce((n, s) => n + s.rss, 0) / xs.length / 1e6;
  const early = avg(samples.slice(0, fifth));
  const late = avg(samples.slice(-fifth));
  if (late > early * 1.5 + 50)
    problems.push(`Memory grew from ${early.toFixed(0)} MB to ${late.toFixed(0)} MB`);
  const dbMb =
    (statSync(db).size + (statSync(`${db}-wal`, { throwIfNoEntry: false })?.size ?? 0)) / 1e6;
  if (dbMb > 200) problems.push(`The database is ${dbMb.toFixed(0)} MB`);

  const md = [
    `# Soak (${stamp})`,
    '',
    `${minutes} minutes · killed and restarted ${restarts} times · seed ${values.seed}`,
    '',
    `- Tasks: ${final.tasks}, merged ${final.merged}`,
    `- Item files on the integration branch: ${files}`,
    `- Memory (RSS): ${early.toFixed(0)} MB early, ${late.toFixed(0)} MB late`,
    `- Database: ${dbMb.toFixed(1)} MB`,
    '',
    problems.length ? `**Failed:**\n\n${problems.map((p) => `- ${p}`).join('\n')}` : '**Passed.**',
    '',
  ].join('\n');
  writeFileSync(join(out, 'summary.md'), md);
  console.log(md);
  process.exitCode = problems.length ? 1 : 0;
}
