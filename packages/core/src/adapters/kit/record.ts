import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { dirname } from 'node:path';
import type { Exec } from './run.js';

/** A path as it appears in text and inside JSON strings (where backslashes are doubled). */
function spellings(path: string): string[] {
  const forward = path.replace(/\\/g, '/');
  return [...new Set([path, path.replace(/\\/g, '\\\\'), forward])].sort(
    (a, b) => b.length - a.length,
  );
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Takes out what a recording must not carry into the repo: the run folder, the home folder,
 * the account name and email addresses. Ids and timings stay, since parsers rely on them.
 */
export function scrubLine(
  line: string,
  places: { cwd?: string; home?: string; user?: string } = {},
): string {
  let out = line;
  const replace = (path: string | undefined, by: string) => {
    if (!path) return;
    for (const s of spellings(path)) out = out.replace(new RegExp(escapeRe(s), 'gi'), by);
  };
  replace(places.cwd, '<cwd>');
  replace(places.home ?? homedir(), '<home>');
  replace(tmpdir(), '<tmp>');
  out = out.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, 'user@example.com');
  const user = places.user ?? safeUserName();
  if (user && user.length > 2)
    out = out.replace(new RegExp(`\\b${escapeRe(user)}\\b`, 'gi'), 'user');
  return out;
}

function safeUserName(): string | undefined {
  try {
    return userInfo().username;
  } catch {
    return undefined;
  }
}

/**
 * Wraps an Exec so every stdout line is also written, scrubbed, to `file`: run an adapter
 * through it once against the real CLI, and the file becomes a test fixture.
 */
export function recordingExec(inner: Exec, file: string, cwd?: string): Exec {
  return async function* (opts) {
    const lines: string[] = [];
    try {
      for await (const chunk of inner(opts)) {
        if (chunk.kind === 'line') lines.push(scrubLine(chunk.line, { cwd: cwd ?? opts.cwd }));
        yield chunk;
      }
    } finally {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, lines.map((l) => `${l}\n`).join(''));
    }
  };
}
