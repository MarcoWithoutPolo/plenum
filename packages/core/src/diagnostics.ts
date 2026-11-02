import { scrubLine } from './adapters/kit/record.js';
import type { Engine } from './engine.js';

/** Long runs of letters and digits that look like a key or a token, whatever their prefix. */
const SECRET =
  /\b(?:sk|pk|rk|ghp|gho|ghs|ghu|github_pat|xox[abpr]|AIza|ya29)[-_][\w-]{10,}|\b[\w-]*(?:token|secret|password|api[_-]?key)[\w-]*\s*[:=]\s*\S+|\b[A-Za-z0-9_-]{40,}\b/gi;

/** Remove what looks like a credential, and shorten paths that name the user. */
export function redact(text: string): string {
  return text
    .split('\n')
    .map((line) => scrubLine(line).replace(SECRET, '[removed]'))
    .join('\n');
}

/**
 * Settings → About → Export logs (v1.0 C9): what helps find a problem, as one readable text
 * file. Versions, each AI's CLI and state, the latest project events and agent runs (outcomes
 * and timings, never prompts or answers), and settings; redacted before it's written. Nothing
 * is sent anywhere: the person saves it and decides who sees it.
 */
export async function diagnosticsReport(
  engine: Engine,
  app: { version: string; electron?: string; platform: string; arch: string },
): Promise<string> {
  const lines: string[] = [];
  const add = (s = '') => lines.push(s);
  add(`Conclave ${app.version} diagnostics, ${new Date().toISOString()}`);
  add(
    `System: ${app.platform} ${app.arch} · Node ${process.versions.node}${app.electron ? ` · Electron ${app.electron}` : ''}`,
  );
  add();

  add('== AIs ==');
  for (const s of await engine.detectAll()) {
    add(
      `${s.provider}: ${s.installed ? `installed ${s.version ?? '(version unknown)'}` : 'not installed'}, ${s.auth}${s.detail ? ` — ${s.detail}` : ''}`,
    );
  }
  add();

  add('== Usage readings (latest per AI and window) ==');
  const seen = new Set<string>();
  for (const q of engine.store.listQuotas()) {
    const key = `${q.provider}/${q.window}`;
    if (seen.has(key)) continue;
    seen.add(key);
    add(
      `${key}: ${q.utilization === null ? '—' : `${Math.round(q.utilization * 100)}%`}${q.resetsAt ? `, resets ${new Date(q.resetsAt).toISOString()}` : ''} (read ${new Date(q.at).toISOString()})`,
    );
  }
  add();

  add('== Projects ==');
  for (const p of engine.store.projects.list()) {
    const tasks = engine.store.projects.listTasks(p.id);
    const by = (s: string) => tasks.filter((t) => t.status === s).length;
    add(
      `${p.id} "${p.name}": ${p.status}${p.statusReason ? ` (${p.statusReason})` : ''}; tasks ${tasks.length} (merged ${by('merged')}, failed ${by('failed')}, queued ${by('queued')})`,
    );
    for (const e of engine.store.projects.events(p.id, { latest: 150 })) {
      add(
        `  ${new Date(e.at).toISOString()} ${e.kind.padEnd(8)} ${e.provider ?? '-'} ${e.message}`,
      );
    }
  }
  add();

  add('== Latest agent runs ==');
  for (const r of engine.store.usage.recent(200)) {
    add(
      `${new Date(r.at).toISOString()} ${r.provider} ${r.role} ${r.source} ${r.ok ? 'ok' : 'failed'}${r.rateLimited ? ' (limit)' : ''} ${Math.round(r.durationMs / 1000)}s`,
    );
  }
  add();

  add('== Settings ==');
  add(JSON.stringify(engine.store.settings.get(), null, 2));
  return redact(lines.join('\n'));
}
