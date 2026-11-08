import type { DatabaseSync } from 'node:sqlite';
import { AppSettings } from '@plenum/shared';

type Section = keyof AppSettings;
const SECTIONS = Object.keys(AppSettings.shape) as Section[];

/**
 * App-wide settings: one JSON value per top-level key, validated (and defaulted) on read.
 * Each section is read on its own, and a value that doesn't fit (an AI renamed, a newer
 * version's key) is dropped alone: one bad entry never resets the rest (E12).
 */
export class SettingsStore {
  constructor(private readonly db: DatabaseSync) {}

  get(): AppSettings {
    const raw = this.raw();
    return Object.fromEntries(
      SECTIONS.map((key) => [key, readSection(AppSettings.shape[key], raw[key])]),
    ) as AppSettings;
  }

  /**
   * Merge a partial change into the sections it names and save only those: the others stay
   * exactly as stored, including keys this version doesn't know.
   */
  update(patch: { [K in keyof AppSettings]?: Partial<AppSettings[K]> }): AppSettings {
    const current = this.get();
    const put = this.db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
    for (const key of SECTIONS) {
      const change = (patch as Record<string, object | undefined>)[key];
      if (!change) continue;
      // A bad value in the change throws: it's refused, never saved.
      const next = AppSettings.shape[key].parse({ ...(current[key] as object), ...change });
      put.run(key, JSON.stringify(next));
    }
    return this.get();
  }

  private raw(): Record<string, unknown> {
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
    return raw;
  }
}

/** Parse one section, dropping just the parts that don't fit; its default if nothing does. */
function readSection(schema: (typeof AppSettings.shape)[Section], value: unknown): unknown {
  const candidate = structuredClone(value ?? {});
  for (let tries = 0; tries < 25; tries++) {
    const parsed = schema.safeParse(candidate);
    if (parsed.success) return parsed.data;
    const path = parsed.error.issues[0]?.path ?? [];
    if (path.length === 0 || !removePath(candidate, path)) break;
  }
  return schema.parse({});
}

/** Delete the value at `path` (its last key, or the key that holds it). Returns false if absent. */
function removePath(obj: unknown, path: PropertyKey[]): boolean {
  let at = obj as Record<PropertyKey, unknown> | undefined;
  for (const key of path.slice(0, -1)) {
    const next = at?.[key];
    if (!next || typeof next !== 'object') break;
    at = next as Record<PropertyKey, unknown>;
  }
  const last = path.at(-1)!;
  if (at && typeof at === 'object' && last in at) {
    if (Array.isArray(at)) at.splice(Number(last), 1);
    else delete at[last];
    return true;
  }
  return false;
}
