import { PROVIDERS, type AppSettings, type ProviderId } from '@plenum/shared';
import { ClaudeAdapter } from './claude.js';
import { CodexAdapter } from './codex.js';
import { AntigravityAdapter } from './antigravity.js';
import { GeminiAdapter } from './gemini.js';
import { CopilotAdapter } from './copilot.js';
import { CursorAdapter } from './cursor.js';
import { GrokAdapter } from './grok.js';
import { LocalAdapter } from './local.js';
import type { CliAdapterOptions } from './kit/index.js';
import type { Adapter } from './types.js';

/** npm packages of the official CLIs, for guided installs (from the provider registry). */
export const INSTALL_PACKAGES: Partial<Record<ProviderId, string>> = Object.fromEntries(
  PROVIDERS.flatMap((p) => (p.install?.npm ? [[p.id, p.install.npm]] : [])),
);

export interface FactoryOptions extends CliAdapterOptions {
  /** The app's settings, read when needed (the Ollama address). */
  settings?: () => AppSettings;
}

/** How to build each real adapter; options let tests and the fixture recorder replace spawning. */
export const ADAPTER_FACTORIES: Partial<Record<ProviderId, (opts?: FactoryOptions) => Adapter>> = {
  claude: (opts) => new ClaudeAdapter(opts),
  codex: (opts) => new CodexAdapter(opts),
  antigravity: (opts) => new AntigravityAdapter(opts),
  gemini: (opts) => new GeminiAdapter(opts),
  copilot: (opts) => new CopilotAdapter(opts),
  cursor: (opts) => new CursorAdapter(opts),
  grok: (opts) => new GrokAdapter(opts),
  local: (opts) =>
    new LocalAdapter({
      ...(opts?.exec && { exec: opts.exec }),
      ...(opts?.settings && { host: () => opts.settings!().local.host }),
    }),
};

/** The real providers Plenum knows about, in display order. */
export function createAdapters(opts: Pick<FactoryOptions, 'settings'> = {}): Adapter[] {
  // Hidden registry entries (Gemini CLI: Google retired it for Free/Pro/Ultra accounts in June
  // 2026 in favor of Antigravity) stay buildable but aren't listed.
  return PROVIDERS.flatMap((p) => {
    const make = ADAPTER_FACTORIES[p.id];
    return make && !p.hidden ? [make(opts)] : [];
  });
}

export function adapterMap(adapters: Adapter[]): Map<ProviderId, Adapter> {
  return new Map(adapters.map((a) => [a.id, a]));
}
