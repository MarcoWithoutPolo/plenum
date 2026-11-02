import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunRequest } from '../../src/index.js';
import { adapterMap, Brain, createProject, FakeAdapter, Store } from '../../src/index.js';

/**
 * A small project the crash tests run in a child process until it crashes at a named point,
 * then resume in a fresh one. Every run of it plans the same three tasks, builds each the same
 * way and approves every review, so whatever goes wrong is the crash's doing.
 */
export interface CrashProject {
  repo: string;
  home: string;
  db: string;
  projectId: string;
}

export const TITLES = ['Add alpha', 'Add beta', 'Add gamma'];

export const git = (cwd: string, ...args: string[]) =>
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

/**
 * Create the repo and the project. `conflict`: no test command, and every task writes the same
 * file, so later merges conflict in the integration folder itself.
 */
export async function setUp(root: string, conflict = false): Promise<CrashProject> {
  const repo = join(root, 'repo');
  const home = join(root, 'home');
  mkdirSync(repo, { recursive: true });
  mkdirSync(home, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  // This machine's own line-ending setting would show checked-out files as changed.
  git(repo, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'check.js'), "console.log('ok');\n");
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  const db = join(root, 'conclave.db');
  const store = new Store(db);
  const project = await createProject(store, [{ provider: 'claude' }, { provider: 'codex' }], {
    repoPath: repo,
    goal: conflict ? 'Three notes in one file' : 'Three small modules',
    ...(!conflict && { testCommand: 'node check.js' }),
    maxAttempts: 4,
    maxParallel: 2,
    routing: {
      planner: [{ provider: 'claude' }],
      builder: [{ provider: 'codex' }],
      reviewer: [{ provider: 'claude' }],
    },
  });
  store.close();
  return { repo, home, db, projectId: project.id };
}

const taskOf = (req: RunRequest) => /^(?:YOUR )?TASK: (.+)$/m.exec(req.prompt)?.[1] ?? '';

/** Run the project to the end (or until the crash point ends the process). */
export async function runProject(p: CrashProject, conflict = false) {
  const store = new Store(p.db);
  const planned = () => store.projects.listTasks(p.projectId).length > 0;
  const plan = JSON.stringify({
    done: false,
    // No order between them, and separate files: they build side by side in two lanes.
    tasks: TITLES.map((title) => ({
      title,
      spec: `${title} as described.`,
      after: [],
      estimate: { files: [`${title.split(' ')[1]}.js`], lines: 80, risk: 'high' },
    })),
  });
  const claude = new FakeAdapter(
    {
      reply: (req) =>
        req.role === 'planner'
          ? planned()
            ? '{"done": true, "reason": "all three are in"}'
            : plan
          : '{"approve": true, "issues": [], "summary": "Fine"}',
    },
    { id: 'claude' },
  );
  const codex = new FakeAdapter(
    {
      reply: () => 'Done.',
      act: (req) => {
        const title = taskOf(req);
        const name = title.split(' ')[1]!;
        if (conflict) writeFileSync(join(req.cwd, 'notes.txt'), `${title}\n`);
        else writeFileSync(join(req.cwd, `${name}.js`), `module.exports = '${name}';\n`);
      },
    },
    { id: 'codex' },
  );
  const brain = new Brain(
    { store, adapters: adapterMap([claude, codex]), cwd: p.home },
    p.projectId,
    // Two of Codex's builds at once, so later merges land on a moved branch (and can conflict).
    { home: p.home, laneCaps: { codex: 2 } },
  );
  try {
    return await brain.run({ maxRounds: 60, sleep: async () => undefined });
  } finally {
    store.close();
  }
}
