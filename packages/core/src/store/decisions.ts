import type { DatabaseSync } from 'node:sqlite';
import type { ProjectDecision, ProviderId } from '@conclave/shared';
import { newId } from './ids.js';

type Row = Record<string, unknown>;

export interface NewDecision {
  projectId: string;
  kind: ProjectDecision['kind'];
  question: string;
  answer: string;
  source: ProjectDecision['source'];
  provider?: ProviderId | null;
  taskId?: string | null;
}

/** What's been settled for each project: your decisions and the assumptions made without you. */
export class DecisionStore {
  constructor(private readonly db: DatabaseSync) {}

  add(input: NewDecision): ProjectDecision {
    const now = Date.now();
    const decision: ProjectDecision = {
      id: newId('d'),
      projectId: input.projectId,
      kind: input.kind,
      question: input.question.trim().slice(0, 1000),
      answer: input.answer.trim().slice(0, 2000),
      source: input.source,
      provider: input.provider ?? null,
      taskId: input.taskId ?? null,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO decisions (id, project_id, kind, question, answer, source, provider, task_id,
           status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(
        decision.id,
        decision.projectId,
        decision.kind,
        decision.question,
        decision.answer,
        decision.source,
        decision.provider,
        decision.taskId,
        now,
        now,
      );
    return decision;
  }

  get(id: string): ProjectDecision | undefined {
    const row = this.db.prepare('SELECT * FROM decisions WHERE id = ?').get(id) as Row | undefined;
    return row && toDecision(row);
  }

  /** Oldest first. */
  list(projectId: string, opts: { status?: ProjectDecision['status'] } = {}): ProjectDecision[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM decisions WHERE project_id = ? AND (? IS NULL OR status = ?)
           ORDER BY created_at, rowid`,
        )
        .all(projectId, opts.status ?? null, opts.status ?? null) as Row[]
    ).map(toDecision);
  }

  /** Promote an assumption to a decision: you agree with it. */
  keep(id: string): ProjectDecision | undefined {
    this.db
      .prepare("UPDATE decisions SET kind = 'decision', updated_at = ? WHERE id = ?")
      .run(Date.now(), id);
    return this.get(id);
  }

  /** Change an answer: the old entry is kept as overturned history, the new one takes over. */
  change(id: string, answer: string): ProjectDecision | undefined {
    const old = this.get(id);
    if (!old) return undefined;
    this.db
      .prepare("UPDATE decisions SET status = 'overturned', updated_at = ? WHERE id = ?")
      .run(Date.now(), id);
    return this.add({
      projectId: old.projectId,
      kind: 'decision',
      question: old.question,
      answer,
      source: 'you',
      taskId: old.taskId,
    });
  }

  remove(id: string): boolean {
    return this.db.prepare('DELETE FROM decisions WHERE id = ?').run(id).changes > 0;
  }
}

function toDecision(r: Row): ProjectDecision {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    kind: r.kind as ProjectDecision['kind'],
    question: r.question as string,
    answer: r.answer as string,
    source: r.source as ProjectDecision['source'],
    provider: (r.provider as ProviderId | null) ?? null,
    taskId: (r.task_id as string | null) ?? null,
    status: r.status as ProjectDecision['status'],
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  };
}

const MAX_ITEMS = 40;
const MAX_CHARS = 4000;

/**
 * The DECISIONS / ASSUMPTIONS section every planner, builder and reviewer prompt gets.
 * Newest 40 active items or 4,000 characters; older ones drop with a note.
 */
export function decisionsSection(decisions: ProjectDecision[]): string {
  const active = decisions.filter((d) => d.status === 'active');
  if (active.length === 0) return '';
  const newestFirst = [...active].sort((a, b) => b.createdAt - a.createdAt);
  const kept: ProjectDecision[] = [];
  let chars = 0;
  for (const d of newestFirst) {
    const line = `- ${d.question}: ${d.answer}`;
    if (kept.length >= MAX_ITEMS || chars + line.length > MAX_CHARS) break;
    kept.push(d);
    chars += line.length + 1;
  }
  const dropped = active.length - kept.length;
  const lines = (kind: ProjectDecision['kind']) =>
    kept
      .filter((d) => d.kind === kind)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((d) => `- ${d.question}: ${d.answer}`);
  const decided = lines('decision');
  const assumed = lines('assumption');
  return [
    decided.length && `DECISIONS (follow these; they come from the user)\n${decided.join('\n')}`,
    assumed.length &&
      `ASSUMPTIONS (made without the user; follow unless clearly wrong)\n${assumed.join('\n')}`,
    dropped > 0 && `(${dropped} older item${dropped === 1 ? '' : 's'} not shown)`,
  ]
    .filter(Boolean)
    .join('\n\n');
}
