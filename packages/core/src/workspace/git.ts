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
async function identity(cwd: string): Promise<string[]> {
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
    await git(path, [...(await identity(path)), 'commit', '--no-verify', '-q', '-m', message]);
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
      [...(await identity(path)), 'merge', '--no-ff', '-q', '-m', message, this.taskBranch(taskId)],
      true,
    );
    if (merge.code !== 0) {
      await git(path, ['merge', '--abort'], true);
      return { ok: false, conflict: (merge.stdout + merge.stderr).trim().slice(-2000) };
    }
    return { ok: true, commit: await headCommit(path) };
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
