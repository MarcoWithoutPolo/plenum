import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type {
  Approval,
  BrainEvent,
  FailureKind,
  Project,
  ProviderId,
  Task,
} from '@conclave/shared';
import type { EngineContext } from '../chat/service.js';
import { Workspace, mergeCommitDiff, mergeIntoBase } from '../workspace/git.js';
import { Brain, type RoundOutcome } from './brain.js';
import { QUESTION_KINDS, answerQuestion, decidePermission } from './answers.js';
import { GitHub } from '../github/gh.js';
import { openPullRequest, publishRepo } from '../github/flows.js';
import { lockHolder } from './lock.js';
import { retryFailed, retryTask, skipTask, type RetryOptions } from './recovery.js';

export function projectRoot(home: string, projectId: string): string {
  return join(home, 'projects', projectId);
}

export function projectWorkspace(home: string, project: Project): Workspace {
  return new Workspace(project.repoPath, projectRoot(home, project.id), project.integrationBranch);
}

/** Is a brain (here or in another process) working on this project right now? */
export function isProjectRunning(home: string, projectId: string): boolean {
  return lockHolder(join(projectRoot(home, projectId), 'run.lock')) !== undefined;
}

export type ApprovalOutcome =
  { ok: true; approval: Approval; commit?: string; url?: string } | { ok: false; error: string };

export interface ApprovalOptions {
  /** For a finished project's push: merge into your branch here (default) or open a pull request. */
  via?: 'merge' | 'pr';
  draft?: boolean;
  /** Injected for tests. */
  github?: GitHub;
}

/** Approve or reject an inbox item. Approving a `push` merges the work into the base branch. */
export async function decideApproval(
  ctx: EngineContext,
  home: string,
  approvalId: string,
  decision: 'approved' | 'rejected',
  answer?: string,
  opts: ApprovalOptions = {},
): Promise<ApprovalOutcome> {
  const projects = ctx.store.projects;
  const pending = projects.approvals(undefined, 'pending').find((a) => a.id === approvalId);
  if (!pending) return { ok: false, error: 'That request was already decided.' };
  const project = projects.get(pending.projectId);
  if (!project) return { ok: false, error: 'The project no longer exists.' };

  if (QUESTION_KINDS.has(pending.kind)) {
    // Questions need words; install and network requests are a yes or no (with an optional note).
    const outcome =
      pending.kind === 'question'
        ? decision === 'approved'
          ? answerQuestion(ctx.store, approvalId, answer ?? '')
          : { ok: false as const, error: 'Answer the question, or pick one of its options.' }
        : decidePermission(ctx.store, approvalId, decision === 'approved', answer);
    return outcome.ok ? { ok: true, approval: outcome.approval } : outcome;
  }

  if (decision === 'rejected') {
    const approval = projects.decide(approvalId, 'rejected')!;
    projects.log({
      projectId: project.id,
      kind: 'approval',
      message: `You declined: ${pending.summary}`,
    });
    return { ok: true, approval };
  }

  let commit: string | undefined;
  let url: string | undefined;
  if (pending.kind === 'create_repo') {
    const published = await publishRepo(ctx, opts.github ?? new GitHub(), pending);
    if (!published.ok) return published;
    url = published.url;
  } else if (pending.kind === 'push' && opts.via === 'pr') {
    if (isProjectRunning(home, project.id)) {
      return { ok: false, error: 'Stop the project before pushing its work.' };
    }
    const pr = await openPullRequest(ctx, opts.github ?? new GitHub(), project.id, {
      ...(opts.draft && { draft: true }),
    });
    if (!pr.ok) return pr;
    url = pr.url;
  } else if (pending.kind === 'push') {
    if (isProjectRunning(home, project.id)) {
      return { ok: false, error: 'Stop the project before merging its work.' };
    }
    const merged = await mergeIntoBase(
      project.repoPath,
      project.baseBranch,
      project.integrationBranch,
      `Merge ${project.integrationBranch}: ${project.name}\n\n${project.goal.slice(0, 1000)}`,
      join(projectRoot(home, project.id), 'base-merge'),
    );
    if (!merged.ok) return { ok: false, error: merged.error };
    commit = merged.commit;
    projects.log({
      projectId: project.id,
      kind: 'merge',
      message: `You approved: merged into ${project.baseBranch} (${merged.commit.slice(0, 8)})`,
      data: { commit: merged.commit },
    });
  }
  const approval = projects.decide(approvalId, 'approved', url)!;
  return { ok: true, approval, ...(commit && { commit }), ...(url && { url }) };
}

/** The changes a task made: its merge for merged tasks, its live worktree while in progress. */
export async function taskChanges(
  ctx: EngineContext,
  home: string,
  taskId: string,
): Promise<string> {
  const task = ctx.store.projects.getTask(taskId);
  const project = task && ctx.store.projects.get(task.projectId);
  if (!task || !project) return '';
  if (task.mergeCommit) return mergeCommitDiff(project.repoPath, task.mergeCommit);
  const ws = projectWorkspace(home, project);
  if (!existsSync(ws.taskPath(task.id))) return '';
  return (await ws.taskDiff(task.id, 200_000)).diff;
}

/**
 * Runs project brains in the background inside a long-lived process (the
 * desktop app): start, stop, and fan their events out to the UI.
 */
