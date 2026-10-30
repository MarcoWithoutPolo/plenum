import type { Usage } from '@conclave/shared';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Token counts in Conclave's convention (OpenAI's): `inputTokens` counts every input token,
 * `cachedInputTokens` the cache reads among them, `outputTokens` includes reasoning.
 * Fields a CLI didn't report stay out instead of becoming zero.
 */
export function tokenUsage(counts: {
  input?: number | undefined;
  cached?: number | undefined;
  output?: number | undefined;
  costUsd?: number | undefined;
}): Usage {
  return {
    ...(counts.input !== undefined && { inputTokens: counts.input }),
    ...(counts.cached !== undefined && { cachedInputTokens: counts.cached }),
    ...(counts.output !== undefined && { outputTokens: counts.output }),
    ...(counts.costUsd !== undefined && { costUsd: counts.costUsd }),
  };
}

/** Adds up the numbers that are there; undefined when none are. */
export function sum(...values: (number | undefined)[]): number | undefined {
  const present = values.filter((v): v is number => v !== undefined);
  return present.length ? present.reduce((a, b) => a + b, 0) : undefined;
}
