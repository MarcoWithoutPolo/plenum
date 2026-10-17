import { join } from 'node:path';
import type { ProviderId, ProviderStatus, Seat } from '@conclave/shared';
import { adapterMap, createAdapters } from './adapters/registry.js';
import type { Adapter } from './adapters/types.js';
import { ChatService } from './chat/service.js';
import { Council } from './council/council.js';
import { defaultHome } from './store/db.js';
import { Store } from './store/store.js';

export interface EngineOptions {
  /** Data directory; defaults to CONCLAVE_HOME or ~/.conclave. */
  home?: string;
  /** Overrides the real adapters (tests, demos). */
  adapters?: Adapter[];
  store?: Store;
}

/** Everything a front end (CLI, desktop app) needs, wired together. */
export class Engine {
  readonly home: string;
  readonly store: Store;
  readonly adapters: Map<ProviderId, Adapter>;
  readonly chat: ChatService;
  readonly council: Council;

  constructor(opts: EngineOptions = {}) {
    this.home = opts.home ?? defaultHome();
    this.store = opts.store ?? new Store(join(this.home, 'conclave.db'));
    this.adapters = adapterMap(opts.adapters ?? createAdapters());
    const ctx = { store: this.store, adapters: this.adapters, cwd: this.home };
    this.chat = new ChatService(ctx);
    this.council = new Council(ctx);
  }

  async detectAll(): Promise<ProviderStatus[]> {
    return Promise.all([...this.adapters.values()].map((a) => a.detect()));
  }

  /** Signed-in providers, in display order. */
  async readySeats(): Promise<Seat[]> {
    return (await this.detectAll())
      .filter((s) => s.auth === 'signed_in')
      .map((s) => ({ provider: s.provider }));
  }

  close(): void {
    this.store.close();
  }
}

/** Parse "claude", "claude:opus", "codex@low" or "claude:opus@high" into a seat. */
export function parseSeat(text: string): Seat {
  const [who = '', effort = ''] = text.trim().split('@');
  const [provider = '', ...rest] = who.split(':');
  const model = rest.join(':').trim();
  if (!['claude', 'codex', 'gemini', 'fake'].includes(provider)) {
    throw new Error(`Unknown provider "${provider}". Use claude, codex or gemini.`);
  }
  if (effort && !/^[a-z]+$/.test(effort)) throw new Error(`Invalid effort "${effort}".`);
  return {
    provider: provider as ProviderId,
    ...(model && { model }),
    ...(effort && { effort }),
  };
}
