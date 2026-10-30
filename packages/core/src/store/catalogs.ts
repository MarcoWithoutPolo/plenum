import type { DatabaseSync } from 'node:sqlite';
import type { ModelList, ModelOption, ProviderId } from '@conclave/shared';

type Row = Record<string, unknown>;

export interface CachedCatalog extends ModelList {
  provider: ProviderId;
  fetchedAt: number;
  /** Ids the CLI refused to run ("model not found"), hidden from the picker. */
  unavailable: string[];
}

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
      unavailable: parseJson<string[]>(row.unavailable, []),
    };
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

  /** Remembers a model id the CLI rejected, so the picker stops offering it. */
  markUnavailable(provider: ProviderId, model: string): void {
    const current = this.get(provider);
    if (!current || current.unavailable.includes(model)) return;
    this.db
      .prepare('UPDATE model_catalogs SET unavailable = ? WHERE provider = ?')
      .run(JSON.stringify([...current.unavailable, model].slice(-50)), provider);
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
