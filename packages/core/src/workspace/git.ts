import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { runCommand, type CommandResult } from '../process.js';

export class GitError extends Error {
  constructor(
    message: string,
    readonly result: CommandResult,
  ) {
    super(message);
  }
}

/** Fallback identity for commits when the user has none configured. */
const IDENTITY = ['-c', 'user.name=Conclave', '-c', 'user.email=conclave@localhost'];

export async function git(cwd: string, args: string[], allowFail = false): Promise<CommandResult> {
  const result = await runCommand('git', args, { cwd, timeoutMs: 120_000 });
  if (!allowFail && result.code !== 0) {
    const detail = (result.stderr || result.stdout || result.error || '').trim().split('\n').at(-1);
    throw new GitError(`git ${args[0]} failed: ${detail}`, result);
  }
  return result;
}

const out = async (cwd: string, args: string[]) => (await git(cwd, args)).stdout.trim();

const normalize = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

export async function isRepo(path: string): Promise<boolean> {
  const r = await git(path, ['rev-parse', '--is-inside-work-tree'], true);
  return r.code === 0 && r.stdout.trim() === 'true';
}

export async function repoRoot(path: string): Promise<string> {
  return out(path, ['rev-parse', '--show-toplevel']);
}

export async function currentBranch(path: string): Promise<string> {
  return out(path, ['rev-parse', '--abbrev-ref', 'HEAD']);
}

export async function branchExists(repo: string, branch: string): Promise<boolean> {
  return (
    (await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], true)).code === 0
  );
}

export async function headCommit(path: string): Promise<string> {
  return out(path, ['rev-parse', 'HEAD']);
}

/** Commit identity args: the user's own if git knows it, else a Conclave fallback. */
export async function commitIdentity(cwd: string): Promise<string[]> {
  const email = await git(cwd, ['config', 'user.email'], true);
  return email.code === 0 && email.stdout.trim() ? [] : IDENTITY;
}

/** Runs async jobs one at a time, in the order they arrive. */
export class SerialLock {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(job: () => Promise<T>): Promise<T> {
    const next = this.tail.then(job, job);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

export type TaskMerge =
  | { ok: true; commit: string; retested: boolean }
  | { ok: false; kind: 'conflict' | 'combined_tests'; detail: string };

/**
 * Isolated checkouts for the brain. The user's repo keeps its branch and
 * working files; everything happens in worktrees under Conclave's data folder.
 */
export class Workspace {
  constructor(
    /** The user's repository root. */
    readonly repo: string,
    /** Where this project's worktrees live, e.g. ~/.conclave/projects/<id>. */
    readonly root: string,
    readonly integrationBranch: string,
  ) {}

  /**
   * Git can't safely change worktrees and refs from several lanes at once (index.lock and
   * packed-refs races, worst on Windows). Those short calls queue here; agents and tests don't.
   */
  private readonly gitLock = new SerialLock();
  /** Merges happen one at a time, in approval order. */
  private readonly mergeLock = new SerialLock();

  get mergePath(): string {
    return `${this.root}/merge`;
  }

  get integrationPath(): string {
    return `${this.root}/integration`;
  }

  taskPath(taskId: string): string {
    return `${this.root}/tasks/${taskId}`;
  }

  taskBranch(taskId: string): string {
    return `conclave/task/${taskId}`;
  }

  /** Create the integration branch from `base` (once) and check it out in its own worktree. */
  async prepare(base: string): Promise<void> {
    await git(this.repo, ['worktree', 'prune'], true);
    if (!(await branchExists(this.repo, this.integrationBranch))) {
      await git(this.repo, ['branch', this.integrationBranch, base]);
    }
    if (!existsSync(this.integrationPath)) {
      mkdirSync(dirname(this.integrationPath), { recursive: true });
      await git(this.repo, ['worktree', 'add', this.integrationPath, this.integrationBranch]);
    }
  }

  /** A fresh worktree on a new task branch, starting from the integration branch's tip. */
  createTaskTree(taskId: string): Promise<string> {
    return this.gitLock.run(async () => {
      await this.removeTree(taskId);
      return this.addTree(taskId);
    });
  }

  private async addTree(taskId: string): Promise<string> {
    const path = this.taskPath(taskId);
    mkdirSync(dirname(path), { recursive: true });
    await git(this.repo, [
      'worktree',
      'add',
      '-B',
      this.taskBranch(taskId),
      path,
      this.integrationBranch,
    ]);
    return path;
  }

  removeTaskTree(taskId: string): Promise<void> {
    return this.gitLock.run(() => this.removeTree(taskId));
  }

  private async removeTree(taskId: string): Promise<void> {
    const path = this.taskPath(taskId);
    if (existsSync(path)) {
      await git(this.repo, ['worktree', 'remove', '--force', path], true);
      if (existsSync(path)) rmSync(path, { recursive: true, force: true });
    }
    await git(this.repo, ['worktree', 'prune'], true);
    await git(this.repo, ['branch', '-D', this.taskBranch(taskId)], true);
  }

