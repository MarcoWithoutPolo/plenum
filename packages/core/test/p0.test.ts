import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunRequest } from '../src/index.js';
import { adapterMap, Brain, FakeAdapter, GitError, Store } from '../src/index.js';
import { git, setUp, TITLES, type CrashProject } from './crash/kit.js';

/** The v1.0 P0 bugs (docs/BUGS-v1.0.md E1, E2, E4); E3 is in crash.test.ts. */

const cleanup: string[] = [];
afterEach(() => {
  for (const d of cleanup.splice(0))
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const taskOf = (req: RunRequest) => /^(?:YOUR )?TASK: (.+)$/m.exec(req.prompt)?.[1] ?? '';
const PLAN = JSON.stringify({
  done: false,
  tasks: TITLES.map((title) => ({
    title,
    spec: `${title} as described.`,
    after: [],
    estimate: { files: [`${title.split(' ')[1]}.js`], lines: 80, risk: 'high' },
  })),
});

/** The crash-test project with hooks: `onBuild` runs inside each build, before it writes. */
async function project(onBuild?: (title: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'conclave-p0-'));
  cleanup.push(dir);
  const p: CrashProject = await setUp(dir);
  const store = new Store(p.db);
  const planned = () => store.projects.listTasks(p.projectId).length > 0;
  const claude = new FakeAdapter(
    {
      reply: (req) =>
        req.role === 'planner'
          ? planned()
            ? '{"done": true, "reason": "all in"}'
            : PLAN
          : '{"approve": true, "issues": [], "summary": "Fine"}',
    },
    { id: 'claude' },
  );
  const codex = new FakeAdapter(
    {
      reply: () => 'Done.',
      act: (req) => {
        const title = taskOf(req);
        onBuild?.(title);
        const name = title.split(' ')[1]!;
        writeFileSync(join(req.cwd, `${name}.js`), `module.exports = '${name}';\n`);
      },
    },
    { id: 'codex' },
  );
  const brain = new Brain(
    { store, adapters: adapterMap([claude, codex]), cwd: p.home },
    p.projectId,
    { home: p.home, laneCaps: { codex: 2 } },
  );
  return { p, store, brain, codex };
}

const merges = (p: CrashProject) =>
  git(p.repo, 'log', '--merges', '--format=%s', 'conclave/integration').split('\n').filter(Boolean);

describe('v1.0 P0 bugs', () => {
  it('E1: a merge that lands while you press Stop counts as merged, not requeued', async () => {
    const { p, store, brain } = await project();
    const stop = new AbortController();
    // Stop arrives while the first merge is under way (the merge queue ignores it).
    const ws = (brain as unknown as { workspace: { mergeTask: (...a: unknown[]) => unknown } })
      .workspace;
    const mergeTask = ws.mergeTask.bind(ws);
    let first = true;
    ws.mergeTask = (...args: unknown[]) => {
      if (first) stop.abort();
      first = false;
      return mergeTask(...args);
    };
    const outcome = await brain.run({ signal: stop.signal, sleep: async () => undefined });
    expect(outcome.kind).toBe('stopped');
    const merged = store.projects.listTasks(p.projectId).filter((t) => t.status === 'merged');
    expect(merged).toHaveLength(1);
    expect(merges(p)).toHaveLength(1);
    // Resuming doesn't build the merged task again.
    store.projects.setStatus(p.projectId, 'running');
    expect((await brain.run({ sleep: async () => undefined })).kind).toBe('done');
    for (const title of TITLES)
      expect(merges(p).filter((m) => m.includes(`"${title}"`))).toHaveLength(1);
    store.close();
  }, 120_000);

  it('E2: a git step failing in one lane sends that task back; the others carry on', async () => {
    const { p, store, brain } = await project();
    const ws = (brain as unknown as { workspace: { commitTask: (...a: unknown[]) => unknown } })
      .workspace;
    const commitTask = ws.commitTask.bind(ws);
    let failed = false;
    ws.commitTask = (...args: unknown[]) => {
      if (!failed) {
        failed = true;
        return Promise.reject(new GitError('git add -A failed: index.lock exists'));
      }
      return commitTask(...args);
    };
    const outcome = await brain.run({ sleep: async () => undefined });
    const log = store.projects.events(p.projectId).map((e) => e.message);
    expect(outcome.kind, log.join('\n')).toBe('done');
    expect(store.projects.listTasks(p.projectId).map((t) => t.status)).toEqual([
      'merged',
      'merged',
      'merged',
    ]);
    expect(
      log.some((m) => m.startsWith('Something went wrong with') && m.includes('index.lock')),
    ).toBe(true);
    store.close();
  }, 120_000);

  it('E4: a task skipped from another window while it builds ends skipped, never merged', async () => {
    let skipped = false;
    const { p, store, brain } = await project((title) => {
      if (title !== 'Add beta' || skipped) return;
      skipped = true;
      // The other window: its own connection to the same database.
      const other = new Store(p.db);
      const task = other.projects.listTasks(p.projectId).find((t) => t.title === 'Add beta')!;
      other.projects.updateTask(task.id, { status: 'skipped' });
      other.close();
    });
    const outcome = await brain.run({ sleep: async () => undefined });
    const log = store.projects.events(p.projectId).map((e) => e.message);
    expect(outcome.kind, log.join('\n')).toBe('done');
    const beta = store.projects.listTasks(p.projectId).find((t) => t.title === 'Add beta')!;
    expect(beta.status).toBe('skipped');
    expect(merges(p).some((m) => m.includes('"Add beta"'))).toBe(false);
    expect(git(p.repo, 'ls-tree', '--name-only', 'conclave/integration')).not.toContain('beta.js');
    expect(log).toContain('Stopped work on Add beta: it is skipped now');
    store.close();
  }, 120_000);
});