export class BrainManager {
  private readonly running = new Map<
    string,
    { controller: AbortController; done: Promise<RoundOutcome> }
  >();
  private readonly listeners = new Set<(event: BrainEvent) => void>();

  constructor(
    private readonly ctx: EngineContext,
    private readonly home: string,
  ) {}

  onEvent(listener: (event: BrainEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  isRunning(projectId: string): boolean {
    return this.running.has(projectId) || isProjectRunning(this.home, projectId);
  }

  /** Projects left "running" by a closed or crashed app are paused, so nothing restarts by surprise. */
  recoverOrphans(): Project[] {
    const orphans = this.ctx.store.projects
      .list()
      .filter((p) => (p.status === 'running' || p.status === 'waiting') && !this.isRunning(p.id));
    for (const p of orphans) {
      this.ctx.store.projects.setStatus(
        p.id,
        'paused',
        'Conclave closed while this was running. Resume to continue.',
      );
    }
    return orphans;
  }

  start(projectId: string): void {
    if (this.running.has(projectId)) return;
    if (isProjectRunning(this.home, projectId)) {
      throw new Error('This project is already running in another Conclave window or terminal.');
    }
    const controller = new AbortController();
    const brain = new Brain(this.ctx, projectId, {
      home: this.home,
      onEvent: (event) => {
        for (const l of this.listeners) l(event);
      },
    });
    const done = brain
      .run({ signal: controller.signal })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.ctx.store.projects.setStatus(projectId, 'paused', message);
        const event = this.ctx.store.projects.log({ projectId, kind: 'error', message });
        for (const l of this.listeners) l(event);
        return { kind: 'stopped', reason: message } as RoundOutcome;
      })
      .finally(() => this.running.delete(projectId));
    this.running.set(projectId, { controller, done });
  }

  /** Stop now: the agent or test in flight is cancelled and its task returns to the queue. */
  async stop(projectId: string, reason = 'Stopped by you'): Promise<void> {
    const run = this.running.get(projectId);
    this.ctx.store.projects.setStatus(projectId, 'stopped', reason);
    const event = this.ctx.store.projects.log({ projectId, kind: 'stop', message: reason });
    for (const l of this.listeners) l(event);
    if (run) {
      run.controller.abort();
      await run.done;
    }
  }

  /**
   * Answer a question or decide an install/network request. A project that stopped for you
   * starts again by itself once nothing else is waiting.
   */
  async answer(
    approvalId: string,
    decision: 'approved' | 'rejected',
    answer?: string,
    opts: ApprovalOptions = {},
  ): Promise<ApprovalOutcome> {
    const pending = this.ctx.store.projects.getApproval(approvalId);
    const before = pending && this.ctx.store.projects.get(pending.projectId);
    const outcome = await this.notifyAsync(() =>
      decideApproval(this.ctx, this.home, approvalId, decision, answer, opts),
    );
    if (outcome.ok && before?.status === 'needs_you') {
      const after = this.ctx.store.projects.get(before.id);
      if (after?.status === 'idle' && !this.isRunning(before.id)) this.start(before.id);
    }
    return outcome;
  }

  /** Requeue a failed or skipped task; resumes a project that paused on failures. */
  retry(taskId: string, opts: RetryOptions = {}): Task {
    const task = this.notify(() =>
      retryTask(this.ctx.store.projects, taskId, opts, this.ctx.adapters),
    );
    this.reopen(task.projectId);
    return task;
  }

  skip(taskId: string): Task {
    return this.notify(() => skipTask(this.ctx.store.projects, taskId));
  }

  retryFailed(
    projectId: string,
    filter: { provider?: ProviderId; kind?: FailureKind },
    opts: RetryOptions = {},
  ): Task[] {
    const tasks = this.notify(() =>
      retryFailed(this.ctx.store.projects, projectId, filter, opts, this.ctx.adapters),
    );
    if (tasks.length) this.reopen(projectId);
    return tasks;
  }

  /** A finished or failure-paused project becomes startable again once it has new work. */
  private reopen(projectId: string): void {
    const project = this.ctx.store.projects.get(projectId);
    if (project && (project.status === 'done' || project.status === 'paused')) {
      this.ctx.store.projects.setStatus(projectId, 'idle', 'Ready to resume');
    }
  }

  /** Run an action and send the log entries it wrote to the listeners. */
  private notify<T>(action: () => T): T {
    const mark = this.mark();
    const result = action();
    this.flush(mark);
    return result;
  }

  private async notifyAsync<T>(action: () => Promise<T>): Promise<T> {
    const mark = this.mark();
    const result = await action();
    this.flush(mark);
    return result;
  }

  private mark(): Map<string, number> {
    const before = new Map<string, number>();
    for (const p of this.ctx.store.projects.list()) {
      before.set(p.id, this.ctx.store.projects.events(p.id, { latest: 1 })[0]?.id ?? 0);
    }
    return before;
  }

  private flush(before: Map<string, number>): void {
    for (const [projectId, afterId] of before) {
      for (const event of this.ctx.store.projects.events(projectId, { afterId })) {
        for (const l of this.listeners) l(event);
      }
    }
  }

  async stopAll(reason: string): Promise<void> {
    await Promise.all([...this.running.keys()].map((id) => this.stop(id, reason)));
  }
}
