import type { DatabaseSync } from 'node:sqlite';
import type {
  Approval,
  BrainEvent,
  BrainEventKind,
  Project,
  ProjectStatus,
  ProviderId,
  Routing,
  Task,
  TaskStatus,
} from '@conclave/shared';
import { transaction } from './db.js';
import { newId } from './ids.js';

type Row = Record<string, unknown>;

export interface NewProject {
  name: string;
  repoPath: string;
  goal: string;
  doneWhen?: string | null;
  testCommand?: string | null;
  baseBranch: string;
  integrationBranch?: string;
  routing: Routing;
  maxAttempts?: number;
}

/** Projects, their task queue, the brain's event log and the approvals inbox. */
export class ProjectStore {
  constructor(private readonly db: DatabaseSync) {}

  create(input: NewProject): Project {
    const now = Date.now();
    const project: Project = {
      id: newId('p'),
      name: input.name,
      repoPath: input.repoPath,
      goal: input.goal,
      doneWhen: input.doneWhen ?? null,
      testCommand: input.testCommand ?? null,
      baseBranch: input.baseBranch,
      integrationBranch: input.integrationBranch ?? 'conclave/integration',
      routing: input.routing,
      maxAttempts: input.maxAttempts ?? 3,
      status: 'idle',
      statusReason: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO projects (id, name, repo_path, goal, done_when, test_command, base_branch,
           integration_branch, routing, max_attempts, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        project.id,
        project.name,
        project.repoPath,
        project.goal,
        project.doneWhen,
        project.testCommand,
        project.baseBranch,
        project.integrationBranch,
        JSON.stringify(project.routing),
        project.maxAttempts,
        project.status,
        now,
        now,
      );
    return project;
  }

  get(id: string): Project | undefined {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Row | undefined;
    return row && toProject(row);
  }

  /** Full id or a unique prefix. */
  find(idOrPrefix: string): Project | undefined {
    const exact = this.get(idOrPrefix);
    if (exact) return exact;
    const rows = this.db
      .prepare("SELECT * FROM projects WHERE id LIKE ? ESCAPE '!' LIMIT 2")
      .all(`${idOrPrefix.replace(/[!%_]/g, '!$&')}%`) as Row[];
    return rows.length === 1 ? toProject(rows[0]!) : undefined;
  }

  list(): Project[] {
    return (this.db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all() as Row[]).map(
      toProject,
    );
  }

  setStatus(id: string, status: ProjectStatus, reason: string | null = null): void {
    this.db
      .prepare('UPDATE projects SET status = ?, status_reason = ?, updated_at = ? WHERE id = ?')
      .run(status, reason, Date.now(), id);
  }

  update(
    id: string,
    patch: Partial<
      Pick<Project, 'goal' | 'doneWhen' | 'testCommand' | 'routing' | 'maxAttempts' | 'name'>
    >,
  ): Project | undefined {
    const current = this.get(id);
    if (!current) return undefined;
    const next = { ...current, ...patch, updatedAt: Date.now() };
    this.db
      .prepare(
        `UPDATE projects SET name = ?, goal = ?, done_when = ?, test_command = ?, routing = ?,
           max_attempts = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        next.name,
        next.goal,
        next.doneWhen,
        next.testCommand,
        JSON.stringify(next.routing),
        next.maxAttempts,
        next.updatedAt,
        id,
      );
    return next;
  }

  /* ── Tasks ─────────────────────────────────────────────────────────── */

  addTasks(projectId: string, tasks: { title: string; spec: string }[]): Task[] {
    return transaction(this.db, () => {
      const { top } = this.db
        .prepare('SELECT COALESCE(MAX(priority), 0) AS top FROM tasks WHERE project_id = ?')
        .get(projectId) as { top: number };
      return tasks.map((t, i) => {
        const now = Date.now();
        const task: Task = {
          id: newId('k'),
          projectId,
          title: t.title.trim().slice(0, 200),
          spec: t.spec.trim(),
          status: 'queued',
          priority: top + i + 1,
          attempts: 0,
          feedback: null,
          builtBy: null,
          reviewedBy: null,
          mergeCommit: null,
          createdAt: now,
          updatedAt: now,
        };
        this.db
          .prepare(
            `INSERT INTO tasks (id, project_id, title, spec, status, priority, attempts, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
          )
          .run(task.id, projectId, task.title, task.spec, task.status, task.priority, now, now);
        return task;
      });
    });
  }

  getTask(id: string): Task | undefined {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Row | undefined;
    return row && toTask(row);
  }

  listTasks(projectId: string): Task[] {
    return (
      this.db
        .prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY priority, created_at')
        .all(projectId) as Row[]
    ).map(toTask);
  }

  nextQueued(projectId: string): Task | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM tasks WHERE project_id = ? AND status = 'queued' ORDER BY priority, created_at LIMIT 1",
      )
      .get(projectId) as Row | undefined;
    return row && toTask(row);
  }

  updateTask(
    id: string,
    patch: Partial<
      Pick<Task, 'status' | 'attempts' | 'feedback' | 'builtBy' | 'reviewedBy' | 'mergeCommit'>
    >,
  ): Task {
    const current = this.getTask(id);
    if (!current) throw new Error(`No such task: ${id}`);
    const next = { ...current, ...patch, updatedAt: Date.now() };
    this.db
      .prepare(
        `UPDATE tasks SET status = ?, attempts = ?, feedback = ?, built_by = ?, reviewed_by = ?,
           merge_commit = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        next.status,
        next.attempts,
        next.feedback,
        next.builtBy,
        next.reviewedBy,
        next.mergeCommit,
        next.updatedAt,
        id,
      );
    return next;
  }

  /** After a crash, tasks caught mid-step go back to the queue (the attempt doesn't count). */
  requeueInterrupted(projectId: string): Task[] {
    const stuck = this.listTasks(projectId).filter((t) =>
      (['building', 'verifying', 'reviewing'] as TaskStatus[]).includes(t.status),
    );
    for (const t of stuck) this.updateTask(t.id, { status: 'queued' });
    return stuck;
  }

  /* ── Event log ─────────────────────────────────────────────────────── */

  log(event: {
    projectId: string;
    taskId?: string | null;
    kind: BrainEventKind;
    message: string;
    provider?: ProviderId | null;
    data?: unknown;
  }): BrainEvent {
    const at = Date.now();
    const result = this.db
      .prepare(
        `INSERT INTO brain_events (project_id, task_id, kind, message, provider, data, at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.projectId,
        event.taskId ?? null,
        event.kind,
        event.message,
        event.provider ?? null,
        event.data === undefined ? null : JSON.stringify(event.data),
        at,
      );
    return {
      id: Number(result.lastInsertRowid),
      projectId: event.projectId,
      taskId: event.taskId ?? null,
      kind: event.kind,
      message: event.message,
      provider: event.provider ?? null,
      data: event.data ?? null,
      at,
    };
  }

  events(projectId: string, opts: { afterId?: number; limit?: number } = {}): BrainEvent[] {
    return (
      this.db
        .prepare('SELECT * FROM brain_events WHERE project_id = ? AND id > ? ORDER BY id LIMIT ?')
        .all(projectId, opts.afterId ?? 0, opts.limit ?? 500) as Row[]
    ).map(toEvent);
  }

  /* ── Approvals ─────────────────────────────────────────────────────── */

  requestApproval(input: {
    projectId: string;
    taskId?: string | null;
    kind: Approval['kind'];
    summary: string;
    payload?: unknown;
  }): Approval {
    const approval: Approval = {
      id: newId('a'),
      projectId: input.projectId,
      taskId: input.taskId ?? null,
      kind: input.kind,
      summary: input.summary,
      payload: input.payload ?? null,
      status: 'pending',
      createdAt: Date.now(),
      decidedAt: null,
    };
    this.db
      .prepare(
        `INSERT INTO approvals (id, project_id, task_id, kind, summary, payload, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(
        approval.id,
        approval.projectId,
        approval.taskId,
        approval.kind,
        approval.summary,
        approval.payload === null ? null : JSON.stringify(approval.payload),
        approval.createdAt,
      );
    return approval;
  }

  approvals(projectId?: string, status?: Approval['status']): Approval[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM approvals WHERE (? IS NULL OR project_id = ?) AND (? IS NULL OR status = ?)
         ORDER BY created_at DESC`,
      )
      .all(projectId ?? null, projectId ?? null, status ?? null, status ?? null) as Row[];
    return rows.map(toApproval);
  }

  decide(id: string, status: 'approved' | 'rejected'): Approval | undefined {
    this.db
      .prepare(
        "UPDATE approvals SET status = ?, decided_at = ? WHERE id = ? AND status = 'pending'",
      )
      .run(status, Date.now(), id);
    const row = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Row | undefined;
    return row && toApproval(row);
  }
}

