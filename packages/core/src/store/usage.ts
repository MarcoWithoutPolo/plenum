import type { DatabaseSync } from 'node:sqlite';
import type { ProviderId, Role, Seat } from '@conclave/shared';
import type { RunResult } from '../collect.js';

export type RunSource = 'chat' | 'council' | 'project';

export interface AgentRun {
  id: number;
  provider: ProviderId;
  model: string | null;
  effort: string | null;
  role: Role;
  source: RunSource;
  refId: string | null;
  taskId: string | null;
  ok: boolean;
  rateLimited: boolean;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  costUsd: number | null;
  durationMs: number;
  at: number;
}

export interface ProviderTotals {
  provider: ProviderId;
  runs: number;
  failed: number;
  rateLimited: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
}

export interface DailyActivity {
  /** Local date, YYYY-MM-DD. */
  day: string;
  provider: ProviderId;
  runs: number;
  tokens: number;
}

type Row = Record<string, unknown>;

/** Every agent run Conclave starts, for the Usage screen. Token counts only; no prompts or replies. */
export class UsageStore {
  constructor(private readonly db: DatabaseSync) {}

  record(input: {
    seat: Seat;
    role: Role;
    source: RunSource;
    refId?: string | null;
    taskId?: string | null;
    result: Pick<RunResult, 'ok' | 'rateLimited' | 'usage' | 'durationMs' | 'model'>;
  }): void {
    const u = input.result.usage;
    this.db
      .prepare(
        `INSERT INTO agent_runs (provider, model, effort, role, source, ref_id, task_id, ok, rate_limited,
           input_tokens, cached_tokens, output_tokens, cost_usd, duration_ms, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.seat.provider,
        input.result.model ?? input.seat.model ?? null,
        input.seat.effort ?? null,
        input.role,
        input.source,
        input.refId ?? null,
        input.taskId ?? null,
        input.result.ok ? 1 : 0,
        input.result.rateLimited ? 1 : 0,
        u.inputTokens ?? 0,
        u.cachedInputTokens ?? 0,
        u.outputTokens ?? 0,
        u.costUsd ?? null,
        input.result.durationMs,
        Date.now(),
      );
  }

  totals(since: number): ProviderTotals[] {
    return (
      this.db
        .prepare(
          `SELECT provider, COUNT(*) AS runs, SUM(1 - ok) AS failed, SUM(rate_limited) AS limited,
             SUM(input_tokens) AS input, SUM(cached_tokens) AS cached, SUM(output_tokens) AS output,
             SUM(COALESCE(cost_usd, 0)) AS cost, SUM(duration_ms) AS duration
           FROM agent_runs WHERE at >= ? GROUP BY provider ORDER BY runs DESC`,
        )
        .all(since) as Row[]
    ).map((r) => ({
      provider: r.provider as ProviderId,
      runs: Number(r.runs),
      failed: Number(r.failed),
      rateLimited: Number(r.limited),
      inputTokens: Number(r.input),
      cachedTokens: Number(r.cached),
      outputTokens: Number(r.output),
      costUsd: Number(r.cost),
      durationMs: Number(r.duration),
    }));
  }

  /** Runs and tokens per provider per local day, oldest first. */
  daily(days: number, now = Date.now()): DailyActivity[] {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - (days - 1));
    const rows = this.db
      .prepare('SELECT provider, input_tokens, output_tokens, at FROM agent_runs WHERE at >= ?')
      .all(start.getTime()) as Row[];
    const buckets = new Map<string, DailyActivity>();
    for (const r of rows) {
      const day = localDay(r.at as number);
      const key = `${day}|${r.provider as string}`;
      const b = buckets.get(key) ?? { day, provider: r.provider as ProviderId, runs: 0, tokens: 0 };
      b.runs++;
      b.tokens += Number(r.input_tokens) + Number(r.output_tokens);
      buckets.set(key, b);
    }
    return [...buckets.values()].sort((a, b) => a.day.localeCompare(b.day));
  }

  /** Recent project runs in one role, newest first, for ranking seats (usage limits left out). */
  roleRuns(role: Role, limit = 400): { provider: ProviderId; ok: boolean; durationMs: number }[] {
    return (
      this.db
        .prepare(
          `SELECT provider, ok, duration_ms FROM agent_runs
           WHERE role = ? AND source = 'project' AND rate_limited = 0 ORDER BY id DESC LIMIT ?`,
        )
        .all(role, limit) as Row[]
    ).map((r) => ({
      provider: r.provider as ProviderId,
      ok: r.ok === 1,
      durationMs: r.duration_ms as number,
    }));
  }

  /** Runs this provider made since `since` (any role or source). */
  runsSince(provider: ProviderId, since: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM agent_runs WHERE provider = ? AND at >= ?')
      .get(provider, since) as { n: number };
    return row.n;
  }

  /** When this provider last answered successfully (any chat, council or project run). */
  lastOk(provider: ProviderId): number | null {
    const row = this.db
      .prepare('SELECT MAX(at) AS at FROM agent_runs WHERE provider = ? AND ok = 1')
      .get(provider) as { at: number | null };
    return row.at ?? null;
  }

  recent(limit = 50): AgentRun[] {
    return (
      this.db.prepare('SELECT * FROM agent_runs ORDER BY id DESC LIMIT ?').all(limit) as Row[]
    ).map((r) => ({
      id: r.id as number,
      provider: r.provider as ProviderId,
      model: (r.model as string | null) ?? null,
      effort: (r.effort as string | null) ?? null,
      role: r.role as Role,
      source: r.source as RunSource,
      refId: (r.ref_id as string | null) ?? null,
      taskId: (r.task_id as string | null) ?? null,
      ok: r.ok === 1,
      rateLimited: r.rate_limited === 1,
      inputTokens: r.input_tokens as number,
      cachedTokens: r.cached_tokens as number,
      outputTokens: r.output_tokens as number,
      costUsd: (r.cost_usd as number | null) ?? null,
      durationMs: r.duration_ms as number,
      at: r.at as number,
    }));
  }
}

export function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