  /** Stage and commit everything in the task's worktree. Returns null when nothing changed. */
  commitTask(taskId: string, message: string): Promise<string | null> {
    return this.gitLock.run(() => this.commit(taskId, message));
  }

  private async commit(taskId: string, message: string): Promise<string | null> {
    const path = this.taskPath(taskId);
    await git(path, ['add', '-A']);
    const status = await out(path, ['status', '--porcelain']);
    if (!status) return null;
    await git(path, [
      ...(await commitIdentity(path)),
      'commit',
      '--no-verify',
      '-q',
      '-m',
      message,
    ]);
    return headCommit(path);
  }

  /** The task's changes against the integration branch, for review. */
  async taskDiff(
    taskId: string,
    maxChars = 60_000,
  ): Promise<{ diff: string; stat: string; truncated: boolean }> {
    const path = this.taskPath(taskId);
    const range = `${this.integrationBranch}...HEAD`;
    const stat = await out(path, ['diff', '--stat', range]);
    const diff = (await git(path, ['diff', range])).stdout;
    return { diff: diff.slice(0, maxChars), stat, truncated: diff.length > maxChars };
  }

  /**
   * Merge a task branch into the integration branch, one task at a time.
   *
   * Fast path: when nothing merged since the task's worktree was made, its own test run
   * covered exactly this code, so it merges directly (always the case with one lane).
   * Otherwise the merge is tried in a separate candidate worktree and `test` runs there;
   * the integration branch only moves (compare-and-swap) when the candidate passes.
   * A conflict or a failing candidate leaves the integration branch exactly as it was.
   */
  mergeTask(
    taskId: string,
    message: string,
    test?: (cwd: string) => Promise<{ ok: boolean; output: string }>,
  ): Promise<TaskMerge> {
    return this.mergeLock.run(async () => {
      const tip = await out(this.integrationPath, ['rev-parse', 'HEAD']);
      const current =
        (await git(this.repo, ['merge-base', '--is-ancestor', tip, this.taskBranch(taskId)], true))
          .code === 0;
      if (current || !test) {
        const merged = await this.gitLock.run(() => this.mergeDirect(taskId, message));
        return merged.ok ? { ...merged, retested: false } : merged;
      }
      return this.mergeCandidate(taskId, message, tip, test);
    });
  }

  private async mergeCandidate(
    taskId: string,
    message: string,
    tip: string,
    test: (cwd: string) => Promise<{ ok: boolean; output: string }>,
  ): Promise<TaskMerge> {
    const path = this.mergePath;
    const merge = await this.gitLock.run(async () => {
      if (!existsSync(path)) {
        await git(this.repo, ['worktree', 'prune'], true);
        await git(this.repo, ['worktree', 'add', '--detach', path, tip]);
      } else {
        await git(path, ['merge', '--abort'], true);
        await git(path, ['checkout', '-q', '--force', '--detach', tip]);
        await git(path, ['reset', '-q', '--hard', tip]);
        await git(path, ['clean', '-q', '-fd']);
      }
      const r = await git(
        path,
        [
          ...(await commitIdentity(path)),
          'merge',
          '--no-ff',
          '-q',
          '-m',
          message,
          this.taskBranch(taskId),
        ],
        true,
      );
      if (r.code !== 0) await git(path, ['merge', '--abort'], true);
      return r;
    });
    if (merge.code !== 0) {
      return {
        ok: false,
        kind: 'conflict',
        detail: (merge.stdout + merge.stderr).trim().slice(-2000),
      };
    }
    const tested = await test(path);
    if (!tested.ok) return { ok: false, kind: 'combined_tests', detail: tested.output };
    return this.gitLock.run(async () => {
      const candidate = await headCommit(path);
      // Compare-and-swap: only move the branch if nobody else moved it meanwhile.
      await git(this.repo, ['update-ref', `refs/heads/${this.integrationBranch}`, candidate, tip]);
      await git(this.integrationPath, ['reset', '-q', '--hard', candidate]);
      return { ok: true, commit: candidate, retested: true } as const;
    });
  }

  private async mergeDirect(
    taskId: string,
    message: string,
  ): Promise<{ ok: true; commit: string } | { ok: false; kind: 'conflict'; detail: string }> {
    const path = this.integrationPath;
    const merge = await git(
      path,
      [
        ...(await commitIdentity(path)),
        'merge',
        '--no-ff',
        '-q',
        '-m',
        message,
        this.taskBranch(taskId),
      ],
      true,
    );
    if (merge.code !== 0) {
      await git(path, ['merge', '--abort'], true);
      return {
        ok: false,
        kind: 'conflict',
        detail: (merge.stdout + merge.stderr).trim().slice(-2000),
      };
    }
    return { ok: true, commit: await headCommit(path) };
  }

