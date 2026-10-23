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
  async createTaskTree(taskId: string): Promise<string> {
    await this.removeTaskTree(taskId);
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

  async removeTaskTree(taskId: string): Promise<void> {
    const path = this.taskPath(taskId);
    if (existsSync(path)) {
      await git(this.repo, ['worktree', 'remove', '--force', path], true);
      if (existsSync(path)) rmSync(path, { recursive: true, force: true });
    }
    await git(this.repo, ['worktree', 'prune'], true);
    await git(this.repo, ['branch', '-D', this.taskBranch(taskId)], true);
  }

  /** Stage and commit everything in the task's worktree. Returns null when nothing changed. */
  async commitTask(taskId: string, message: string): Promise<string | null> {
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
   * Merge a task branch into the integration branch. On a conflict the merge
   * is aborted and nothing changes; the task can be rebuilt from the new tip.
   */
  async mergeTask(
    taskId: string,
    message: string,
  ): Promise<{ ok: true; commit: string } | { ok: false; conflict: string }> {
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
      return { ok: false, conflict: (merge.stdout + merge.stderr).trim().slice(-2000) };
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
