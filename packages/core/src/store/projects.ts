import type { DatabaseSync } from 'node:sqlite';
import {
  DEFAULT_PERMISSIONS,
  type Approval,
  type AskPolicy,
  type GitHubLink,
  type Permissions,
  type RetryStrategy,
  type Seat,
  type TaskFailure,
  type TaskEstimate,
  type TaskGrants,
  type TaskKept,
  type BrainEvent,
  type BrainEventKind,
  type Project,
  type ProjectStatus,
  type ProviderId,
  type Routing,
  type Task,
  type TaskStatus,
  IN_FLIGHT,
} from '@conclave/shared';
import { transaction } from './db.js';
import { newId } from './ids.js';

type Row = Record<string, unknown>;

/**
 * A task changed under a lane: another window skipped it, or another step moved it on. The lane
 * that hit this stops working on it instead of overwriting the change.
 */
export class TaskMovedError extends Error {
  constructor(
    readonly taskId: string,
    readonly status: TaskStatus,
  ) {
    super(`Task ${taskId} is ${status} now`);
    this.name = 'TaskMovedError';
  }
}

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
  maxParallel?: number;
  adaptiveTeam?: boolean;
  pages?: string[];
  visualReview?: boolean;
  reviewEffort?: Project['reviewEffort'];
  retryStrategy?: RetryStrategy;
  askPolicy?: AskPolicy;
  permissions?: Permissions;
  designDirection?: string | null;
  github?: GitHubLink | null;
  /** Created by the wizard before its clarify step; the brain won't run it yet. */
  draft?: boolean;
}

type ProjectPatch = Partial<
  Pick<
    Project,
    | 'goal'
    | 'doneWhen'
    | 'testCommand'
    | 'routing'
    | 'maxAttempts'
    | 'maxParallel'
    | 'adaptiveTeam'
    | 'previewCommand'
    | 'pages'
    | 'visualReview'
    | 'reviewEffort'
    | 'name'
    | 'retryStrategy'
    | 'askPolicy'
    | 'permissions'
    | 'designDirection'
    | 'proposedTestCommand'
    | 'github'
  >
>;

export type TaskPatch = Partial<
  Pick<
    Task,
    | 'status'
    | 'attempts'
    | 'feedback'
    | 'builtBy'
    | 'reviewedBy'
    | 'mergeCommit'
    | 'spec'
    | 'lastFailure'
    | 'freeRetries'
    | 'pinnedSeat'
    | 'replacedBy'
    | 'blockedBy'
    | 'grants'
    | 'actualLines'
    | 'kept'
    | 'after'
    | 'title'
    | 'priority'
  >
