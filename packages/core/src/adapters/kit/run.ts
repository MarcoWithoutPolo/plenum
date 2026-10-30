import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { AgentEvent, ProviderId } from '@conclave/shared';
import { streamProcess, type ProcessChunk, type ProcessOptions } from '../../process.js';
import { limitResetsAt, looksLikeLimit } from './limits.js';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** An event before the runner stamps provider, runId and time on it. */
export type EventBody = DistributiveOmit<AgentEvent, 'provider' | 'runId' | 'at'>;

/** Turns one line of a CLI's output into zero or more events. One instance per run. */
export interface LineParser {
  /** A parsed JSON line, or the raw text of a line that isn't JSON when `plainText` is set. */
  parse(message: unknown): EventBody[];
  /** True once the stream itself reported a failure (error result, failed turn). */
  readonly failed: boolean;
  /** Pass lines that aren't JSON to parse() as strings instead of skipping them. */
  readonly plainText?: boolean;
  /** Events to add once the process exits, before the runner's own error and done. */
  finish?(ok: boolean): EventBody[];
}

export type Exec = (opts: ProcessOptions) => AsyncIterable<ProcessChunk>;

export interface CliAdapterOptions {
  /** Executable name or path. Defaults to the provider's official CLI name. */
  command?: string;
  /** Replaces process spawning; tests use it to replay recorded output. */
  exec?: Exec;
}

/**
 * The shared run loop for every CLI adapter: spawn (or replay), parse each line, turn a failure
 * with no reported error into an error or usage-limit event from the stderr tail, then `done`.
 */
export async function* runCli(
  provider: ProviderId,
  exec: Exec,
  process: ProcessOptions,
  parser: LineParser,
): AsyncGenerator<AgentEvent> {
  const runId = `${provider}-${randomUUID()}`;
  const started = Date.now();
  const stamp = (body: EventBody): AgentEvent =>
    ({ ...body, provider, runId, at: Date.now() }) as AgentEvent;

  let stderrTail = '';
  let reportedError = false;
  let escaped: string | undefined;
  const emit = function* (bodies: EventBody[]) {
    for (const body of bodies) {
      if (body.type === 'error' || body.type === 'rate_limit') reportedError = true;
      yield stamp(body);
      // An agent only ever writes inside its folder. A CLI that wrote elsewhere fails the run, so
      // the work is never taken as done (OpenCode once followed an inherited PWD out of it).
      if (body.type === 'file.edit' && !escaped && process.cwd && outside(body.path, process.cwd)) {
        escaped = body.path;
        reportedError = true;
        yield stamp({
          type: 'error',
          message: `It edited a file outside its working folder: ${body.path}. The run is stopped and its work is not used.`,
        });
      }
    }
  };

  for await (const chunk of exec(process)) {
    if (chunk.kind === 'stderr') {
      stderrTail = (stderrTail + chunk.text).slice(-4000);
      continue;
    }
    if (chunk.kind === 'line') {
      let message: unknown;
      try {
        message = JSON.parse(chunk.line);
      } catch {
        // Banners and warnings some CLIs print to stdout, or a plain-text CLI's answer.
        if (!parser.plainText) continue;
        message = chunk.line;
      }
      yield* emit(parser.parse(message));
      continue;
    }

    let ok = chunk.code === 0 && !chunk.error && !parser.failed && !escaped;
    if (parser.finish) {
      yield* emit(parser.finish(ok));
      ok = ok && !parser.failed && !escaped;
    }
    if (!ok && !reportedError) {
      const message =
        chunk.error ?? lastMeaningfulLine(stderrTail) ?? `Exited with code ${chunk.code}`;
      const resetsAt = limitResetsAt(message);
      yield stamp(
        looksLikeLimit(message)
          ? { type: 'rate_limit', message, ...(resetsAt && { resetsAt }) }
          : { type: 'error', message },
      );
    }
    yield stamp({ type: 'done', ok, exitCode: chunk.code, durationMs: Date.now() - started });
    return;
  }
}

export const defaultExec: Exec = streamProcess;

/** The real path, so /var and /private/var (macOS) or different letter case (Windows) compare. */
function real(path: string): string {
  // CLIs on Windows report backslashes; elsewhere a backslash in a name is almost never meant.
  let out = resolve(process.platform === 'win32' ? path : path.replace(/\\/g, '/'));
  try {
    out = realpathSync.native(out);
  } catch {
    try {
      out = join(realpathSync.native(dirname(out)), basename(out));
    } catch {
      // neither exists: compare as written
    }
  }
  return process.platform === 'win32' ? out.toLowerCase() : out;
}

/** Whether an absolute path lies outside `folder`. Relative paths are the CLI's own: inside. */
export function outside(path: string, folder: string): boolean {
  if (!isAbsolute(path)) return false;
  const rel = relative(real(folder), real(path));
  return rel.startsWith('..') || isAbsolute(rel);
}

function lastMeaningfulLine(text: string): string | undefined {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1);
}
