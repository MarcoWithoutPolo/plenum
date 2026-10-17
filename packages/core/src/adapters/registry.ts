import type { ProviderId } from '@conclave/shared';
import { ClaudeAdapter } from './claude.js';
import { CodexAdapter } from './codex.js';
import { GeminiAdapter } from './gemini.js';
import type { Adapter } from './types.js';

/** The real providers Conclave knows about, in display order. */
export function createAdapters(): Adapter[] {
  return [new ClaudeAdapter(), new CodexAdapter(), new GeminiAdapter()];
}

export function adapterMap(adapters: Adapter[]): Map<ProviderId, Adapter> {
  return new Map(adapters.map((a) => [a.id, a]));
}