  /** Remove every worktree this project made. Branches stay, so no work is lost. */
  async dispose(): Promise<void> {
    const listed = (await git(this.repo, ['worktree', 'list', '--porcelain'], true)).stdout;
    const mine = listed
      .split('\n')
      .filter((l) => l.startsWith('worktree '))
      .map((l) => l.slice('worktree '.length).trim())
      .filter((p) => normalize(p).startsWith(normalize(this.root)));
    for (const path of mine) await git(this.repo, ['worktree', 'remove', '--force', path], true);
    rmSync(this.root, { recursive: true, force: true });
    await git(this.repo, ['worktree', 'prune'], true);
  }

  /** Tracked files on the integration branch, for the planner. */
  async listFiles(limit = 300): Promise<{ files: string[]; total: number }> {
    const all = (await out(this.integrationPath, ['ls-files'])).split('\n').filter(Boolean);
    return { files: all.slice(0, limit), total: all.length };
  }

  /** Recent integration history, newest first. */
  async log(limit = 15): Promise<string> {
    return out(this.integrationPath, ['log', '--oneline', `-${limit}`]);
  }
}

export type BaseMerge = { ok: true; commit: string } | { ok: false; error: string };

/**
 * Take a project's integration branch into the user's base branch: the one
 * step that changes the user's own branch, run only after they approve it.
 * Refuses rather than risk their work: uncommitted changes or a conflict
 * leave everything exactly as it was.
 */
export async function mergeIntoBase(
  repo: string,
  base: string,
  branch: string,
  message: string,
  scratch: string,
): Promise<BaseMerge> {
  const checkedOut = (await currentBranch(repo)) === base;
  let where = repo;
  if (checkedOut) {
    const dirty = await out(repo, ['status', '--porcelain', '--untracked-files=no']);
    if (dirty) {
      return {
        ok: false,
        error: `${base} has uncommitted changes in ${repo}. Commit or stash them, then approve again.`,
      };
    }
  } else {
    // The base branch isn't checked out here: merge in a temporary worktree.
    rmSync(scratch, { recursive: true, force: true });
    await git(repo, ['worktree', 'prune'], true);
    const add = await git(repo, ['worktree', 'add', scratch, base], true);
    if (add.code !== 0) {
      return {
        ok: false,
        error: `Couldn't check out ${base}: ${(add.stderr || add.stdout).trim().split('\n').at(-1)}`,
      };
    }
    where = scratch;
  }
  try {
    const merge = await git(
      where,
      [...(await commitIdentity(where)), 'merge', '--no-ff', '-q', '-m', message, branch],
      true,
    );
    if (merge.code !== 0) {
      await git(where, ['merge', '--abort'], true);
      return {
        ok: false,
        error: `Merging into ${base} conflicts with changes made there since. Resolve it with: git merge ${branch}`,
      };
    }
    return { ok: true, commit: await headCommit(where) };
  } finally {
    if (!checkedOut) {
      await git(repo, ['worktree', 'remove', '--force', scratch], true);
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}

/** What a merge commit brought in (its diff against the first parent). */
export async function mergeCommitDiff(
  repo: string,
  commit: string,
  maxChars = 200_000,
): Promise<string> {
  const diff = (await git(repo, ['diff', '--no-color', `${commit}^1`, commit])).stdout;
  return diff.slice(0, maxChars);
}

export type PushResult = { ok: true; branch: string } | { ok: false; error: string };

/**
 * Push a local branch to its own remote branch. Never forces and never targets
 * `protect` (the base branch). When the remote branch exists and has diverged, it tries
 * `<name>-2`, `<name>-3`, … unless `exact` (updating an open pull request).
 */
export async function pushBranch(
  repo: string,
  local: string,
  remoteBranch: string,
  opts: { remote?: string; protect?: string; exact?: boolean } = {},
): Promise<PushResult> {
  const remote = opts.remote ?? 'origin';
  if (!/^[\w./-]+$/.test(remoteBranch) || remoteBranch === opts.protect) {
    return { ok: false, error: `Refusing to push to ${remoteBranch}.` };
  }
  for (let i = 1; i <= (opts.exact ? 1 : 5); i++) {
    const name = i === 1 ? remoteBranch : `${remoteBranch}-${i}`;
    const push = await git(
      repo,
      ['push', '--porcelain', remote, `refs/heads/${local}:refs/heads/${name}`],
      true,
    );
    if (push.code === 0) return { ok: true, branch: name };
    const text = `${push.stdout}\n${push.stderr}`;
    if (!/rejected|non-fast-forward|fetch first|stale info/i.test(text)) {
      return { ok: false, error: `git push failed: ${text.trim().split('\n').at(-1)}` };
    }
    if (opts.exact) {
      return {
        ok: false,
        error: `${name} on ${remote} has changes Conclave doesn't have; it won't overwrite them.`,
      };
    }
  }
  return {
    ok: false,
    error: `Every candidate branch name for ${remoteBranch} is taken on ${remote}.`,
  };
}
