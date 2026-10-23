import type { ProviderId } from '@conclave/shared';
import { ClaudeAdapter } from './claude.js';
import { CodexAdapter } from './codex.js';
import { AntigravityAdapter } from './antigravity.js';
import type { Adapter } from './types.js';

/** npm packages of the official CLIs, for guided installs. Antigravity installs with its own script. */
export const INSTALL_PACKAGES: Partial<Record<ProviderId, string>> = {
  claude: '@anthropic-ai/claude-code',
  codex: '@openai/codex',
};

/** The real providers Conclave knows about, in display order. */
export function createAdapters(): Adapter[] {
  // Gemini CLI stays available for API-key users (see adapters/gemini.ts) but isn't listed:
  // Google retired it for Free/Pro/Ultra accounts in June 2026 in favor of Antigravity.
  return [new ClaudeAdapter(), new CodexAdapter(), new AntigravityAdapter()];
}

export function adapterMap(adapters: Adapter[]): Map<ProviderId, Adapter> {
  return new Map(adapters.map((a) => [a.id, a]));
}
