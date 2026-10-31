import type { DatabaseSync } from 'node:sqlite';
import type { ModelList, ModelOption, ProviderId } from '@conclave/shared';

type Row = Record<string, unknown>;

export interface CachedCatalog extends ModelList {
  provider: ProviderId;
  fetchedAt: number;
  /** Ids the CLI refused to run lately ("model not found"), hidden from the picker. */
  unavailable: string[];
}

/**
 * How long a refusal hides a model. Plans change (an upgrade unlocks it), so the mark lapses and
 * the next try finds out again; a run that works with the model clears it at once.
 */
export const REFUSAL_TTL = 24 * 3_600_000;

/** One refusal, stored with when it happened. Older rows hold bare ids: those have lapsed. */
type Refusal = { id: string; at: number };

/** Each provider's last model list, so the picker never waits on a CLI. */
export class CatalogStore {
  constructor(private readonly db: DatabaseSync) {}

  get(provider: ProviderId): CachedCatalog | undefined {
    const row = this.db.prepare('SELECT * FROM model_catalogs WHERE provider = ?').get(provider) as
      Row | undefined;
    if (!row) return undefined;
    return {
      provider,
      models: parseJson<ModelOption[]>(row.models, []),
      ...(typeof row.default_model === 'string' && { defaultModel: row.default_model }),
      ...(typeof row.default_effort === 'string' && { defaultEffort: row.default_effort }),
      fetchedAt: Number(row.fetched_at),
      unavailable: this.refusals(row).map((r) => r.id),
    };
  }

  private refusals(row: Row | undefined, now = Date.now()): Refusal[] {
    return parseJson<unknown[]>(row?.unavailable, []).filter(
      (r): r is Refusal =>
        typeof r === 'object' && r !== null && now - (r as Refusal).at < REFUSAL_TTL,
    );
  }

  private row(provider: ProviderId): Row | undefined {
    return this.db
      .prepare('SELECT unavailable FROM model_catalogs WHERE provider = ?')
      .get(provider) as Row | undefined;
  }

  save(provider: ProviderId, list: ModelList, at = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO model_catalogs (provider, models, default_model, default_effort, fetched_at, unavailable)
         VALUES (?, ?, ?, ?, ?, '[]')
         ON CONFLICT(provider) DO UPDATE SET models = excluded.models,
           default_model = excluded.default_model, default_effort = excluded.default_effort,
           fetched_at = excluded.fetched_at`,
      )
      .run(
        provider,
        JSON.stringify(list.models),
        list.defaultModel ?? null,
        list.defaultEffort ?? null,
        at,
      );
  }

  /** Remembers a model id the CLI rejected, so the picker stops offering it for a while. */
  markUnavailable(provider: ProviderId, model: string, at = Date.now()): void {
    const row = this.row(provider);
    if (!row) return;
    const kept = this.refusals(row, at).filter((r) => r.id !== model);
    this.write(provider, [...kept, { id: model, at }].slice(-50));
  }

  /** The model just worked (a plan upgrade, say): offer it again. */
  markAvailable(provider: ProviderId, model: string): void {
    const row = this.row(provider);
    const kept = this.refusals(row);
    if (row && kept.some((r) => r.id === model))
      this.write(
        provider,
        kept.filter((r) => r.id !== model),
      );
  }

  private write(provider: ProviderId, refusals: Refusal[]): void {
    this.db
      .prepare('UPDATE model_catalogs SET unavailable = ? WHERE provider = ?')
      .run(JSON.stringify(refusals), provider);
  }
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