const parse = (v: unknown) => (typeof v === 'string' ? (JSON.parse(v) as unknown) : null);

function toProject(r: Row): Project {
  return {
    id: r.id as string,
    name: r.name as string,
    repoPath: r.repo_path as string,
    goal: r.goal as string,
    doneWhen: (r.done_when as string | null) ?? null,
    testCommand: (r.test_command as string | null) ?? null,
    baseBranch: r.base_branch as string,
    integrationBranch: r.integration_branch as string,
    routing: parse(r.routing) as Routing,
    maxAttempts: r.max_attempts as number,
    status: r.status as ProjectStatus,
    statusReason: (r.status_reason as string | null) ?? null,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  };
}

function toTask(r: Row): Task {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    title: r.title as string,
    spec: r.spec as string,
    status: r.status as TaskStatus,
    priority: r.priority as number,
    attempts: r.attempts as number,
    feedback: (r.feedback as string | null) ?? null,
    builtBy: (r.built_by as ProviderId | null) ?? null,
    reviewedBy: (r.reviewed_by as ProviderId | null) ?? null,
    mergeCommit: (r.merge_commit as string | null) ?? null,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  };
}

function toEvent(r: Row): BrainEvent {
  return {
    id: r.id as number,
    projectId: r.project_id as string,
    taskId: (r.task_id as string | null) ?? null,
    kind: r.kind as BrainEventKind,
    message: r.message as string,
    provider: (r.provider as ProviderId | null) ?? null,
    data: parse(r.data),
    at: r.at as number,
  };
}

function toApproval(r: Row): Approval {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    taskId: (r.task_id as string | null) ?? null,
    kind: r.kind as Approval['kind'],
    summary: r.summary as string,
    payload: parse(r.payload),
    status: r.status as Approval['status'],
    createdAt: r.created_at as number,
    decidedAt: (r.decided_at as number | null) ?? null,
  };
}