>;

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
      maxParallel: clampParallel(input.maxParallel ?? 1),
      adaptiveTeam: input.adaptiveTeam ?? true,
      previewCommand: null,
      pages: cleanPages(input.pages ?? ['/']),
      visualReview: input.visualReview ?? true,
      reviewEffort: input.reviewEffort ?? 'same',
      retryStrategy: input.retryStrategy ?? 'escalate',
      askPolicy: input.askPolicy ?? 'ask',
      permissions: input.permissions ?? DEFAULT_PERMISSIONS,
      designDirection: input.designDirection ?? null,
      proposedTestCommand: null,
      github: input.github ?? null,
      status: input.draft ? 'draft' : 'idle',
      statusReason: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO projects (id, name, repo_path, goal, done_when, test_command, base_branch,
           integration_branch, routing, max_attempts, retry_strategy, ask_policy, permissions,
           design_direction, github, status, max_parallel, adaptive_team, pages, visual_review,
           review_effort, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        project.retryStrategy,
        project.askPolicy,
        JSON.stringify(project.permissions),
        project.designDirection,
        project.github && JSON.stringify(project.github),
        project.status,
        project.maxParallel,
        project.adaptiveTeam ? 1 : 0,
        JSON.stringify(project.pages),
        project.visualReview ? 1 : 0,
        project.reviewEffort,
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

  update(id: string, patch: ProjectPatch): Project | undefined {
    const current = this.get(id);
    if (!current) return undefined;
    const next = { ...current, ...patch, updatedAt: Date.now() };
    this.db
      .prepare(
        `UPDATE projects SET name = ?, goal = ?, done_when = ?, test_command = ?, routing = ?,
           max_attempts = ?, retry_strategy = ?, ask_policy = ?, permissions = ?,
           design_direction = ?, proposed_test_command = ?, github = ?, max_parallel = ?,
           adaptive_team = ?, preview_command = ?, pages = ?, visual_review = ?, review_effort = ?,
           updated_at = ? WHERE id = ?`,
      )
      .run(
        next.name,
        next.goal,
        next.doneWhen,
        next.testCommand,
        JSON.stringify(next.routing),
        next.maxAttempts,
        next.retryStrategy,
        next.askPolicy,
        JSON.stringify(next.permissions),
        next.designDirection,
        next.proposedTestCommand,
        next.github && JSON.stringify(next.github),
        clampParallel(next.maxParallel),
        next.adaptiveTeam ? 1 : 0,
        next.previewCommand,
        JSON.stringify(cleanPages(next.pages)),
        next.visualReview ? 1 : 0,
        next.reviewEffort,
        next.updatedAt,
        id,
      );
    return { ...next, maxParallel: clampParallel(next.maxParallel), pages: cleanPages(next.pages) };
  }

  /* ── Tasks ─────────────────────────────────────────────────────────── */

  addTasks(
    projectId: string,
    tasks: { title: string; spec: string; estimate?: TaskEstimate; after?: string[] }[],
  ): Task[] {
    return transaction(this.db, () => {
      const { top } = this.db
        .prepare('SELECT COALESCE(MAX(priority), 0) AS top FROM tasks WHERE project_id = ?')
        .get(projectId) as { top: number };
      const ids = tasks.map(() => newId('k'));
      return tasks.map((t, i) => {
        const now = Date.now();
        const task: Task = {
          id: ids[i]!,
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
          lastFailure: null,
          freeRetries: 0,
          pinnedSeat: null,
          replacedBy: null,
          blockedBy: null,
          grants: null,
          estimate: t.estimate ?? null,
          // Tasks added together run in order unless told otherwise (safe with lanes).
          after: t.after ?? (i > 0 ? [ids[i - 1]!] : []),
          actualLines: null,
          kept: null,
          createdAt: now,
          updatedAt: now,
        };
        this.db
          .prepare(
            `INSERT INTO tasks (id, project_id, title, spec, status, priority, attempts, estimate, after, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
          )
          .run(
            task.id,
            projectId,
            task.title,
            task.spec,
            task.status,
            task.priority,
            task.estimate && JSON.stringify(task.estimate),
            JSON.stringify(task.after),
            now,
            now,
          );
        return task;
      });
    });
  }

  getTask(id: string): Task | undefined {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Row | undefined;
    return row && toTask(row);
  }

  /** Full id or a unique prefix. */
  findTask(idOrPrefix: string): Task | undefined {
    const exact = this.getTask(idOrPrefix);
    if (exact) return exact;
    const rows = this.db
      .prepare("SELECT * FROM tasks WHERE id LIKE ? ESCAPE '!' LIMIT 2")
      .all(`${idOrPrefix.replace(/[!%_]/g, '!$&')}%`) as Row[];
    return rows.length === 1 ? toTask(rows[0]!) : undefined;
  }

  listTasks(projectId: string): Task[] {
    return (
      this.db
        .prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY priority, created_at')
        .all(projectId) as Row[]
    ).map(toTask);
  }

  /**
   * Tasks building on this provider right now, across every project (shared lane caps). With
   * `live`, only in projects a brain is running: a task a crash left "building" in a stopped
   * project holds no lane (E5).
   */
  countBuilding(provider: ProviderId, live?: (projectId: string) => boolean): number {
    const rows = this.db
      .prepare(
        "SELECT project_id AS p, COUNT(*) AS n FROM tasks WHERE status = 'building' AND built_by = ? GROUP BY project_id",
      )
      .all(provider) as { p: string; n: number }[];
    return rows.filter((r) => !live || live(r.p)).reduce((sum, r) => sum + r.n, 0);
  }

  nextQueued(projectId: string): Task | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM tasks WHERE project_id = ? AND status = 'queued' ORDER BY priority, created_at LIMIT 1",
      )
      .get(projectId) as Row | undefined;
    return row && toTask(row);
  }

  /**
   * Change a task. With `from`, only while its status is one of those (compare and swap, across
   * processes): otherwise nothing is written and a TaskMovedError says what it is now.
   */
  updateTask(id: string, patch: TaskPatch, from?: readonly TaskStatus[]): Task {
    const current = this.getTask(id);
    if (!current) throw new Error(`No such task: ${id}`);
    if (from && !from.includes(current.status)) throw new TaskMovedError(id, current.status);
    const next = { ...current, ...patch, updatedAt: Date.now() };
    const guard = from ? ` AND status IN (${from.map(() => '?').join(', ')})` : '';
    const changed = this.db
      .prepare(
        `UPDATE tasks SET title = ?, priority = ?, status = ?, attempts = ?, feedback = ?, built_by = ?, reviewed_by = ?,
           merge_commit = ?, spec = ?, last_failure = ?, free_retries = ?, pinned_seat = ?,
           replaced_by = ?, blocked_by = ?, grants = ?, actual_lines = ?, after = ?,
           kept = ?, updated_at = ? WHERE id = ?${guard}`,
      )
      .run(
        next.title,
        next.priority,
        next.status,
        next.attempts,
        next.feedback,
        next.builtBy,
        next.reviewedBy,
        next.mergeCommit,
        next.spec,
        next.lastFailure && JSON.stringify(next.lastFailure),
        next.freeRetries,
        next.pinnedSeat && JSON.stringify(next.pinnedSeat),
        next.replacedBy,
        next.blockedBy,
        next.grants && JSON.stringify(next.grants),
        next.actualLines,
        JSON.stringify(next.after),
        next.kept && JSON.stringify(next.kept),
        next.updatedAt,
        id,
        ...(from ?? []),
      );
    if (from && Number(changed.changes) === 0) {
      throw new TaskMovedError(id, this.getTask(id)?.status ?? current.status);
    }
    return next;
  }

  /** The newest usage-limit failure per provider, across all projects or one. */
  latestLimits(projectId?: string): TaskFailure[] {
    const rows = this.db
      .prepare(
        `SELECT last_failure FROM tasks WHERE last_failure LIKE '%"kind":"limit"%'
         AND (? IS NULL OR project_id = ?)`,
      )
      .all(projectId ?? null, projectId ?? null) as Row[];
    const newest = new Map<string, TaskFailure>();
    for (const r of rows) {
      const f = parse(r.last_failure) as TaskFailure | null;
      if (!f?.provider || f.kind !== 'limit') continue;
      const seen = newest.get(f.provider);
      if (!seen || seen.at < f.at) newest.set(f.provider, f);
    }
    return [...newest.values()];
  }

  /** After a crash, tasks caught mid-step go back to the queue (the attempt doesn't count). */
  requeueInterrupted(projectId: string): Task[] {
    const stuck = this.listTasks(projectId).filter((t) => IN_FLIGHT.includes(t.status));
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

  /** Events in order. `latest` returns the newest N (still oldest first); `afterId` pages forward. */
  events(
    projectId: string,
    opts: { afterId?: number; limit?: number; latest?: number } = {},
  ): BrainEvent[] {
    if (opts.latest !== undefined) {
      const rows = this.db
        .prepare('SELECT * FROM brain_events WHERE project_id = ? ORDER BY id DESC LIMIT ?')
        .all(projectId, opts.latest) as Row[];
      return rows.reverse().map(toEvent);
    }
    return (
      this.db
        .prepare('SELECT * FROM brain_events WHERE project_id = ? AND id > ? ORDER BY id LIMIT ?')
        .all(projectId, opts.afterId ?? 0, opts.limit ?? 500) as Row[]
    ).map(toEvent);
  }

  /** Forget a project, its tasks, log and approvals. Its git branches are not touched. */
  remove(id: string): boolean {
    return this.db.prepare('DELETE FROM projects WHERE id = ?').run(id).changes > 0;
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
      answer: null,
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

  getApproval(id: string): Approval | undefined {
    const row = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Row | undefined;
    return row && toApproval(row);
  }

  /** Full id or a unique prefix. */
  findApproval(idOrPrefix: string): Approval | undefined {
    const exact = this.getApproval(idOrPrefix);
    if (exact) return exact;
    const rows = this.db
      .prepare("SELECT * FROM approvals WHERE id LIKE ? ESCAPE '!' LIMIT 2")
      .all(`${idOrPrefix.replace(/[!%_]/g, '!$&')}%`) as Row[];
    return rows.length === 1 ? toApproval(rows[0]!) : undefined;
  }

  decide(id: string, status: 'approved' | 'rejected', answer?: string): Approval | undefined {
    this.db
      .prepare(
        "UPDATE approvals SET status = ?, answer = ?, decided_at = ? WHERE id = ? AND status = 'pending'",
      )
      .run(status, answer ?? null, Date.now(), id);
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
    maxParallel: clampParallel((r.max_parallel as number | null) ?? 1),
    adaptiveTeam: r.adaptive_team !== 0,
    previewCommand: (r.preview_command as string | null) ?? null,
    pages: cleanPages((parse(r.pages) as string[] | null) ?? ['/']),
    visualReview: r.visual_review !== 0,
    reviewEffort: r.review_effort === 'light' ? 'light' : 'same',
    retryStrategy: ((r.retry_strategy as string | null) ?? 'same') as RetryStrategy,
    askPolicy: ((r.ask_policy as string | null) ?? 'ask') as AskPolicy,
    permissions: {
      ...DEFAULT_PERMISSIONS,
      ...(parse(r.permissions) as Partial<Permissions> | null),
    },
    designDirection: (r.design_direction as string | null) ?? null,
    proposedTestCommand: (r.proposed_test_command as string | null) ?? null,
    github: parse(r.github) as GitHubLink | null,
    status: r.status as ProjectStatus,
    statusReason: (r.status_reason as string | null) ?? null,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  };
}

/** Up to 5 site paths, each starting with "/"; "/" when none are left. */
export function cleanPages(pages: string[]): string[] {
  const clean = [
    ...new Set(
      pages
        .map((p) => String(p).trim())
        .filter((p) => p.startsWith('/') && !p.startsWith('//') && p.length <= 200),
    ),
  ];
  return clean.length ? clean.slice(0, 5) : ['/'];
}

/** Lanes run 1 to 4 tasks at once. */
export function clampParallel(n: number): number {
  return Math.min(4, Math.max(1, Math.round(Number.isFinite(n) ? n : 1)));
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
    lastFailure: parse(r.last_failure) as TaskFailure | null,
    freeRetries: (r.free_retries as number | null) ?? 0,
    pinnedSeat: parse(r.pinned_seat) as Seat | null,
    replacedBy: (r.replaced_by as string | null) ?? null,
    blockedBy: (r.blocked_by as string | null) ?? null,
    grants: parse(r.grants) as TaskGrants | null,
    estimate: parse(r.estimate) as TaskEstimate | null,
    actualLines: (r.actual_lines as number | null) ?? null,
    after: (parse(r.after) as string[] | null) ?? [],
    kept: parse(r.kept) as TaskKept | null,
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
    answer: (r.answer as string | null) ?? null,
    createdAt: r.created_at as number,
    decidedAt: (r.decided_at as number | null) ?? null,
  };
}
