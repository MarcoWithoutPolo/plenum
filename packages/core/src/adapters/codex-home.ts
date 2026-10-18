import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Read-only helpers over the Codex CLI's own data folder (~/.codex, or CODEX_HOME).
 * Only the model cache, config and session logs are read; auth.json never is.
 */
export function codexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), '.codex');
}

export interface CodexModel {
  id: string;
  label: string;
  description?: string;
  defaultEffort?: string;
  efforts: string[];
}

/** Models the signed-in plan can pick, as the CLI last fetched them, best first. */
export function readCodexModels(home = codexHome()): CodexModel[] {
  try {
    const cache = JSON.parse(readFileSync(join(home, 'models_cache.json'), 'utf8')) as {
      models?: {
        slug?: string;
        display_name?: string;
        description?: string;
        visibility?: string;
        priority?: number;
        default_reasoning_level?: string;
        supported_reasoning_levels?: { effort?: string }[];
      }[];
    };
    return (cache.models ?? [])
      .filter((m) => m.slug && m.visibility !== 'hide')
      .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
      .map((m) => ({
        id: m.slug!,
        label: m.display_name ?? m.slug!,
        ...(m.description && { description: m.description }),
        ...(m.default_reasoning_level && { defaultEffort: m.default_reasoning_level }),
        efforts: (m.supported_reasoning_levels ?? []).flatMap((r) => (r.effort ? [r.effort] : [])),
      }));
  } catch {
    return [];
  }
}

/** The `model` and `model_reasoning_effort` the user set in config.toml. */
export function readCodexDefaults(home = codexHome()): { model?: string; effort?: string } {
  try {
    const toml = readFileSync(join(home, 'config.toml'), 'utf8');
    // Top-level keys only: stop at the first [table].
    const top = toml.split(/^\s*\[/m)[0] ?? '';
    const model = /^\s*model\s*=\s*"([^"]+)"/m.exec(top)?.[1];
    const effort = /^\s*model_reasoning_effort\s*=\s*"([^"]+)"/m.exec(top)?.[1];
    return { ...(model && { model }), ...(effort && { effort }) };
  } catch {
    return {};
  }
}

export interface CodexLimit {
  window: string;
  utilization: number;
  resetsAt?: number;
}

/**
 * The latest plan usage Codex recorded, from a session log: for one thread
 * when `threadId` is given, otherwise from the most recent session.
 */
export function readCodexLimits(threadId?: string, home = codexHome()): CodexLimit[] {
  const file = threadId ? findSessionFile(home, threadId) : latestSessionFile(home);
  if (!file) return [];
  const tail = readTail(file, 256 * 1024);
  const at = tail.lastIndexOf('"rate_limits":');
  if (at < 0) return [];
  const json = balancedObject(tail, tail.indexOf('{', at));
  if (!json) return [];
  try {
    const limits = JSON.parse(json) as Record<string, unknown>;
    return (['primary', 'secondary'] as const).flatMap((key) => {
      const w = limits[key] as
        { used_percent?: number; window_minutes?: number; resets_at?: number } | null | undefined;
      if (!w || typeof w.used_percent !== 'number') return [];
      return [
        {
          window: windowName(w.window_minutes),
          utilization: w.used_percent / 100,
          ...(typeof w.resets_at === 'number' && { resetsAt: w.resets_at * 1000 }),
        },
      ];
    });
  } catch {
    return [];
  }
}

function windowName(minutes: number | undefined): string {
  if (minutes === 300) return 'five_hour';
  if (minutes === 10080) return 'seven_day';
  return minutes ? `${minutes}_minutes` : 'unknown';
}

/** Session logs live in sessions/YYYY/MM/DD; look at the newest days first. */
function recentDayDirs(home: string, days = 3): string[] {
  const root = join(home, 'sessions');
  const out: string[] = [];
  const desc = (dir: string) => {
    try {
      return readdirSync(dir)
        .filter((n) => /^\d+$/.test(n))
        .sort()
        .reverse();
    } catch {
      return [];
    }
  };
  for (const y of desc(root))
    for (const m of desc(join(root, y)))
      for (const d of desc(join(root, y, m))) {
        out.push(join(root, y, m, d));
        if (out.length >= days) return out;
      }
  return out;
}

function findSessionFile(home: string, threadId: string): string | undefined {
  for (const dir of recentDayDirs(home, 7)) {
    const name = safeList(dir).find((n) => n.endsWith(`${threadId}.jsonl`));
    if (name) return join(dir, name);
  }
  return undefined;
}

function latestSessionFile(home: string): string | undefined {
  let best: { path: string; mtime: number } | undefined;
  for (const dir of recentDayDirs(home, 2)) {
    for (const name of safeList(dir)) {
      if (!name.endsWith('.jsonl')) continue;
      const path = join(dir, name);
      try {
        const mtime = statSync(path).mtimeMs;
        if (!best || mtime > best.mtime) best = { path, mtime };
      } catch {
        // file vanished
      }
    }
    if (best) return best.path;
  }
  return best?.path;
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function readTail(path: string, bytes: number): string {
  const fd = openSync(path, 'r');
  try {
    const size = statSync(path).size;
    const length = Math.min(size, bytes);
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, size - length);
    return buf.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function balancedObject(text: string, start: number): string | undefined {
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return undefined;
}
