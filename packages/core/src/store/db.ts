import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type * as Sqlite from 'node:sqlite';
import type { DatabaseSync } from 'node:sqlite';
import { findReplacement } from '../brain/similar.js';

/**
 * Loaded on first use instead of imported: node:sqlite prints an
 * ExperimentalWarning when loaded, and a static import would load it before
 * any front end gets a chance to filter that warning.
 */
function sqlite(): typeof Sqlite {
  return process.getBuiltinModule('node:sqlite');
}

/** Drop node:sqlite's "experimental feature" warning. Call before opening a database. */
export function silenceSqliteWarning(): void {
  const emitWarning = process.emitWarning.bind(process);
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === 'string' ? warning : warning.message;
    if (/SQLite is an experimental feature/.test(text)) return;
    (emitWarning as (...args: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
}

/** Ordered schema migrations; index + 1 is the schema version. Never edit a shipped entry. */
const MIGRATIONS: (string | ((db: DatabaseSync) => void))[] = [
  `
  CREATE TABLE threads (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    mode        TEXT NOT NULL CHECK (mode IN ('chat', 'council')),
    provider    TEXT NOT NULL,
    model       TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE TABLE messages (
    id           TEXT PRIMARY KEY,
    thread_id    TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    seq          INTEGER NOT NULL,
    role         TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    kind         TEXT NOT NULL,
    provider     TEXT,
    model        TEXT,
    content      TEXT NOT NULL,
    ok           INTEGER NOT NULL DEFAULT 1,
    error        TEXT,
    usage        TEXT,
    duration_ms  INTEGER,
    group_id     TEXT,
    created_at   INTEGER NOT NULL,
    UNIQUE (thread_id, seq)
  );
  CREATE TABLE provider_sessions (
    thread_id   TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    provider    TEXT NOT NULL,
    session_id  TEXT NOT NULL,
    last_seq    INTEGER NOT NULL,
    PRIMARY KEY (thread_id, provider)
  );
  CREATE TABLE quota_readings (
    provider     TEXT NOT NULL,
    window       TEXT NOT NULL,
    utilization  REAL,
    resets_at    INTEGER,
    at           INTEGER NOT NULL,
    PRIMARY KEY (provider, window)
  );
  CREATE INDEX messages_thread ON messages(thread_id, seq);
  CREATE INDEX threads_updated ON threads(updated_at DESC);
  `,
  `
  ALTER TABLE threads ADD COLUMN effort TEXT;
  ALTER TABLE messages ADD COLUMN effort TEXT;
  `,
  `
  CREATE TABLE projects (
    id                  TEXT PRIMARY KEY,
    name                TEXT NOT NULL,
    repo_path           TEXT NOT NULL,
    goal                TEXT NOT NULL,
    done_when           TEXT,
    test_command        TEXT,
    base_branch         TEXT NOT NULL,
    integration_branch  TEXT NOT NULL,
    routing             TEXT NOT NULL,
    max_attempts        INTEGER NOT NULL DEFAULT 3,
    status              TEXT NOT NULL DEFAULT 'idle',
    status_reason       TEXT,
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL
  );
  CREATE TABLE tasks (
    id            TEXT PRIMARY KEY,
    project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title         TEXT NOT NULL,
    spec          TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'queued',
    priority      INTEGER NOT NULL DEFAULT 0,
    attempts      INTEGER NOT NULL DEFAULT 0,
    feedback      TEXT,
    built_by      TEXT,
    reviewed_by   TEXT,
    merge_commit  TEXT,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  );
  CREATE TABLE brain_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    task_id     TEXT,
    kind        TEXT NOT NULL,
    message     TEXT NOT NULL,
    provider    TEXT,
    data        TEXT,
    at          INTEGER NOT NULL
  );
  CREATE TABLE approvals (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    task_id     TEXT,
    kind        TEXT NOT NULL,
    summary     TEXT NOT NULL,
    payload     TEXT,
    status      TEXT NOT NULL DEFAULT 'pending',
    created_at  INTEGER NOT NULL,
    decided_at  INTEGER
  );
  CREATE INDEX tasks_project ON tasks(project_id, status, priority);
  CREATE INDEX brain_events_project ON brain_events(project_id, id);
  CREATE INDEX approvals_project ON approvals(project_id, status);
  `,
  `
  CREATE TABLE agent_runs (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    provider       TEXT NOT NULL,
    model          TEXT,
    effort         TEXT,
    role           TEXT NOT NULL,
    source         TEXT NOT NULL CHECK (source IN ('chat', 'council', 'project')),
    ref_id         TEXT,
    task_id        TEXT,
    ok             INTEGER NOT NULL,
    rate_limited   INTEGER NOT NULL DEFAULT 0,
    input_tokens   INTEGER NOT NULL DEFAULT 0,
    cached_tokens  INTEGER NOT NULL DEFAULT 0,
    output_tokens  INTEGER NOT NULL DEFAULT 0,
    cost_usd       REAL,
    duration_ms    INTEGER NOT NULL DEFAULT 0,
    at             INTEGER NOT NULL
  );
  CREATE INDEX agent_runs_at ON agent_runs(at);
  `,
  `
  CREATE TABLE decisions (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL CHECK (kind IN ('decision', 'assumption')),
    question    TEXT NOT NULL,
    answer      TEXT NOT NULL,
    source      TEXT NOT NULL,
    provider    TEXT,
    task_id     TEXT,
    status      TEXT NOT NULL DEFAULT 'active',
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE INDEX decisions_project ON decisions(project_id, status);
  ALTER TABLE approvals ADD COLUMN answer TEXT;
  ALTER TABLE tasks ADD COLUMN blocked_by TEXT;
  ALTER TABLE tasks ADD COLUMN replaced_by TEXT;
  ALTER TABLE tasks ADD COLUMN last_failure TEXT;
  ALTER TABLE tasks ADD COLUMN pinned_seat TEXT;
  ALTER TABLE tasks ADD COLUMN free_retries INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tasks ADD COLUMN grants TEXT;
  ALTER TABLE projects ADD COLUMN ask_policy TEXT NOT NULL DEFAULT 'ask';
  ALTER TABLE projects ADD COLUMN design_direction TEXT;
  ALTER TABLE projects ADD COLUMN proposed_test_command TEXT;
  ALTER TABLE projects ADD COLUMN permissions TEXT;
  ALTER TABLE projects ADD COLUMN retry_strategy TEXT NOT NULL DEFAULT 'same';
  ALTER TABLE projects ADD COLUMN github TEXT;
  `,
  // One piece of work, one task: earlier failed attempts at the same work become "replaced".
  linkReplacedTasks,
  // v7: planner size estimates and the real merged size, for right-sized plans.
  (db) => {
    addColumn(db, 'tasks', 'estimate', 'TEXT');
    addColumn(db, 'tasks', 'actual_lines', 'INTEGER');
  },
  // v8: lanes. Existing projects keep one task at a time.
  (db) => {
    addColumn(db, 'projects', 'max_parallel', 'INTEGER NOT NULL DEFAULT 1');
    addColumn(db, 'tasks', 'after', 'TEXT');
  },
  // v9: you can keep your own team order instead of the measured one.
  (db) => {
    addColumn(db, 'projects', 'adaptive_team', 'INTEGER NOT NULL DEFAULT 1');
  },
  // v10: app-wide settings (notifications, shared limits).
  `
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // v11: steering, the project's Chat tab.
  `
  CREATE TABLE IF NOT EXISTS steering_messages (
    id         TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    role       TEXT NOT NULL CHECK (role IN ('you', 'planner')),
    text       TEXT NOT NULL,
    actions    TEXT NOT NULL DEFAULT '[]',
    applied    TEXT,
    outcome    TEXT,
    provider   TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS steering_by_project ON steering_messages(project_id, created_at);
  `,
  // v12: see it. Previews, the pages to check, and visual review.
  (db) => {
    addColumn(db, 'projects', 'preview_command', 'TEXT');
    addColumn(db, 'projects', 'pages', 'TEXT');
    addColumn(db, 'projects', 'visual_review', 'INTEGER NOT NULL DEFAULT 1');
  },
];

/** ALTER TABLE ADD COLUMN that is safe to run again (a restored or rewound database). */
function addColumn(db: DatabaseSync, table: string, column: string, type: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((c) => c.name === column))
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

/** Current schema version (number of migrations). */
export const SCHEMA_VERSION = MIGRATIONS.length;

export function defaultHome(): string {
  return process.env.CONCLAVE_HOME ?? join(homedir(), '.conclave');
}

/** Open (and migrate) the Conclave database. Pass ':memory:' for tests. */
export function openDatabase(path = join(defaultHome(), 'conclave.db')): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new (sqlite().DatabaseSync)(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    transaction(db, () => {
      const step = MIGRATIONS[v]!;
      if (typeof step === 'string') db.exec(step);
      else step(db);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function linkReplacedTasks(db: DatabaseSync): void {
  const tasks = db
    .prepare('SELECT id, project_id, title, status, created_at FROM tasks ORDER BY created_at')
    .all() as {
    id: string;
    project_id: string;
    title: string;
    status: string;
    created_at: number;
  }[];
  const update = db.prepare("UPDATE tasks SET status = 'replaced', replaced_by = ? WHERE id = ?");
  for (const failed of tasks.filter((t) => t.status === 'failed')) {
    const later = tasks.filter(
      (t) =>
        t.project_id === failed.project_id &&
        t.created_at > failed.created_at &&
        t.status !== 'failed' &&
        t.status !== 'replaced',
    );
    const twin = findReplacement(failed.title, later);
    if (twin) update.run(twin.id, failed.id);
  }
}
