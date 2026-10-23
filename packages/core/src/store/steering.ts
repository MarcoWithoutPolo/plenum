import type { DatabaseSync } from 'node:sqlite';
import type { ProviderId, SteeringAction, SteeringMessage } from '@conclave/shared';
import { newId } from './ids.js';

type Row = Record<string, unknown>;

/** A project's Chat tab: your messages, the planner's replies and what you applied. */
export class SteeringStore {
  constructor(private readonly db: DatabaseSync) {}

  add(input: {
    projectId: string;
    role: SteeringMessage['role'];
    text: string;
    actions?: SteeringAction[];
    provider?: ProviderId | null;
  }): SteeringMessage {
    const message: SteeringMessage = {
      id: newId('s'),
      projectId: input.projectId,
      role: input.role,
      text: input.text.slice(0, 8000),
      actions: input.actions ?? [],
      applied: null,
      outcome: null,
      provider: input.provider ?? null,
      createdAt: Date.now(),
    };
    this.db
      .prepare(
        `INSERT INTO steering_messages (id, project_id, role, text, actions, provider, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        message.id,
        message.projectId,
        message.role,
        message.text,
        JSON.stringify(message.actions),
        message.provider,
        message.createdAt,
      );
    return message;
  }

  get(id: string): SteeringMessage | undefined {
    const row = this.db.prepare('SELECT * FROM steering_messages WHERE id = ?').get(id) as
      Row | undefined;
    return row && toMessage(row);
  }

  list(projectId: string, limit = 100): SteeringMessage[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM steering_messages WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
        )
        .all(projectId, limit) as Row[]
    )
      .map(toMessage)
      .reverse();
  }

  settle(id: string, applied: number[], outcome: string[]): SteeringMessage {
    this.db
      .prepare('UPDATE steering_messages SET applied = ?, outcome = ? WHERE id = ?')
      .run(JSON.stringify(applied), JSON.stringify(outcome), id);
    return this.get(id)!;
  }
}

function toMessage(r: Row): SteeringMessage {
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
    role: r.role as SteeringMessage['role'],
    text: r.text as string,
    actions: json<SteeringAction[]>(r.actions, []),
    applied: json<number[] | null>(r.applied, null),
    outcome: json<string[] | null>(r.outcome, null),
    provider: (r.provider as ProviderId | null) ?? null,
    createdAt: r.created_at as number,
  };
}
