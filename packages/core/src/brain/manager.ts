import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type {
  Approval,
  BrainEvent,
  FailureKind,
  Project,
  ProviderId,
  SteeringMessage,
  Task,
} from '@conclave/shared';
import type { EngineContext } from '../chat/service.js';
import { Workspace, mergeCommitDiff, mergeIntoBase } from '../workspace/git.js';
import { Brain, storeGovernor, type RoundOutcome } from './brain.js';
import { PreviewServer, detectPreview } from '../preview/preview.js';
import type { Governor } from '../governor/governor.js';
import { QUESTION_KINDS, answerQuestion, decidePermission } from './answers.js';
import { GitHub } from '../github/gh.js';
import { openPullRequest, publishRepo } from '../github/flows.js';
import { lockHolder } from './lock.js';
import { retryFailed, retryTask, skipTask, type RetryOptions } from './recovery.js';
import { addTask, applySteering, dismissSteering, editTask, moveTask, steer } from './steering.js';

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

  /** One governor for every project, so they share each AI's limits and cooldowns (C4). */
  private readonly governor: Governor;

  constructor(
    private readonly ctx: EngineContext,
    private readonly home: string,
  ) {
    this.governor = storeGovernor(ctx.store);
  }

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
      // Work caught mid-step goes back to the queue now, so nothing looks in progress while paused.
      const interrupted = this.ctx.store.projects.requeueInterrupted(p.id);
      this.ctx.store.projects.setStatus(
        p.id,
        'paused',
        'Conclave closed while this was running. Resume to continue.',
      );
      if (interrupted.length) {
        this.ctx.store.projects.log({
          projectId: p.id,
          kind: 'stop',
          message: `Conclave closed mid-step; ${interrupted.length} interrupted task(s) back in the queue`,
        });
      }
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
      governor: this.governor,
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

  /* ── Steering (C5) ─────────────────────────────────────────────────── */

  moveTask(taskId: string, direction: 'up' | 'down'): Task {
    return this.notify(() => moveTask(this.ctx.store.projects, taskId, direction));
  }

  editTask(taskId: string, patch: { title?: string; spec?: string }): Task {
    return this.notify(() => editTask(this.ctx.store.projects, taskId, patch));
  }

  addTask(projectId: string, input: { title: string; spec: string; after?: string[] }): Task {
    const task = this.notify(() => addTask(this.ctx.store.projects, projectId, input));
    this.reopen(projectId);
    return task;
  }

  steering(projectId: string): SteeringMessage[] {
    return this.ctx.store.steering.list(projectId);
  }

  /** You write to the project; its planner replies with a proposal (nothing changes yet). */
  async steer(projectId: string, text: string) {
    const project = this.ctx.store.projects.get(projectId);
    if (!project) throw new Error('No such project.');
    const cwd = projectWorkspace(this.home, project).integrationPath;
    return steer(this.ctx, project, cwd, text);
  }

  applySteering(messageId: string, indexes: number[]): SteeringMessage {
    const message = this.notify(() => applySteering(this.ctx, messageId, indexes));
    if (message.outcome?.some((o) => o.startsWith('Added '))) this.reopen(message.projectId);
    return message;
  }

  dismissSteering(messageId: string): SteeringMessage {
    return dismissSteering(this.ctx, messageId);
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
    await this.stopPreviews();
  }

  /* ── Live preview (v0.8 C1) ────────────────────────────────────────── */

  private readonly previews = new Map<string, PreviewServer>();
  private sweep: ReturnType<typeof setInterval> | undefined;

  /**
   * Preview a project's integration branch, or one task's worktree. Static sites start at once;
   * a dev server starts only once you've allowed exactly that command for this project.
   */
  async preview(projectId: string, opts: { taskId?: string } = {}): Promise<PreviewResult> {
    const project = this.ctx.store.projects.get(projectId);
    if (!project) throw new Error('No such project.');
    const workspace = projectWorkspace(this.home, project);
    let dir: string;
    if (opts.taskId) {
      dir = workspace.taskPath(opts.taskId);
      if (!existsSync(dir)) return { kind: 'none', reason: 'This task has no worktree right now.' };
    } else {
      dir = existsSync(workspace.integrationPath) ? workspace.integrationPath : project.repoPath;
    }
    const plan = detectPreview(dir);
    if (plan.kind === 'none') return { kind: 'none', reason: plan.reason };
    if (plan.kind === 'command' && project.previewCommand !== plan.command) {
      return { kind: 'needs_approval', command: plan.command };
    }
    const key = previewKey(projectId, opts.taskId);
    let server = this.previews.get(key);
    if (server && (server.dir !== dir || JSON.stringify(server.plan) !== JSON.stringify(plan))) {
      await server.stop();
      server = undefined;
    }
    if (!server) {
      if (opts.taskId) await this.trimTaskPreviews();
      server = new PreviewServer(dir, plan);
      this.previews.set(key, server);
    }
    try {
      const { url } = await server.start();
      this.watchIdle();
      return { kind: 'ready', url, static: plan.kind === 'static' };
    } catch (err) {
      this.previews.delete(key);
      return {
        kind: 'failed',
        error: err instanceof Error ? err.message.split('\n')[0]! : String(err),
        logs: server.logs(),
      };
    }
  }

  /** You allowed this dev-server command for this project's previews: kept as your decision. */
  allowPreviewCommand(projectId: string, command: string): Project {
    const project = this.ctx.store.projects.get(projectId);
    if (!project) throw new Error('No such project.');
    const next = this.ctx.store.projects.update(projectId, { previewCommand: command })!;
    this.ctx.store.decisions.add({
      projectId,
      kind: 'decision',
      question: 'Which command may start live previews?',
      answer: command,
      source: 'you',
    });
    this.notify(() =>
      this.ctx.store.projects.log({
        projectId,
        kind: 'decision',
        message: `You allowed previews with ${command}`,
      }),
    );
    return next;
  }

  previewLogs(projectId: string, taskId?: string): string {
    return this.previews.get(previewKey(projectId, taskId))?.logs() ?? '';
  }

  async stopPreview(projectId: string, taskId?: string): Promise<void> {
    const key = previewKey(projectId, taskId);
    const server = this.previews.get(key);
    this.previews.delete(key);
    await server?.stop();
  }

  async stopPreviews(): Promise<void> {
    const all = [...this.previews.values()];
    this.previews.clear();
    if (this.sweep) clearInterval(this.sweep);
    this.sweep = undefined;
    await Promise.all(all.map((s) => s.stop()));
  }

  /** At most two task previews at once; the least recently used one stops first. */
  private async trimTaskPreviews(): Promise<void> {
    const tasks = [...this.previews.entries()]
      .filter(([k]) => k.includes(':'))
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    while (tasks.length >= MAX_TASK_PREVIEWS) {
      const [key, server] = tasks.shift()!;
      this.previews.delete(key);
      await server.stop();
    }
  }

  /** Previews nobody has looked at for 30 minutes stop by themselves. */
  private watchIdle(): void {
    if (this.sweep) return;
    this.sweep = setInterval(() => {
      const cutoff = Date.now() - PREVIEW_IDLE_MS;
      for (const [key, server] of this.previews) {
        if (server.lastUsed < cutoff) {
          this.previews.delete(key);
          void server.stop();
        }
      }
      if (this.previews.size === 0 && this.sweep) {
        clearInterval(this.sweep);
        this.sweep = undefined;
      }
    }, 60_000);
    this.sweep.unref?.();
  }
}

const MAX_TASK_PREVIEWS = 2;
const PREVIEW_IDLE_MS = 30 * 60_000;
const previewKey = (projectId: string, taskId?: string) =>
  taskId ? `${projectId}:${taskId}` : projectId;

/** What opening a preview gave: a URL, a command to allow first, nothing to preview, or why it failed. */
export type PreviewResult =
  | { kind: 'ready'; url: string; static: boolean }
  | { kind: 'needs_approval'; command: string }
  | { kind: 'none'; reason: string }
  | { kind: 'failed'; error: string; logs: string };
