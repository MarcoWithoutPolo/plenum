import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { runCommand, runShell } from '../process.js';

/**
 * Dependencies in Plenum's own copies of a project (1.0.1). Its worktrees are fresh checkouts, so a
 * JavaScript project's node_modules was never there: a Vite or Next dev server couldn't start, so
 * no preview and no screenshots, and tests that need packages failed. Now:
 *
 * - The integration folder gets a real install (npm ci, or the project's package manager), once
 *   you've allowed the project's preview, which already runs its code. Again when the lock changes.
 * - Task worktrees and the merge check link to that node_modules while their dependencies are the
 *   same, so each task starts at once instead of installing.
 *
 * Never linked to your own folder's node_modules, and a link is always removed before its
 * worktree: `git worktree remove` follows links and deletes what they point to.
 */

/** Written into an installed node_modules: which dependencies it was installed for. */
const STAMP = '.plenum-deps';

export interface DepsPlan {
  /** The install command, as shown to you. */
  command: string;
  /** Changes when package.json's dependencies or the lock file change. */
  key: string;
}

const LOCKS: { file: string; command: string }[] = [
  { file: 'package-lock.json', command: 'npm ci' },
  { file: 'npm-shrinkwrap.json', command: 'npm ci' },
  { file: 'pnpm-lock.yaml', command: 'pnpm install --frozen-lockfile' },
  { file: 'yarn.lock', command: 'yarn install --frozen-lockfile' },
  { file: 'bun.lock', command: 'bun install --frozen-lockfile' },
  { file: 'bun.lockb', command: 'bun install --frozen-lockfile' },
];

/** What installing this folder's dependencies takes; null when it has none to install. */
export function depsPlan(dir: string): DepsPlan | null {
  const manifest = join(dir, 'package.json');
  if (!existsSync(manifest)) return null;
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(readFileSync(manifest, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
  const fields = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;
  const declared = fields.map((f) => pkg[f] ?? null);
  if (declared.every((d) => !d || Object.keys(d as object).length === 0)) return null;
  const lock = LOCKS.find((l) => existsSync(join(dir, l.file)));
  const hash = createHash('sha256').update(JSON.stringify(declared));
  if (lock) hash.update(readFileSync(join(dir, lock.file)));
  return {
    // Without a lock file, never write one into Plenum's folder: a later merge would trip on it.
    command: lock?.command ?? 'npm install --no-package-lock --no-audit --no-fund',
    key: hash.digest('hex').slice(0, 16),
  };
}

/** node_modules here is installed (not linked) for these dependencies. */
export function depsInstalled(dir: string, plan: DepsPlan): boolean {
  const modules = join(dir, 'node_modules');
  if (!existsSync(modules) || isLink(modules)) return false;
  try {
    return readFileSync(join(modules, STAMP), 'utf8').trim() === plan.key;
  } catch {
    return false;
  }
}

/** Install a folder's dependencies with its package manager, and mark what they were for. */
export async function installDeps(
  dir: string,
  plan: DepsPlan,
  signal?: AbortSignal,
): Promise<{ ok: true; ms: number } | { ok: false; output: string }> {
  const started = Date.now();
  releaseDeps(dir);
  const run = await runShell(plan.command, {
    cwd: dir,
    timeoutMs: 15 * 60_000,
    ...(signal && { signal }),
  });
  if (run.code !== 0) return { ok: false, output: run.output.trim().slice(-3000) };
  writeFileSync(join(dir, 'node_modules', STAMP), `${plan.key}\n`);
  return { ok: true, ms: Date.now() - started };
}

/**
 * Link `dir`'s node_modules to `source`'s installed one, when their dependencies are the same and
 * git ignores node_modules there (so it can never be committed). True when dir has them now.
 */
export async function linkDeps(dir: string, source: string): Promise<boolean> {
  const plan = depsPlan(dir);
  if (!plan) return true;
  const modules = join(dir, 'node_modules');
  if (existsSync(modules) && !isLink(modules)) return true;
  if (!depsInstalled(source, plan)) {
    releaseDeps(dir);
    return false;
  }
  const target = join(source, 'node_modules');
  if (isLink(modules)) {
    if (resolve(readlinkSync(modules)) === resolve(target)) return true;
    releaseDeps(dir);
  }
  const ignored = await runCommand('git', ['check-ignore', '-q', 'node_modules/'], { cwd: dir });
  if (ignored.code !== 0) return false;
  // A junction on Windows: no administrator rights or developer mode needed.
  symlinkSync(target, modules, 'junction');
  return true;
}

/** Remove a node_modules link (never what it points to). Safe to call on any folder. */
export function releaseDeps(dir: string): void {
  const modules = join(dir, 'node_modules');
  if (!isLink(modules)) return;
  try {
    unlinkSync(modules);
  } catch {
    rmSync(modules, { force: true });
  }
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}
