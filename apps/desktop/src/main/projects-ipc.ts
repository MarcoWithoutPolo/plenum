import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { dialog, ipcMain, type BrowserWindow } from 'electron';
import {
  AskPolicy,
  FailureKind,
  Permissions,
  ProviderId,
  RetryStrategy,
  Routing,
  Seat,
  IN_FLIGHT,
  taskProgress,
  type Project,
} from '@conclave/shared';
import {
  activeLimits,
  builderPermissions,
  clarify,
  createProject,
  createProjectFolder,
  defaultProjectsFolder,
  fixFailingCheck,
  inspectFolder,
  linkRepo,
  projectRoot,
  projectWorkspace,
  providerProblems,
  pullRequestStatus,
  requestPublish,
  setUpGit,
  startDraft,
  taskChanges,
  type BrainManager,
  type DraftStart,
  type Engine,
  type GhCheck,
  type GitHub,
  type RetryOptions,
  clampParallel,
  Governor,
  routingInsights,
  detectPreview,
} from '@conclave/core';
import {
  IPC,
  type ApprovalItem,
  type DecideOptions,
  type NewProjectInput,
  type PermissionGaps,
  type TeamInsights,
  type TaskSnapshots,
  type ProjectDetail,
  type ProjectSettings,
  type ProjectSummary,
  type RepoInfo,
  type UsageReport,
} from '../shared/api.js';
import { openInTerminal } from './terminal.js';

const DAY = 86_400_000;

