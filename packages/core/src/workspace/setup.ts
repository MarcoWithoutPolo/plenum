import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { commitIdentity, currentBranch, git, isRepo, repoRoot } from './git.js';

/** What a folder needs before it can host a project (wizard step 1). */
export type FolderState =
  | {
      kind: 'ready';
      path: string;
      root: string;
      name: string;
      branch: string;
      suggestedTest?: string;
    }
  | { kind: 'missing'; path: string }
  /** Not a git repository yet: "Set up git here". */
  | { kind: 'not_git'; path: string; name: string; files: number; large: boolean }
  /** Inside another repository: the project uses the outer root, since nested repos break worktrees. */
  | { kind: 'nested'; path: string; root: string; name: string; branch: string }
  /** A repository with no commits: "Make the first commit". */
  | { kind: 'no_commits'; path: string; root: string; name: string; files: number; large: boolean };

/** Folders with more files than this ask before git adds them all. */
export const LARGE_FOLDER = 20_000;

const SKIP_COUNT = new Set(['.git', 'node_modules', '.venv', 'venv', 'target', 'dist', 'build']);

/** Files git would add, roughly (stops counting just past the limit). */
export function countFiles(dir: string, limit = LARGE_FOLDER + 1): number {
  let n = 0;
  const stack = [dir];
  while (stack.length && n < limit) {
    const current = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (SKIP_COUNT.has(name)) continue;
      const full = join(current, name);
      try {
        if (statSync(full).isDirectory()) stack.push(full);
        else n++;
      } catch {
        // unreadable entry
      }
      if (n >= limit) break;
    }
  }
  return n;
}

const same = (a: string, b: string) =>
  resolve(a).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() ===
  resolve(b).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

export async function inspectFolder(path: string): Promise<FolderState> {
  if (!path || !existsSync(path) || !statSync(path).isDirectory()) return { kind: 'missing', path };
  const name = basename(resolve(path));
  if (!(await isRepo(path))) {
    const files = countFiles(path);
    return { kind: 'not_git', path, name, files, large: files > LARGE_FOLDER };
  }
  const root = await repoRoot(path);
  const head = await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], true);
  if (head.code !== 0) {
    const files = countFiles(root);
    return {
      kind: 'no_commits',
      path,
      root,
      name: basename(root),
      files,
      large: files > LARGE_FOLDER,
    };
  }
  const branch = await currentBranch(root);
  if (!same(root, path)) return { kind: 'nested', path, root, name: basename(root), branch };
  const test = guessTestCommand(root);
  return {
    kind: 'ready',
    path,
    root,
    name: basename(root),
    branch,
    ...(test && { suggestedTest: test }),
  };
}

export function guessTestCommand(root: string): string | undefined {
  const has = (f: string) => existsSync(join(root, f));
  if (has('package.json')) {
    try {
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
        scripts?: Record<string, string>;
      };
      const test = pkg.scripts?.test;
      if (test && !/no test specified/.test(test)) {
        return has('pnpm-lock.yaml') ? 'pnpm test' : has('yarn.lock') ? 'yarn test' : 'npm test';
      }
    } catch {
      // unreadable package.json: no guess
    }
  }
  if (has('Cargo.toml')) return 'cargo test';
  if (has('go.mod')) return 'go test ./...';
  if (has('pyproject.toml') || has('pytest.ini') || has('setup.py')) return 'pytest';
  return undefined;
}

/** The default parent for new project folders. */
export function defaultProjectsFolder(): string {
  return join(homedir(), 'Documents', 'Conclave Projects');
}

const BAD_NAME = /[<>:"/\\|?*\x00-\x1f]|^\.+$|^(con|prn|aux|nul|com\d|lpt\d)$/i;

/** Make a new, empty project folder. Refuses a name that exists and isn't empty. */
export function createProjectFolder(parent: string, name: string): string {
  const clean = name.trim();
  if (!clean || BAD_NAME.test(clean) || clean.length > 100) {
    throw new Error('Pick a folder name without \\ / : * ? " < > |.');
  }
  const path = join(parent, clean);
  if (existsSync(path) && readdirSync(path).length > 0) {
    throw new Error(`${path} already exists and isn't empty. Pick another name.`);
  }
  mkdirSync(path, { recursive: true });
  return path;
}

/** Per-stack ignore rules, written only when the files show that stack. */
const STACKS: { detect: string[]; rules: string[] }[] = [
  { detect: ['package.json'], rules: ['node_modules/', 'dist/', 'build/', '.next/', 'coverage/'] },
  {
    detect: ['pyproject.toml', 'requirements.txt', 'setup.py'],
    rules: ['.venv/', 'venv/', '__pycache__/', '*.pyc', '.pytest_cache/'],
  },
  { detect: ['Cargo.toml'], rules: ['target/'] },
  { detect: ['go.mod'], rules: ['bin/'] },
  { detect: ['*.csproj', '*.sln', '*.fsproj'], rules: ['bin/', 'obj/'] },
];

function stackRules(root: string): string[] {
  let names: string[] = [];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const matches = (pattern: string) =>
    pattern.startsWith('*.')
      ? names.some((n) => n.endsWith(pattern.slice(1)))
      : names.includes(pattern);
  const rules = new Set<string>();
  for (const stack of STACKS) {
    if (stack.detect.some(matches)) for (const r of stack.rules) rules.add(r);
  }
  return [...rules];
}

export interface GitSetup {
  root: string;
  branch: string;
  /** Rules written to a new .gitignore (empty when one already existed). */
  ignored: string[];
  commit: string;
}

/**
 * "Set up git here": optional .gitignore for the detected stack (plus .env files), git init
 * on main, add everything, and a first commit. An existing .gitignore is never touched.
 * Large folders need `confirmLarge`.
 */
export async function setUpGit(
  path: string,
  opts: { confirmLarge?: boolean } = {},
): Promise<GitSetup> {
  const state = await inspectFolder(path);
  if (state.kind === 'missing') throw new Error('That folder does not exist.');
  if (state.kind === 'ready' || state.kind === 'nested') {
    throw new Error('This folder already has git set up.');
  }
  if (state.large && !opts.confirmLarge) {
    throw new Error(
      `This folder has more than ${LARGE_FOLDER.toLocaleString()} files. Confirm to add them all to git.`,
    );
  }
  const root = state.kind === 'no_commits' ? state.root : path;
  let ignored: string[] = [];
  if (!existsSync(join(root, '.gitignore'))) {
    ignored = [...stackRules(root), '.env', '.env.*'];
    writeFileSync(join(root, '.gitignore'), `${ignored.join('\n')}\n`);
  }
  if (state.kind === 'not_git') await git(root, ['init', '-q', '-b', 'main']);
  await git(root, ['add', '-A']);
  await git(root, [
    ...(await commitIdentity(root)),
    'commit',
    '-q',
    '--no-verify',
    '--allow-empty',
    '-m',
    'Start',
  ]);
  const commit = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
  return { root: await repoRoot(root), branch: await currentBranch(root), ignored, commit };
}
