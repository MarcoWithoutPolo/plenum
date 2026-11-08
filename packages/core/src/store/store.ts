import type { DatabaseSync } from 'node:sqlite';
import type {
  Message,
  MessageKind,
  MessageOutcome,
  ProviderId,
  Thread,
  ThreadMode,
  Usage,
} from '@plenum/shared';
import { openDatabase, transaction } from './db.js';
import { newId } from './ids.js';
import { ProjectStore } from './projects.js';
import { DecisionStore } from './decisions.js';
import { UsageStore } from './usage.js';
import { SettingsStore } from './settings.js';
import { SteeringStore } from './steering.js';
import { SnapshotStore } from './snapshots.js';
import { CatalogStore } from './catalogs.js';

export { newId };

export interface NewMessage {
  role: 'user' | 'assistant';
  kind?: MessageKind;
  provider?: ProviderId | null;
  model?: string | null;
  effort?: string | null;
  content: string;
  ok?: boolean;
  error?: string | null;
  usage?: Usage | null;
  durationMs?: number | null;
  groupId?: string | null;
  outcome?: MessageOutcome | null;
}

export interface QuotaReading {
  provider: ProviderId;
  window: string;
  utilization: number | null;
  resetsAt: number | null;
  at: number;
}

type Row = Record<string, unknown>;

export class Store {
  readonly db: DatabaseSync;
  readonly projects: ProjectStore;
  readonly usage: UsageStore;
  readonly decisions: DecisionStore;
  readonly settings: SettingsStore;
  readonly steering: SteeringStore;
  readonly snapshots: SnapshotStore;
  readonly catalogs: CatalogStore;

  constructor(db: DatabaseSync | string = openDatabase()) {
    this.db = typeof db === 'string' ? openDatabase(db) : db;
    this.projects = new ProjectStore(this.db);
    this.usage = new UsageStore(this.db);
    this.decisions = new DecisionStore(this.db);
    this.settings = new SettingsStore(this.db);
    this.steering = new SteeringStore(this.db);
    this.snapshots = new SnapshotStore(this.db);
    this.catalogs = new CatalogStore(this.db);
  }

  close(): void {
    this.db.close();
  }

  /**
   * Trim what only grows (E15): project events older than `eventDays` and agent runs older
   * than `runDays`. A project's last 200 events always stay, however old, so its log still
   * says how it ended. Returns how many rows went.
   */
  prune(opts: { eventDays?: number; runDays?: number; now?: number } = {}): number {
    const now = opts.now ?? Date.now();
    const day = 86_400_000;
    const events = this.db
      .prepare(
        `DELETE FROM brain_events WHERE at < ? AND id NOT IN (
           SELECT id FROM (
             SELECT id, ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY id DESC) AS n
             FROM brain_events
           ) WHERE n <= 200
         )`,
      )
      .run(now - (opts.eventDays ?? 90) * day);
    const runs = this.db
      .prepare('DELETE FROM agent_runs WHERE at < ?')
      .run(now - (opts.runDays ?? 400) * day);
    return Number(events.changes) + Number(runs.changes);
  }

