import type { DatabaseSync } from 'node:sqlite';
import type { Shot, ShotDiff } from '../preview/snapshot.js';
import { newId } from './ids.js';

/** One set of screenshots: of the integration branch at a commit (before), or of a task (after). */
export interface SnapshotSet {
  id: string;
  projectId: string;
  /** null for an integration ("before") set. */
  taskId: string | null;
  commit: string;
  shots: Shot[];
  diff: ShotDiff[] | null;
  checks: { sendBack: string[]; notes: string[] } | null;
  /** The integration set this task's shots were compared with. */
  beforeId?: string | null;
  createdAt: number;
}

type Row = Record<string, unknown>;

export class SnapshotStore {
  constructor(private readonly db: DatabaseSync) {}

  /** A fresh id, so the set's PNGs can be written to its folder before the set is saved. */
  newId(): string {
    return newId('n');
  }

  save(set: Omit<SnapshotSet, 'createdAt'>): SnapshotSet {
    const full = { ...set, createdAt: Date.now() };
    this.db
      .prepare(
        `INSERT INTO snapshot_sets (id, project_id, task_id, commit_sha, shots, diff, checks, before_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        full.id,
        full.projectId,
        full.taskId,
        full.commit,
        JSON.stringify(full.shots),
        full.diff && JSON.stringify(full.diff),
        full.checks && JSON.stringify(full.checks),
        full.beforeId ?? null,
        full.createdAt,
      );
    return full;
  }

  /** The integration branch's shots at this commit, if they were taken already. */
  forCommit(projectId: string, commit: string): SnapshotSet | undefined {
    const row = this.db
      .prepare(
        'SELECT * FROM snapshot_sets WHERE project_id = ? AND task_id IS NULL AND commit_sha = ? ORDER BY created_at DESC LIMIT 1',
      )
      .get(projectId, commit) as Row | undefined;
    return row && toSet(row);
  }

  /** A task's latest shots. */
  forTask(projectId: string, taskId: string): SnapshotSet | undefined {
    const row = this.db
      .prepare(
        'SELECT * FROM snapshot_sets WHERE project_id = ? AND task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
      )
      .get(projectId, taskId) as Row | undefined;
    return row && toSet(row);
  }

  get(id: string): SnapshotSet | undefined {
    const row = this.db.prepare('SELECT * FROM snapshot_sets WHERE id = ?').get(id) as
      Row | undefined;
    return row && toSet(row);
  }
}

function toSet(r: Row): SnapshotSet {
  const json = <T>(v: unknown, fallback: T): T => {
    try {
      return v == null ? fallback : (JSON.parse(v as string) as T);
    } catch {
      return fallback;
    }
  };
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    taskId: (r.task_id as string | null) ?? null,
    commit: r.commit_sha as string,
    shots: json<Shot[]>(r.shots, []),
    diff: json<ShotDiff[] | null>(r.diff, null),
    checks: json<SnapshotSet['checks']>(r.checks, null),
    beforeId: (r.before_id as string | null) ?? null,
    createdAt: r.created_at as number,
  };
}
