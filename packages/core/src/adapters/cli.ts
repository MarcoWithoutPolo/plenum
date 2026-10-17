import { randomUUID } from 'node:crypto';
import type { AgentEvent, ProviderId } from '@conclave/shared';
import { streamProcess, type ProcessChunk, type ProcessOptions } from '../process.js';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** An event before the runner stamps provider, runId and time on it. */
export type EventBody = DistributiveOmit<AgentEvent, 'provider' | 'runId' | 'at'>;

/** Turns one parsed JSON line of a CLI's output into zero or more events. One instance per run. */
export interface LineParser {
  parse(message: unknown): EventBody[];
  /** True once the stream itself reported a failure (error result, failed turn). */
  readonly failed: boolean;
}

export type Exec = (opts: ProcessOptions) => AsyncIterable<ProcessChunk>;

export interface CliAdapterOptions {
  /** Executable name or path. Defaults to the provider's official CLI name. */
  command?: string;
  /** Replaces process spawning; tests use it to replay recorded output. */
  exec?: Exec;
}

/** Shared run loop for every JSON-lines CLI adapter. */
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
        continue; // banners and warnings some CLIs print to stdout
      }
      for (const body of parser.parse(message)) {
        if (body.type === 'error' || body.type === 'rate_limit') reportedError = true;
        yield stamp(body);
      }
      continue;
    }

    const ok = chunk.code === 0 && !chunk.error && !parser.failed;
    if (!ok && !reportedError) {
      const message =
        chunk.error ?? lastMeaningfulLine(stderrTail) ?? `Exited with code ${chunk.code}`;
      yield stamp({ type: 'error', message });
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Model names go on the command line, so only allow plain identifiers. */
export function assertSafeModel(model: string | undefined): void {
  if (model !== undefined && !/^[\w.:/[\]-]+$/.test(model)) {
    throw new Error(`Invalid model name: ${model}`);
  }
}
