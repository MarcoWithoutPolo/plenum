import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { databaseAtVersion, defaultHome, openDatabase, SCHEMA_VERSION } from '../src/store/db.js';
import { Store } from '../src/index.js';

/**
 * Upgrades keep your data (v1.0 C8). For every schema version an older Plenum could have left,
 * build a database at that version, fill every table with rows that fit it, open it with this
 * version (which upgrades it), and check every row is still there and every store reads it.
 */
const cleanup: string[] = [];
afterEach(() => {
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

interface Column {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

/** A plausible value for a column, by its name and type (ids, JSON, times, flags, text). */
function valueFor(table: string, c: Column, row: number): unknown {
  const n = c.name;
  if (n === 'id') return `${table.slice(0, 2)}_${row}`;
  if (n.endsWith('_at') || n === 'at') return 1_790_000_000_000 + row * 1000;
  if (n === 'project_id') return 'pr_1';
  if (n === 'thread_id') return 'th_1';
  if (n === 'task_id') return null;
  if (n === 'provider' || n === 'built_by' || n === 'reviewed_by') return 'codex';
  if (n === 'role')
    return table === 'messages' ? 'user' : table === 'steering_messages' ? 'you' : 'builder';
  if (n === 'status')
    return table === 'tasks'
      ? 'queued'
      : table === 'approvals'
        ? 'pending'
        : table === 'decisions'
          ? 'active'
          : 'idle';
  if (n === 'kind')
    return table === 'messages'
      ? 'message'
      : table === 'approvals'
        ? 'question'
        : table === 'decisions'
          ? 'decision'
          : 'task';
  // Settings an older version saved, checked after the upgrade.
  if (table === 'settings' && n === 'key') return ['limits', 'notifications', 'local'][row - 1];
  if (table === 'settings' && n === 'value')
    return JSON.stringify([{ pauseAll: true }, { done: false }, {}][row - 1]);
  if (n === 'actions') return '[]';
  if (n === 'mode') return 'chat';
  if (n === 'source') return table === 'decisions' ? 'you' : 'chat';
  if (n === 'window') return 'five_hour';
  if (n === 'seq') return row;
  if (
    /routing|grants|after|payload|usage|data|estimate|permissions|github|kept|last_failure|pinned_seat|value/.test(
      n,
    )
  )
    return n === 'routing' ? JSON.stringify({ planner: [], builder: [], reviewer: [] }) : null;
  if (/INT|REAL/i.test(c.type)) return c.notnull ? 0 : null;
  return c.notnull ? `${n} ${row}` : null;
}

/** Insert `count` rows into every table, filling only the columns this version has. */
function fill(db: DatabaseSync, count: number): Record<string, number> {
  const tables = (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as {
      name: string;
    }[]
  ).map((t) => t.name);
  // Parents first, so foreign keys have something to point at.
  const order = [
    'projects',
    'threads',
    ...tables.filter((t) => t !== 'projects' && t !== 'threads'),
  ];
  const counts: Record<string, number> = {};
  db.exec('PRAGMA foreign_keys = OFF');
  for (const table of order.filter((t) => tables.includes(t))) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Column[];
    const usable = cols.filter(
      (c) => !(c.pk && /INT/i.test(c.type) && c.name === 'id' && table !== 'projects'),
    );
    const rows = table === 'projects' || table === 'threads' ? 1 : count;
    for (let i = 1; i <= rows; i++) {
      const values = usable.map((c) => valueFor(table, c, i));
      const id = usable.findIndex((c) => c.name === 'id');
      if (table === 'projects' && id >= 0) values[id] = 'pr_1';
      if (table === 'threads' && id >= 0) values[id] = 'th_1';
      try {
        db.prepare(
          `INSERT INTO ${table} (${usable.map((c) => c.name).join(', ')}) VALUES (${usable.map(() => '?').join(', ')})`,
        ).run(...(values as never[]));
      } catch {
        // A table with constraints this filler doesn't know (a unique key, say): fewer rows.
      }
    }
    counts[table] = (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  }
  db.exec('PRAGMA foreign_keys = ON');
  return counts;
}

describe('Upgrades keep your data (C8)', () => {
  for (let version = 1; version < SCHEMA_VERSION; version++) {
    it(`a database from schema version ${version} upgrades with every row kept`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'plenum-upgrade-'));
      cleanup.push(dir);
      const path = join(dir, 'plenum.db');
      const old = databaseAtVersion(path, version);
      const before = fill(old, 3);
      old.close();

      const db = openDatabase(path);
      expect(
        (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
      ).toBe(SCHEMA_VERSION);
      for (const [table, n] of Object.entries(before)) {
        const now = (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
        expect(now, `${table} rows after upgrading from v${version}`).toBe(n);
      }
      // Everything reads through the stores.
      const store = new Store(db);
      expect(() => store.listThreads()).not.toThrow();
      expect(() => store.projects.list()).not.toThrow();
      for (const p of store.projects.list()) {
        expect(() => store.projects.listTasks(p.id)).not.toThrow();
        expect(() => store.projects.events(p.id)).not.toThrow();
        expect(() => store.projects.approvals(p.id)).not.toThrow();
      }
      expect(() => store.settings.get()).not.toThrow();
      // Settings saved by the older version are still in effect.
      if ((before.settings ?? 0) > 0) {
        expect(store.settings.get().limits.pauseAll).toBe(true);
        expect(store.settings.get().notifications.done).toBe(false);
      }
      expect(() => store.listQuotas()).not.toThrow();
      store.close();
      // The copy made before the upgrade is there.
      expect(existsSync(`${path}.bak-${version}`)).toBe(true);
    });
  }

  it('keeps only the last three backups', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plenum-upgrade-'));
    cleanup.push(dir);
    const path = join(dir, 'plenum.db');
    for (const v of [14, 15, 16, 17]) {
      rmSync(path, { force: true });
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
      databaseAtVersion(path, v).close();
      openDatabase(path).close();
    }
    const backups = readdirSync(dir)
      .filter((f) => f.includes('.bak-'))
      .sort();
    expect(backups).toEqual(['plenum.db.bak-15', 'plenum.db.bak-16', 'plenum.db.bak-17']);
  });
});

describe('The data folder after the rename to Plenum', () => {
  const saved = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    PLENUM_HOME: process.env.PLENUM_HOME,
  };
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('keeps using ~/.conclave when it exists and ~/.plenum does not', () => {
    const home = mkdtempSync(join(tmpdir(), 'plenum-userhome-'));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    delete process.env.PLENUM_HOME;
    expect(defaultHome()).toBe(join(home, '.plenum'));
    mkdirSync(join(home, '.conclave'));
    expect(defaultHome()).toBe(join(home, '.conclave'));
    mkdirSync(join(home, '.plenum'));
    expect(defaultHome()).toBe(join(home, '.plenum'));
    process.env.PLENUM_HOME = join(home, 'elsewhere');
    expect(defaultHome()).toBe(join(home, 'elsewhere'));
    rmSync(home, { recursive: true, force: true });
  });
});
