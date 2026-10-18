import { existsSync, readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { dialog, ipcMain, type BrowserWindow } from 'electron';
import type { Project } from '@conclave/shared';
import {
  createProject,
  currentBranch,
  decideApproval,
  isRepo,
  projectRoot,
  projectWorkspace,
  repoRoot,
  taskChanges,
  type BrainManager,
  type Engine,
} from '@conclave/core';
import {
  IPC,
  type ApprovalItem,
  type NewProjectInput,
  type ProjectDetail,
  type ProjectSummary,
  type RepoInfo,
  type UsageReport,
} from '../shared/api.js';

const DAY = 86_400_000;

export function registerProjectIpc(
  engine: Engine,
  manager: BrainManager,
  getWindow: () => BrowserWindow | null,
): void {
  const handle = <A extends unknown[], R>(channel: string, fn: (...args: A) => R | Promise<R>) =>
    ipcMain.handle(channel, (_event, ...args: unknown[]) => fn(...(args as A)));
  const projects = engine.store.projects;
  const id = (value: unknown): string => {
    if (typeof value !== 'string' || !/^[\w-]+$/.test(value)) throw new Error('Invalid id');
    return value;
  };
  const mustGet = (projectId: string): Project => {
    const p = projects.get(id(projectId));
    if (!p) throw new Error('That project no longer exists.');
    return p;
  };

  // Live activity for every project goes to the window as it happens.
  manager.onEvent((event) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(IPC.projectsEvent, event);
  });

  handle(IPC.projectsList, (): ProjectSummary[] =>
    projects.list().map((project) => {
      const tasks = projects.listTasks(project.id);
      const count = (...s: string[]) => tasks.filter((t) => s.includes(t.status)).length;
      return {
        project,
        running: manager.isRunning(project.id),
        counts: {
          queued: count('queued'),
          active: count('building', 'verifying', 'reviewing'),
          merged: count('merged'),
          failed: count('failed'),
          total: tasks.length,
        },
        pendingApprovals: projects.approvals(project.id, 'pending').length,
        lastEvent: projects.events(project.id, { latest: 1 }).at(-1) ?? null,
      };
    }),
  );

  handle(IPC.projectsGet, (projectId: string): ProjectDetail | null => {
    const project = projects.get(id(projectId));
    if (!project) return null;
    return {
      project,
      running: manager.isRunning(project.id),
      tasks: projects.listTasks(project.id),
      events: projects.events(project.id, { latest: 400 }),
      approvals: projects.approvals(project.id),
    };
  });

  handle(IPC.projectsPickRepo, async (): Promise<string | null> => {
    // End-to-end tests can't click a native dialog.
    if (process.env.CONCLAVE_E2E_REPO) return process.env.CONCLAVE_E2E_REPO;
    const win = getWindow();
    const options = {
      title: 'Choose a git repository',
      buttonLabel: 'Use this folder',
      properties: ['openDirectory' as const],
    };
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  handle(IPC.projectsInspectRepo, (path: string) => inspectRepo(String(path)));

  handle(IPC.projectsCreate, async (input: NewProjectInput) => {
    return createProject(engine.store, await engine.readySeats(), {
      repoPath: String(input.repoPath),
      goal: String(input.goal ?? ''),
      ...(input.name && { name: String(input.name) }),
      ...(input.doneWhen && { doneWhen: String(input.doneWhen) }),
      ...(input.testCommand && { testCommand: String(input.testCommand) }),
      ...(input.routing && { routing: input.routing }),
      ...(input.maxAttempts && {
        maxAttempts: Math.max(1, Math.min(10, Number(input.maxAttempts))),
      }),
    });
  });

  handle(IPC.projectsStart, (projectId: string) => {
    mustGet(projectId);
    manager.start(projectId);
  });

  handle(IPC.projectsStop, (projectId: string) => manager.stop(id(projectId)));

  handle(IPC.projectsRemove, async (projectId: string) => {
    const project = mustGet(projectId);
    if (manager.isRunning(project.id)) await manager.stop(project.id, 'Removed');
    // Worktrees go; branches stay, so merged work is never lost.
    await projectWorkspace(engine.home, project).dispose();
    rmSync(projectRoot(engine.home, project.id), { recursive: true, force: true });
    projects.remove(project.id);
  });

  handle(IPC.projectsTaskChanges, (taskId: string) => taskChanges(engine, engine.home, id(taskId)));

  handle(IPC.approvalsList, (): ApprovalItem[] =>
    projects.approvals().flatMap((approval) => {
      const project = projects.get(approval.projectId);
      return project ? [{ approval, project }] : [];
    }),
  );

  handle(IPC.approvalsDecide, async (approvalId: string, decision: 'approved' | 'rejected') => {
    if (decision !== 'approved' && decision !== 'rejected') throw new Error('Invalid decision');
    const result = await decideApproval(engine, engine.home, id(approvalId), decision);
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  });

  handle(IPC.usageReport, (): UsageReport => {
    const now = Date.now();
    return {
      day: engine.store.usage.totals(now - DAY),
      week: engine.store.usage.totals(now - 7 * DAY),
      daily: engine.store.usage.daily(14, now),
      recent: engine.store.usage.recent(40),
      quotas: engine.store.listQuotas(),
    };
  });
}

/** Is this a usable repo, and what test command does it probably use? */
export async function inspectRepo(path: string): Promise<RepoInfo> {
  if (!path || !existsSync(path)) return { path, ok: false, error: 'That folder does not exist.' };
  if (!(await isRepo(path))) {
    return {
      path,
      ok: false,
      error: 'Not a git repository. Run "git init" and commit once first.',
    };
  }
  const root = await repoRoot(path);
  const branch = await currentBranch(root);
  if (branch === 'HEAD') {
    return { path, ok: false, error: 'The repository has no commits yet. Commit once first.' };
  }
  const info: RepoInfo = { path, ok: true, root, name: basename(root), branch };
  const test = guessTestCommand(root);
  if (test) info.suggestedTest = test;
  return info;
}

function guessTestCommand(root: string): string | undefined {
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
