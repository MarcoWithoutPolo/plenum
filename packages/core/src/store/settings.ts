import type { DatabaseSync } from 'node:sqlite';
import { AppSettings } from '@conclave/shared';

/** App-wide settings: one JSON value per top-level key, validated (and defaulted) on read. */
export class SettingsStore {
  constructor(private readonly db: DatabaseSync) {}

  get(): AppSettings {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as {
      key: string;
      value: string;
    }[];
    const raw: Record<string, unknown> = {};
    for (const r of rows) {
      try {
        raw[r.key] = JSON.parse(r.value) as unknown;
      } catch {
        // a damaged value falls back to its default
      }
    }
    const parsed = AppSettings.safeParse(raw);
    return parsed.success ? parsed.data : AppSettings.parse({});
  }

  /** Merge a partial change into each top-level section and save it. */
  update(patch: { [K in keyof AppSettings]?: Partial<AppSettings[K]> }): AppSettings {
    const current = this.get();
    const next = AppSettings.parse(
      Object.fromEntries(
        Object.entries(current).map(([key, value]) => [
          key,
          { ...(value as object), ...((patch as Record<string, object | undefined>)[key] ?? {}) },
        ]),
      ),
    );
    const put = this.db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
    for (const [key, value] of Object.entries(next)) put.run(key, JSON.stringify(value));
    return next;
  }
}
