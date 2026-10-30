import { randomUUID } from 'node:crypto';
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
  const emit = function* (bodies: EventBody[]) {
    for (const body of bodies) {
      if (body.type === 'error' || body.type === 'rate_limit') reportedError = true;
      yield stamp(body);
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

    let ok = chunk.code === 0 && !chunk.error && !parser.failed;
    if (parser.finish) {
      yield* emit(parser.finish(ok));
      ok = ok && !parser.failed;
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

function lastMeaningfulLine(text: string): string | undefined {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1);
}
