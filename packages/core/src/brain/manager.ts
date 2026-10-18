import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Approval, BrainEvent, Project } from '@conclave/shared';
import type { EngineContext } from '../chat/service.js';
import { Workspace, mergeCommitDiff, mergeIntoBase } from '../workspace/git.js';
import { Brain, type RoundOutcome } from './brain.js';
import { lockHolder } from './lock.js';

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

export type Decision =
  { ok: true; approval: Approval; commit?: string } | { ok: false; error: string };

/** Approve or reject an inbox item. Approving a `push` merges the work into the base branch. */
export async function decideApproval(
  ctx: EngineContext,
  home: string,
  approvalId: string,
  decision: 'approved' | 'rejected',
): Promise<Decision> {
  const projects = ctx.store.projects;
  const pending = projects.approvals(undefined, 'pending').find((a) => a.id === approvalId);
  if (!pending) return { ok: false, error: 'That request was already decided.' };
  const project = projects.get(pending.projectId);
  if (!project) return { ok: false, error: 'The project no longer exists.' };

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
  if (pending.kind === 'push') {
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
  const approval = projects.decide(approvalId, 'approved')!;
  return { ok: true, approval, ...(commit && { commit }) };
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

  async stopAll(reason: string): Promise<void> {
    await Promise.all([...this.running.keys()].map((id) => this.stop(id, reason)));
  }
}