export function registerProjectIpc(
  engine: Engine,
  manager: BrainManager,
  github: GitHub,
  getWindow: () => BrowserWindow | null,
): void {
  const handle = <A extends unknown[], R>(channel: string, fn: (...args: A) => R | Promise<R>) =>
    ipcMain.handle(channel, (_event, ...args: unknown[]) => fn(...(args as A)));
  const projects = engine.store.projects;
  const id = (value: unknown): string => {
    if (typeof value !== 'string' || !/^[\w-]+$/.test(value)) throw new Error('Invalid id');
    return value;
  };
  const text = (value: unknown, max = 20_000): string =>
    typeof value === 'string' ? value.slice(0, max) : '';
  const mustGet = (projectId: string): Project => {
    const p = projects.get(id(projectId));
    if (!p) throw new Error('That project no longer exists.');
    return p;
  };
  const retryOptions = (opts: unknown): RetryOptions => {
    const o = (opts ?? {}) as Record<string, unknown>;
    return {
      ...(o.seat !== undefined && { seat: Seat.parse(o.seat) }),
      ...(o.effortUp === true && { effortUp: true }),
      ...(typeof o.spec === 'string' && { spec: text(o.spec) }),
      ...(typeof o.feedback === 'string' && { feedback: text(o.feedback) }),
      ...(o.feedback === null && { feedback: null }),
    };
  };
  const send = (channel: string, payload: unknown) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };
  const lastEventId = (projectId: string) => projects.events(projectId, { latest: 1 })[0]?.id ?? 0;
  /** Actions taken outside a running brain log too; the window hears about them like any event. */
  const announce = (projectId: string, since: number) => {
    for (const event of projects.events(projectId, { afterId: since })) {
      send(IPC.projectsEvent, event);
    }
  };

  // Live activity for every project goes to the window as it happens.
  manager.onEvent((event) => send(IPC.projectsEvent, event));

  handle(IPC.projectsList, (): ProjectSummary[] =>
    projects.list().map((project) => {
      const tasks = projects.listTasks(project.id);
      const count = (...s: string[]) => tasks.filter((t) => s.includes(t.status)).length;
      return {
        project,
        running: manager.isRunning(project.id),
        counts: {
          queued: count('queued'),
          active: count(...IN_FLIGHT),
          merged: count('merged'),
          failed: count('failed'),
          // Replaced and skipped work leaves the total, so failures never inflate it.
          total: taskProgress(tasks).total,
        },
        pendingApprovals: projects.approvals(project.id, 'pending').length,
        lastEvent: projects.events(project.id, { latest: 1 }).at(-1) ?? null,
      };
    }),
  );

  handle(IPC.projectsGet, (projectId: string): ProjectDetail | null => {
    const project = projects.get(id(projectId));
    if (!project) return null;
    const tasks = projects.listTasks(project.id);
    return {
      project,
      running: manager.isRunning(project.id),
      tasks,
      events: projects.events(project.id, { latest: 400 }),
      approvals: projects.approvals(project.id),
      decisions: engine.store.decisions.list(project.id),
      problems: providerProblems(tasks).map((p) => ({
        provider: p.provider,
        kind: p.kind,
        summary: p.summary,
        taskIds: p.tasks.map((t) => t.id),
      })),
      limits: activeLimits(engine.store, project.id).filter((l) =>
        [...project.routing.planner, ...project.routing.builder, ...project.routing.reviewer].some(
          (s) => s.provider === l.provider,
        ),
      ),
      preview: previewOf(project),
    };
  });

  /** What the project would preview: what's merged so far, or the repo before the first run. */
  const previewOf = (project: Project): ProjectDetail['preview'] => {
    const ws = projectWorkspace(engine.home, project);
    const plan = detectPreview(
      existsSync(ws.integrationPath) ? ws.integrationPath : project.repoPath,
    );
    if (plan.kind === 'static') return { kind: 'static' };
    if (plan.kind === 'command') {
      return {
        kind: 'command',
        command: plan.command,
        allowed: project.previewCommand === plan.command,
      };
    }
    return null;
  };

  handle(IPC.projectsSnapshots, (projectId: string, taskId: string): TaskSnapshots => {
    const project = mustGet(projectId);
    const after = engine.store.snapshots.forTask(project.id, id(taskId)) ?? null;
    const before = after?.beforeId ? (engine.store.snapshots.get(after.beforeId) ?? null) : null;
    return { after, before };
  });

  // Screenshots are read only from Conclave's own projects folder, and only PNGs.
  handle(IPC.projectsShot, (path: unknown): string => {
    const base = realpathSync.native(join(engine.home, 'projects'));
    const file = typeof path === 'string' ? resolve(path) : '';
    if (!file.toLowerCase().endsWith('.png') || !existsSync(file))
      throw new Error('No such screenshot.');
    const real = realpathSync.native(file);
    if (!real.startsWith(base + sep)) throw new Error('No such screenshot.');
    return `data:image/png;base64,${readFileSync(real).toString('base64')}`;
  });

  handle(IPC.projectsPickRepo, async (): Promise<string | null> => {
    // End-to-end tests can't click a native dialog.
    if (process.env.CONCLAVE_E2E_REPO) return process.env.CONCLAVE_E2E_REPO;
    const win = getWindow();
    const options = {
      title: 'Choose a project folder',
      buttonLabel: 'Use this folder',
      properties: ['openDirectory' as const, 'createDirectory' as const],
    };
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  handle(IPC.projectsInspectRepo, (path: string) => inspectRepo(text(path, 4096)));
  handle(IPC.projectsInspectFolder, (path: string) => inspectFolder(text(path, 4096)));
  handle(IPC.projectsSetUpGit, (path: string, confirmLarge?: boolean) =>
    setUpGit(text(path, 4096), { confirmLarge: confirmLarge === true }),
  );
  handle(IPC.projectsDefaultFolder, () => projectsFolder());
  handle(IPC.projectsCreateFolder, (name: string, parent?: string) => {
    const where = parent ? resolve(text(parent, 4096)) : projectsFolder();
    mkdirSync(where, { recursive: true });
    return createProjectFolder(where, text(name, 200));
  });

  handle(IPC.projectsCreate, async (input: NewProjectInput) => {
    const project = await createProject(engine.store, await engine.readySeats(), {
      repoPath: text(input.repoPath, 4096),
      goal: text(input.goal),
      ...(input.name && { name: text(input.name, 200) }),
      ...(input.doneWhen && { doneWhen: text(input.doneWhen) }),
      ...(input.testCommand && { testCommand: text(input.testCommand, 1000) }),
      ...(input.routing && { routing: Routing.partial().parse(input.routing) }),
      ...(input.maxAttempts && {
        maxAttempts: Math.max(1, Math.min(10, Number(input.maxAttempts))),
      }),
      ...(input.maxParallel && { maxParallel: clampParallel(Number(input.maxParallel)) }),
      ...(input.adaptiveTeam !== undefined && { adaptiveTeam: Boolean(input.adaptiveTeam) }),
      ...(input.retryStrategy && { retryStrategy: RetryStrategy.parse(input.retryStrategy) }),
      ...(input.askPolicy && { askPolicy: AskPolicy.parse(input.askPolicy) }),
      ...(input.permissions && { permissions: checkPermissions(input.permissions) }),
      ...(input.designDirection && { designDirection: text(input.designDirection, 2000) }),
      ...(input.draft && { draft: true }),
    });
    // A clone of a GitHub repository knows where it came from.
    const link = await linkRepo(engine, github, project).catch(() => undefined);
    const issue = input.github?.issue;
    if (link && issue && Number.isInteger(issue.number)) {
      projects.update(project.id, {
        github: {
          ...link,
          issue: {
            number: issue.number,
            title: text(issue.title, 300),
            url: /^https:\/\/github\.com\//.test(issue.url) ? text(issue.url, 500) : '',
          },
        },
      });
    }
    return projects.get(project.id)!;
  });

  handle(IPC.projectsUpdate, (projectId: string, settings: ProjectSettings) => {
    const project = mustGet(projectId);
    const since = lastEventId(project.id);
    const next = projects.update(project.id, {
      ...(settings.name !== undefined && { name: text(settings.name, 200) || project.name }),
      ...(settings.goal !== undefined && { goal: text(settings.goal) || project.goal }),
      ...(settings.doneWhen !== undefined && {
        doneWhen: settings.doneWhen ? text(settings.doneWhen) : null,
      }),
      ...(settings.testCommand !== undefined && {
        testCommand: settings.testCommand ? text(settings.testCommand, 1000) : null,
      }),
      ...(settings.designDirection !== undefined && {
        designDirection: settings.designDirection ? text(settings.designDirection, 2000) : null,
      }),
      ...(settings.routing && { routing: Routing.parse(settings.routing) }),
      ...(settings.maxAttempts && {
        maxAttempts: Math.max(1, Math.min(10, Number(settings.maxAttempts))),
      }),
      ...(settings.maxParallel && { maxParallel: clampParallel(Number(settings.maxParallel)) }),
      ...(settings.adaptiveTeam !== undefined && { adaptiveTeam: Boolean(settings.adaptiveTeam) }),
      ...(settings.retryStrategy && {
        retryStrategy: RetryStrategy.parse(settings.retryStrategy),
      }),
      ...(settings.askPolicy && { askPolicy: AskPolicy.parse(settings.askPolicy) }),
      ...(settings.permissions && { permissions: checkPermissions(settings.permissions) }),
      ...(settings.visualReview !== undefined && { visualReview: Boolean(settings.visualReview) }),
      // The store keeps up to five, each starting with "/".
      ...(Array.isArray(settings.pages) && {
        pages: settings.pages
          .filter((p): p is string => typeof p === 'string')
          .map((p) => text(p, 200)),
      }),
    })!;
    projects.log({
      projectId: project.id,
      kind: 'task',
      message: 'You changed the project settings; they apply from the next step',
    });
    announce(project.id, since);
    return next;
  });

  handle(
    IPC.projectsClarify,
    (projectId: string, answers?: { question: string; answer: string }[]) =>
      clarify(engine, mustGet(projectId).id, {
        ...(Array.isArray(answers) && {
          answers: answers.slice(0, 20).map((a) => ({
            question: text(a?.question, 1000),
            answer: text(a?.answer, 2000),
          })),
        }),
      }),
  );
  handle(IPC.projectsStartDraft, (projectId: string, input: DraftStart) => {
    const project = mustGet(projectId);
    const since = lastEventId(project.id);
    const started = startDraft(engine, project.id, {
      answers: (input.answers ?? []).slice(0, 20).map((a) => ({
        question: text(a.question, 1000),
        answer: text(a.answer, 2000),
        ...(a.assumed && { assumed: true }),
      })),
      tasks: (input.tasks ?? []).slice(0, 30).map((t) => ({
        title: text(t.title, 200),
        spec: text(t.spec),
      })),
      testCommand: input.testCommand ? text(input.testCommand, 1000) : null,
    });
    announce(project.id, since);
    return started;
  });

  handle(IPC.projectsRetry, (taskId: string, opts?: unknown) =>
    manager.retry(id(taskId), retryOptions(opts)),
  );
  handle(IPC.projectsSkip, (taskId: string) => manager.skip(id(taskId)));
  handle(IPC.projectsMoveTask, (taskId: string, direction: unknown) =>
    manager.moveTask(id(taskId), direction === 'up' ? 'up' : 'down'),
  );
  handle(IPC.projectsEditTask, (taskId: string, patch: { title?: unknown; spec?: unknown }) =>
    manager.editTask(id(taskId), {
      ...(typeof patch?.title === 'string' && { title: text(patch.title, 200) }),
      ...(typeof patch?.spec === 'string' && { spec: text(patch.spec) }),
    }),
  );
  handle(
    IPC.projectsAddTask,
    (projectId: string, input: { title?: unknown; spec?: unknown; after?: unknown }) => {
      const title = typeof input?.title === 'string' ? text(input.title, 200) : '';
      if (!title) throw new Error('A task needs a title.');
      return manager.addTask(mustGet(projectId).id, {
        title,
        spec: typeof input.spec === 'string' ? text(input.spec) : title,
        after: Array.isArray(input.after)
          ? input.after.filter((a): a is string => typeof a === 'string')
          : [],
      });
    },
  );
  handle(IPC.projectsSteering, (projectId: string) => manager.steering(mustGet(projectId).id));
  handle(IPC.projectsSteer, (projectId: string, message: unknown) => {
    const body = typeof message === 'string' ? text(message, 4000) : '';
    if (!body) throw new Error('Write a message first.');
    return manager.steer(mustGet(projectId).id, body);
  });
  handle(IPC.projectsApplySteering, (messageId: string, indexes: unknown) =>
    manager.applySteering(
      id(messageId),
      Array.isArray(indexes) ? indexes.filter((i): i is number => Number.isInteger(i)) : [],
    ),
  );
  const optId = (v: unknown) => (typeof v === 'string' && v ? id(v) : undefined);
  handle(IPC.projectsPreview, (projectId: string, taskId?: unknown) =>
    manager.preview(mustGet(projectId).id, { ...(optId(taskId) && { taskId: optId(taskId)! }) }),
  );
  handle(IPC.projectsAllowPreview, async (projectId: string, command: unknown) => {
    const project = mustGet(projectId);
    // Only the command Conclave detected and showed you can be allowed, never one sent from the page.
    const shown = await manager.preview(project.id);
    if (shown.kind !== 'needs_approval' || shown.command !== command) {
      throw new Error(
        'That preview command no longer matches the project. Open the preview again.',
      );
    }
    return manager.allowPreviewCommand(project.id, shown.command);
  });
  handle(IPC.projectsStopPreview, (projectId: string, taskId?: unknown) =>
    manager.stopPreview(mustGet(projectId).id, optId(taskId)),
  );
  handle(IPC.projectsPreviewLogs, (projectId: string, taskId?: unknown) =>
    manager.previewLogs(mustGet(projectId).id, optId(taskId)),
  );
  handle(IPC.projectsDismissSteering, (messageId: string) =>
    manager.dismissSteering(id(messageId)),
  );
  handle(
    IPC.projectsRetryFailed,
    (projectId: string, filter: { provider?: string; kind?: string }, opts?: unknown) =>
      manager.retryFailed(
        mustGet(projectId).id,
        {
          ...(filter?.provider && { provider: ProviderId.parse(filter.provider) }),
          ...(filter?.kind && { kind: FailureKind.parse(filter.kind) }),
        },
        retryOptions(opts),
      ),
  );
  handle(IPC.projectsTeamInsights, (routing: unknown): TeamInsights => {
    const governor = new Governor(() => engine.store.listQuotas());
    const insights = routingInsights(
      Routing.parse(routing),
      (role) => engine.store.usage.roleRuns(role),
      (p) => governor.utilization(p),
    );
    return {
      planner: { reasons: insights.planner.reasons },
      builder: { reasons: insights.builder.reasons },
      reviewer: { reasons: insights.reviewer.reasons },
    };
  });

  handle(IPC.projectsPermissionGaps, (permissions: unknown): PermissionGaps => {
    const run = builderPermissions(checkPermissions(permissions));
    const gaps: PermissionGaps = {};
    for (const adapter of engine.adapters.values()) {
      const gap = adapter.permissionGap?.(run);
      if (gap) gaps[adapter.id] = gap;
    }
    return gaps;
  });

  handle(IPC.projectsStart, (projectId: string, at?: unknown) => {
    mustGet(projectId);
    // A later start is at most a day away; anything else starts now.
    const later =
      typeof at === 'number' && Number.isFinite(at) && at > Date.now() && at < Date.now() + DAY
        ? at
        : undefined;
    manager.start(projectId, later ? { at: later } : {});
  });

  handle(IPC.projectsStartCheck, (projectId: string) => manager.startCheck(mustGet(projectId).id));

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

  /* ── Decisions ───────────────────────────────────────────────────── */

  handle(IPC.decisionsAdd, (projectId: string, question: string, answer: string) => {
    const project = mustGet(projectId);
    if (!text(question).trim() || !text(answer).trim()) throw new Error('Write both parts.');
    return engine.store.decisions.add({
      projectId: project.id,
      kind: 'decision',
      question: text(question, 1000),
      answer: text(answer, 2000),
      source: 'you',
    });
  });
  handle(
    IPC.decisionsKeep,
    (decisionId: string) => engine.store.decisions.keep(id(decisionId)) ?? null,
  );
  handle(IPC.decisionsChange, (decisionId: string, answer: string, addTask?: boolean) => {
    const before = engine.store.decisions.get(id(decisionId));
    if (!before || !text(answer).trim()) return null;
    const since = lastEventId(before.projectId);
    const changed = engine.store.decisions.change(before.id, text(answer, 2000))!;
    projects.log({
      projectId: changed.projectId,
      kind: 'decision',
      message: `You changed: ${changed.question} → ${changed.answer}`,
    });
    if (addTask) {
      projects.addTasks(changed.projectId, [
        {
          title: `Apply: ${changed.question}`.slice(0, 200),
          spec: `The user changed a decision. "${changed.question}" is now: ${changed.answer} (it was: ${before.answer}). Update the existing code to follow it, and adjust the tests.`,
        },
      ]);
      const project = projects.get(changed.projectId);
      if (project && ['done', 'paused'].includes(project.status)) {
        projects.setStatus(project.id, 'idle', 'A follow-up task is queued');
      }
    }
    announce(changed.projectId, since);
    return changed;
  });

  /* ── Inbox ───────────────────────────────────────────────────────── */

  handle(IPC.approvalsList, (): ApprovalItem[] =>
    projects.approvals().flatMap((approval) => {
      const project = projects.get(approval.projectId);
      return project ? [{ approval, project }] : [];
    }),
  );

  handle(
    IPC.approvalsDecide,
    async (approvalId: string, decision: 'approved' | 'rejected', opts?: DecideOptions) => {
      if (decision !== 'approved' && decision !== 'rejected') throw new Error('Invalid decision');
      const pending = projects.getApproval(id(approvalId));
      const since = pending ? lastEventId(pending.projectId) : 0;
      const result = await manager.answer(
        approvalId,
        decision,
        typeof opts?.answer === 'string' ? text(opts.answer, 2000) : undefined,
        {
          ...(opts?.via === 'pr' && { via: 'pr' as const }),
          ...(opts?.draft && { draft: true }),
          github,
        },
      );
      if (pending) announce(pending.projectId, since);
      return result.ok
        ? { ok: true, ...(result.url && { url: result.url }) }
        : { ok: false, error: result.error };
    },
  );

  /* ── GitHub ──────────────────────────────────────────────────────── */

  handle(IPC.githubStatus, () => github.detect());
  handle(IPC.githubSignIn, () => openInTerminal(github.login()));
  handle(IPC.githubRepos, (owner?: string) =>
    github.listRepos(owner ? text(owner, 100) : undefined),
  );
  handle(IPC.githubClone, async (repo: string, parent?: string) => {
    const where = parent ? resolve(text(parent, 4096)) : projectsFolder();
    mkdirSync(where, { recursive: true });
    const dest = join(where, basename(text(repo, 200)));
    await github.clone(text(repo, 200), dest);
    return dest;
  });
  handle(IPC.githubIssues, (repoPath: string) => github.listIssues(text(repoPath, 4096)));
  handle(IPC.githubPrStatus, async (projectId: string) => {
    const project = mustGet(projectId);
    const since = lastEventId(project.id);
    const status = (await pullRequestStatus(engine, github, project.id)) ?? null;
    announce(project.id, since);
    return status;
  });
  handle(IPC.githubFixCheck, (projectId: string, check: GhCheck) => {
    const project = mustGet(projectId);
    const since = lastEventId(project.id);
    const link = text(check?.link, 1000);
    const task = fixFailingCheck(engine, project.id, {
      name: text(check?.name, 300),
      state: text(check?.state, 50),
      bucket: 'fail',
      link: /^https:\/\//.test(link) ? link : '',
      workflow: text(check?.workflow, 300),
    });
    announce(project.id, since);
    return task;
  });
  handle(IPC.githubPublish, (projectId: string, input: { name: string; private: boolean }) => {
    const project = mustGet(projectId);
    const since = lastEventId(project.id);
    const approval = requestPublish(engine, project.id, {
      name: text(input?.name, 100),
      private: input?.private !== false,
    });
    announce(project.id, since);
    return approval;
  });

  handle(IPC.usageReport, (): UsageReport => {
    const now = Date.now();
    return {
      day: engine.store.usage.totals(now - DAY),
      week: engine.store.usage.totals(now - 7 * DAY),
      images: {
        day: engine.store.usage.images(now - DAY),
        week: engine.store.usage.images(now - 7 * DAY),
      },
      daily: engine.store.usage.daily(14, now),
      recent: engine.store.usage.recent(40),
      quotas: engine.store.listQuotas(),
    };
  });
}

/** Where new and cloned projects go; tests point it at a temp folder. */
function projectsFolder(): string {
  return process.env.CONCLAVE_PROJECTS_DIR ?? defaultProjectsFolder();
}

/** Level 5 always comes with an expiry: 24 hours unless set sooner. */
function checkPermissions(value: unknown): Permissions {
  const p = Permissions.parse(value);
  if (p.level !== 5) return { ...p, expiresAt: null };
  const day = Date.now() + DAY;
  return { ...p, expiresAt: p.expiresAt && p.expiresAt < day ? p.expiresAt : day };
}

/** Older callers: is this a usable repo, and what test command does it probably use? */
export async function inspectRepo(path: string): Promise<RepoInfo> {
  const state = await inspectFolder(path);
  switch (state.kind) {
    case 'ready':
      return {
        path,
        ok: true,
        root: state.root,
        name: state.name,
        branch: state.branch,
        ...(state.suggestedTest && { suggestedTest: state.suggestedTest }),
      };
    case 'nested':
      return { path, ok: true, root: state.root, name: state.name, branch: state.branch };
    case 'missing':
      return { path, ok: false, error: 'That folder does not exist.' };
    case 'not_git':
      return { path, ok: false, error: 'Not a git repository yet.' };
    case 'no_commits':
      return { path, ok: false, error: 'The repository has no commits yet.' };
  }
}
