import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { CRASH_EXIT, Store, type CrashPoint } from '../src/index.js';
import { git, runProject, setUp, TITLES, type CrashProject } from './crash/kit.js';

/**
 * Crash at every step (v1.0 Q4): a child process runs a project until it dies at a named point,
 * with no cleanup, as a power cut would. A fresh process then resumes it. Whatever the point,
 * the project must finish with every task merged exactly once and nothing left half-way.
 */

const cleanup: string[] = [];
afterEach(() => {
  for (const d of cleanup.splice(0))
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const child = fileURLToPath(new URL('./crash/child.ts', import.meta.url));
const root = fileURLToPath(new URL('../../../', import.meta.url));

function crashAt(p: CrashProject, point: CrashPoint, mode: 'normal' | 'conflict') {
  const run = spawnSync(
    process.execPath,
    ['--conditions=development', '--import', 'tsx', child, JSON.stringify(p), mode],
    {
      cwd: root,
      env: { ...process.env, PLENUM_CRASH_AT: point },
      encoding: 'utf8',
      timeout: 90_000,
    },
  );
  expect(run.status, `the child never reached ${point}\n${run.stdout}\n${run.stderr}`).toBe(
    CRASH_EXIT,
  );
}

/** What must hold once the resumed project has finished. */
function checkInvariants(p: CrashProject) {
  const store = new Store(p.db);
  try {
    const tasks = store.projects.listTasks(p.projectId);
    const log = store.projects.events(p.projectId).map((e) => e.message);
    expect(tasks.map((t) => `${t.title}: ${t.status}`).sort(), log.join('\n')).toEqual(
      TITLES.map((t) => `${t}: merged`),
    );
    // Each task merged exactly once: never rebuilt on top of itself.
    const merges = git(p.repo, 'log', '--merges', '--format=%s', 'plenum/integration')
      .split('\n')
      .filter(Boolean);
    for (const title of TITLES)
      expect(
        merges.filter((m) => m.includes(`"${title}"`)),
        title,
      ).toHaveLength(1);
    // The integration folder is clean and at its branch, with no merge in progress.
    const tree = join(p.home, 'projects', p.projectId, 'integration');
    expect(git(tree, 'status', '--porcelain')).toBe('');
    expect(git(tree, 'rev-parse', 'HEAD')).toBe(git(p.repo, 'rev-parse', 'plenum/integration'));
    expect(existsSync(join(p.repo, '.git', 'worktrees', 'integration', 'MERGE_HEAD'))).toBe(false);
    // Nothing left over: no task branches, no task worktrees.
    expect(git(p.repo, 'branch', '--list', 'plenum/task/*')).toBe('');
    const trees = git(p.repo, 'worktree', 'list', '--porcelain')
      .split('\n')
      .filter((l) => l.startsWith('worktree '));
    expect(trees.some((l) => l.includes('/tasks/'))).toBe(false);
  } finally {
    store.close();
  }
}

const POINTS: [CrashPoint, 'normal' | 'conflict'][] = [
  ['after-plan', 'normal'],
  ['after-commit', 'normal'],
  ['mid-tests', 'normal'],
  ['after-approve', 'normal'],
  ['after-merge', 'normal'],
  ['mid-merge-ref', 'normal'],
  ['mid-merge-conflict', 'conflict'],
];

describe('Crash at every step (v1.0)', () => {
  for (const [point, mode] of POINTS) {
    it(`resumes cleanly after a crash ${point}`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'plenum-crash-'));
      cleanup.push(dir);
      const p = await setUp(dir, mode === 'conflict');
      crashAt(p, point, mode);
      const outcome = await runProject(p, mode === 'conflict');
      expect(outcome.kind, JSON.stringify(outcome)).toBe('done');
      checkInvariants(p);
    }, 180_000);
  }
});