  createThread(input: {
    title?: string;
    mode?: ThreadMode;
    provider: ProviderId;
    model?: string | null;
    effort?: string | null;
  }): Thread {
    const now = Date.now();
    const thread: Thread = {
      id: newId('t'),
      title: input.title ?? 'New chat',
      mode: input.mode ?? 'chat',
      provider: input.provider,
      model: input.model ?? null,
      effort: input.effort ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO threads (id, title, mode, provider, model, effort, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        thread.id,
        thread.title,
        thread.mode,
        thread.provider,
        thread.model,
        thread.effort,
        now,
        now,
      );
    return thread;
  }

  getThread(id: string): Thread | undefined {
    const row = this.db.prepare('SELECT * FROM threads WHERE id = ?').get(id) as Row | undefined;
    return row && toThread(row);
  }

  /** Accepts a full id or a unique prefix, so the CLI can take short ids. */
  findThread(idOrPrefix: string): Thread | undefined {
    const exact = this.getThread(idOrPrefix);
    if (exact) return exact;
    const rows = this.db
      .prepare("SELECT * FROM threads WHERE id LIKE ? ESCAPE '!' LIMIT 2")
      .all(`${idOrPrefix.replace(/[!%_]/g, '!$&')}%`) as Row[];
    return rows.length === 1 ? toThread(rows[0]!) : undefined;
  }

  listThreads(limit = 50): Thread[] {
    return (
      this.db.prepare('SELECT * FROM threads ORDER BY updated_at DESC LIMIT ?').all(limit) as Row[]
    ).map(toThread);
  }

  updateThread(
    id: string,
    patch: Partial<Pick<Thread, 'title' | 'provider' | 'model' | 'effort'>>,
  ): Thread | undefined {
    const current = this.getThread(id);
    if (!current) return undefined;
    const next = { ...current, ...patch, updatedAt: Date.now() };
    this.db
      .prepare(
        'UPDATE threads SET title = ?, provider = ?, model = ?, effort = ?, updated_at = ? WHERE id = ?',
      )
      .run(next.title, next.provider, next.model, next.effort, next.updatedAt, id);
    return next;
  }

  deleteThread(id: string): boolean {
    return this.db.prepare('DELETE FROM threads WHERE id = ?').run(id).changes > 0;
  }

  addMessage(threadId: string, input: NewMessage): Message {
    return transaction(this.db, () => {
      const { next } = this.db
        .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM messages WHERE thread_id = ?')
        .get(threadId) as { next: number };
      const message: Message = {
        id: newId('m'),
        threadId,
        seq: next,
        role: input.role,
        kind: input.kind ?? 'message',
        provider: input.provider ?? null,
        model: input.model ?? null,
        effort: input.effort ?? null,
        content: input.content,
        ok: input.ok ?? true,
        error: input.error ?? null,
        usage: input.usage ?? null,
        durationMs: input.durationMs ?? null,
        groupId: input.groupId ?? null,
        outcome: input.outcome ?? null,
        createdAt: Date.now(),
      };
      this.db
        .prepare(
          `INSERT INTO messages (id, thread_id, seq, role, kind, provider, model, effort, content, ok, error,
             usage, duration_ms, group_id, created_at, outcome)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          message.id,
          threadId,
          message.seq,
          message.role,
          message.kind,
          message.provider,
          message.model,
          message.effort,
          message.content,
          message.ok ? 1 : 0,
          message.error,
          message.usage ? JSON.stringify(message.usage) : null,
          message.durationMs,
          message.groupId,
          message.createdAt,
          message.outcome,
        );
      this.db
        .prepare('UPDATE threads SET updated_at = ? WHERE id = ?')
        .run(message.createdAt, threadId);
      return message;
    });
  }

  listMessages(threadId: string): Message[] {
    return (
      this.db
        .prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY seq')
        .all(threadId) as Row[]
    ).map(toMessage);
  }

  /** The provider CLI's own session for this thread, and the last message it has seen. */
  getProviderSession(
    threadId: string,
    provider: ProviderId,
  ): { sessionId: string; lastSeq: number } | undefined {
    const row = this.db
      .prepare(
        'SELECT session_id, last_seq FROM provider_sessions WHERE thread_id = ? AND provider = ?',
      )
      .get(threadId, provider) as { session_id: string; last_seq: number } | undefined;
    return row && { sessionId: row.session_id, lastSeq: row.last_seq };
  }

  setProviderSession(
    threadId: string,
    provider: ProviderId,
    sessionId: string,
    lastSeq: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO provider_sessions (thread_id, provider, session_id, last_seq) VALUES (?, ?, ?, ?)
         ON CONFLICT (thread_id, provider) DO UPDATE SET session_id = excluded.session_id, last_seq = excluded.last_seq`,
      )
      .run(threadId, provider, sessionId, lastSeq);
  }

  recordQuota(reading: QuotaReading): void {
    this.db
      .prepare(
        `INSERT INTO quota_readings (provider, window, utilization, resets_at, at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (provider, window) DO UPDATE SET
           utilization = excluded.utilization, resets_at = excluded.resets_at, at = excluded.at`,
      )
      .run(reading.provider, reading.window, reading.utilization, reading.resetsAt, reading.at);
  }

  listQuotas(): QuotaReading[] {
    return (
      this.db.prepare('SELECT * FROM quota_readings ORDER BY provider, window').all() as Row[]
    ).map((r) => ({
      provider: r.provider as ProviderId,
      window: r.window as string,
      utilization: (r.utilization as number | null) ?? null,
      resetsAt: (r.resets_at as number | null) ?? null,
      at: r.at as number,
    }));
  }
}

function toThread(r: Row): Thread {
  return {
    id: r.id as string,
    title: r.title as string,
    mode: r.mode as ThreadMode,
    provider: r.provider as ProviderId,
    model: (r.model as string | null) ?? null,
    effort: (r.effort as string | null) ?? null,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  };
}

function toMessage(r: Row): Message {
  return {
    id: r.id as string,
    threadId: r.thread_id as string,
    seq: r.seq as number,
    role: r.role as Message['role'],
    kind: r.kind as MessageKind,
    provider: (r.provider as ProviderId | null) ?? null,
    model: (r.model as string | null) ?? null,
    effort: (r.effort as string | null) ?? null,
    content: r.content as string,
    ok: r.ok === 1,
    error: (r.error as string | null) ?? null,
    usage: r.usage ? (JSON.parse(r.usage as string) as Usage) : null,
    durationMs: (r.duration_ms as number | null) ?? null,
    groupId: (r.group_id as string | null) ?? null,
    outcome: (r.outcome as MessageOutcome | null) ?? null,
    createdAt: r.created_at as number,
  };
}
