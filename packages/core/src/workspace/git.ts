import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { removeDir, runCommand, type CommandResult } from '../process.js';
import { crashPoint } from '../crash.js';

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
 * Whether a linked worktree is fully checked out. `git worktree add` makes the folder first and
 * fills it afterwards, holding a "locked" file (reason "initializing") in the worktree's admin
 * folder until the checkout is done. A worktree whose add was killed keeps that file, so it
 * never counts as ready.
 */
export function worktreeReady(path: string): boolean {
  let pointer: string;
  try {
    pointer = readFileSync(join(path, '.git'), 'utf8').trim();
  } catch {
    return false;
  }
  const m = /^gitdir:\s*(.+)$/m.exec(pointer);
  if (!m) return false;
  const admin = isAbsolute(m[1]!) ? m[1]! : resolve(path, m[1]!);
  return (
    existsSync(join(admin, 'HEAD')) &&
    existsSync(join(admin, 'index')) &&
    !existsSync(join(admin, 'locked'))
  );
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
    if (existsSync(this.integrationPath) && !worktreeReady(this.integrationPath)) {
      // A checkout that never finished (the run was stopped mid-way): start it again.
      // Twice --force: git won't otherwise remove a worktree still locked "initializing".
      await git(
        this.repo,
        ['worktree', 'remove', '--force', '--force', this.integrationPath],
        true,
      );
      await removeDir(this.integrationPath, 20);
      await git(this.repo, ['worktree', 'prune'], true);
    }
    if (!existsSync(this.integrationPath)) {
      mkdirSync(dirname(this.integrationPath), { recursive: true });
      await git(this.repo, ['worktree', 'add', this.integrationPath, this.integrationBranch]);
    }
    await this.repairIntegration();
  }

  /**
   * A crash can leave the integration folder mid-merge (a conflicting merge not yet aborted) or
   * behind its branch (the branch moved, the files not yet). Nothing is ever meant to sit
   * uncommitted there, so put the folder back at the branch tip. Untracked files stay.
   */
  private async repairIntegration(): Promise<void> {
    const path = this.integrationPath;
    const merging =
      (await git(path, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], true)).code === 0;
    if (merging) await git(path, ['merge', '--abort'], true);
    const dirty = (await git(path, ['diff', '--quiet', 'HEAD'], true)).code !== 0;
    if (merging || dirty) await git(path, ['reset', '-q', '--hard', 'HEAD']);
  }

  /**
   * The merge commit on the integration branch that brought in this task's branch, if it was
   * merged (merges are always --no-ff, so the task's tip is that commit's second parent).
   */
  async mergedCommit(taskId: string): Promise<string | null> {
    const tip = await git(
      this.repo,
      ['rev-parse', '-q', '--verify', this.taskBranch(taskId)],
      true,
    );
    if (tip.code !== 0) return null;
    const head = tip.stdout.trim();
    const inside = await git(
      this.repo,
      ['merge-base', '--is-ancestor', head, this.integrationBranch],
      true,
    );
    if (inside.code !== 0) return null;
    const merges = await git(
      this.repo,
      ['log', '--merges', '--format=%H %P', `${head}..${this.integrationBranch}`],
      true,
    );
    for (const line of merges.stdout.split('\n')) {
      const [commit, , second] = line.trim().split(' ');
      if (commit && second === head) return commit;
    }
    return null;
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

  /**
   * A worktree on the task's kept branch, so a retry continues from its last attempt. When the
   * integration branch moved since, it is merged in first. `null` when the branch is gone or no
   * longer at `commit`; `conflict` when the merge didn't apply. With `keepConflicts`, a merge that
   * conflicts is left in progress and its files are listed, for the builder to resolve.
   */
  resumeTaskTree(
    taskId: string,
    commit: string,
    keepConflicts = false,
  ): Promise<{ path: string; updated: boolean; conflicts?: string[] } | 'conflict' | null> {
    return this.gitLock.run(async () => {
      await this.removeTree(taskId, true);
      const branch = this.taskBranch(taskId);
      const tip = await git(this.repo, ['rev-parse', '--verify', '--quiet', branch], true);
      if (tip.code !== 0 || tip.stdout.trim() !== commit) return null;
      const path = this.taskPath(taskId);
      mkdirSync(dirname(path), { recursive: true });
      await git(this.repo, ['worktree', 'add', path, branch]);
      const behind =
        (await git(path, ['merge-base', '--is-ancestor', this.integrationBranch, 'HEAD'], true))
          .code !== 0;
      if (!behind) return { path, updated: false };
      const merged = await git(
        path,
        [
          ...(await commitIdentity(path)),
          'merge',
          '--no-edit',
          '-q',
          '-m',
          `Merge ${this.integrationBranch} into this task`,
          this.integrationBranch,
        ],
        true,
      );
      if (merged.code === 0) return { path, updated: true };
      if (keepConflicts) {
        // Left in progress: the builder resolves the markers and the commit finishes the merge.
        const files = await out(path, ['diff', '--name-only', '--diff-filter=U']);
        const conflicts = files.split('\n').filter(Boolean);
        if (conflicts.length) return { path, updated: true, conflicts };
      }
      await git(path, ['merge', '--abort'], true);
      return 'conflict';
    });
  }

  /** The task ids that have a worktree folder right now. */
  taskTreeIds(): string[] {
    const dir = `${this.root}/tasks`;
    return existsSync(dir)
      ? readdirSync(dir, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name)
      : [];
  }

  /** `keepBranch`: drop only the worktree, so a retry can continue from the branch. */
  removeTaskTree(taskId: string, keepBranch = false): Promise<void> {
    return this.gitLock.run(() => this.removeTree(taskId, keepBranch));
  }

  private async removeTree(taskId: string, keepBranch = false): Promise<void> {
    const path = this.taskPath(taskId);
    if (existsSync(path)) {
      // Twice --force: a worktree whose `git worktree add` was killed stays locked
      // "initializing", and git (and `worktree prune`) won't drop it otherwise (soak, item 7915).
      await git(this.repo, ['worktree', 'remove', '--force', '--force', path], true);
      // Windows keeps a folder locked for a moment after the last process in it exits; a
      // leftover folder never stops the project (git prunes the worktree either way).
      if (existsSync(path)) await removeDir(path, 20);
    }
    await git(this.repo, ['worktree', 'prune'], true);
    if (!keepBranch) await git(this.repo, ['branch', '-D', this.taskBranch(taskId)], true);
  }

  /**
   * Delete files a builder asked for (it can't run `rm` below level 4). Only paths inside the
   * task's worktree and outside `.git` count; the rest are returned as skipped.
   */
  async deleteFiles(
    taskId: string,
    paths: string[],
  ): Promise<{ deleted: string[]; skipped: string[] }> {
    const root = resolve(this.taskPath(taskId));
    const deleted: string[] = [];
    const skipped: string[] = [];
    for (const p of paths) {
      const full = resolve(root, p);
      const rel = relative(root, full);
      const inside = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
      if (!inside || rel.split(/[\\/]/)[0] === '.git' || !existsSync(full)) {
        skipped.push(p);
        continue;
      }
      rmSync(full, { recursive: true, force: true });
      deleted.push(rel.replace(/\\/g, '/'));
    }
    return { deleted, skipped };
  }

  /** Stage and commit everything in the task's worktree. Returns null when nothing changed. */
  commitTask(taskId: string, message: string): Promise<string | null> {
    return this.gitLock.run(() => this.commit(taskId, message));
  }

  private async commit(taskId: string, message: string): Promise<string | null> {
    const path = this.taskPath(taskId);
    await git(path, ['add', '-A']);
    const status = await out(path, ['status', '--porcelain']);
    // A merge in progress is committed even when its result matches this branch (the builder
    // kept its own side): the commit records the newer work as merged.
    const merging =
      (await git(path, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], true)).code === 0;
    if (!status && !merging) return null;
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
      crashPoint('mid-merge-ref');
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
      crashPoint('mid-merge-conflict');
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
    // Twice --force, so a worktree locked by a killed checkout goes too.
    for (const path of mine)
      await git(this.repo, ['worktree', 'remove', '--force', '--force', path], true);
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

/** Your branch here against its copy on GitHub (or another remote), after a fetch. */
export interface SyncState {
  /** The remote's name ("origin"), when the repo has one. */
  remote?: string;
  /** Where it points, without any user name or token in it. */
  url?: string;
  /** Commits here that the remote doesn't have, and the other way round. */
  ahead: number;
  behind: number;
  /** The remote doesn't have this branch yet. */
  missing?: boolean;
  fetchedAt: number;
  /** The fetch failed (offline, signed out): counts are from the last fetch. */
  error?: string;
}

/** A remote URL fit to show: user names and tokens taken out. */
export function safeRemoteUrl(url: string): string {
  return url.trim().replace(/^(\w+:\/\/)[^@/]*@/, '$1');
}

/**
 * Compares `branch` with the remote's copy: `git fetch` (never a push), then counts. Uses the
 * branch's upstream when it has one, otherwise `origin`.
 */
export async function syncState(repo: string, branch: string): Promise<SyncState> {
  const fetchedAt = Date.now();
  const upstream = (
    await git(
      repo,
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branch}@{upstream}`],
      true,
    )
  ).stdout.trim();
  const remotes = (await git(repo, ['remote'], true)).stdout.split(/\r?\n/).filter(Boolean);
  const remote = upstream.includes('/')
    ? upstream.split('/')[0]!
    : remotes.includes('origin')
      ? 'origin'
      : remotes[0];
  if (!remote) return { ahead: 0, behind: 0, fetchedAt };
  const remoteBranch = upstream.includes('/') ? upstream.slice(remote.length + 1) : branch;
  const url = safeRemoteUrl((await git(repo, ['remote', 'get-url', remote], true)).stdout);
  const fetch = await git(repo, ['fetch', '--quiet', remote, remoteBranch], true);
  const error =
    fetch.code === 0
      ? undefined
      : (fetch.stderr || fetch.error || 'git fetch failed').trim().split('\n').at(-1);
  const ref = `refs/remotes/${remote}/${remoteBranch}`;
  const has = (await git(repo, ['rev-parse', '--verify', '--quiet', ref], true)).code === 0;
  if (!has) {
    const count = (await git(repo, ['rev-list', '--count', branch], true)).stdout.trim();
    return {
      remote,
      url,
      ahead: Number(count) || 0,
      behind: 0,
      missing: true,
      fetchedAt,
      ...(error && { error }),
    };
  }
  const counts = (
    await git(repo, ['rev-list', '--left-right', '--count', `${branch}...${ref}`], true)
  ).stdout
    .trim()
    .split(/\s+/)
    .map(Number);
  return {
    remote,
    url,
    ahead: counts[0] ?? 0,
    behind: counts[1] ?? 0,
    fetchedAt,
    ...(error && { error }),
  };
}

/**
 * Pushes your base branch to its remote, only when you asked for it: never forced, so a remote
 * with commits you don't have refuses it ("pull first").
 */
export async function pushBase(repo: string, branch: string, remote: string): Promise<PushResult> {
  if (!/^[\w./-]+$/.test(branch) || !/^[\w.-]+$/.test(remote)) {
    return { ok: false, error: `Refusing to push ${branch} to ${remote}.` };
  }
  const push = await git(
    repo,
    ['push', '--porcelain', remote, `refs/heads/${branch}:refs/heads/${branch}`],
    true,
  );
  if (push.code === 0) return { ok: true, branch };
  const text = `${push.stdout}\n${push.stderr}`;
  if (/rejected|non-fast-forward|fetch first/i.test(text)) {
    return { ok: false, error: `${remote} has commits you don't have. Pull first, then push.` };
  }
  return { ok: false, error: `git push failed: ${text.trim().split('\n').at(-1)}` };
}

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
