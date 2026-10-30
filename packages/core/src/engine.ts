import { join } from 'node:path';
import {
  PROVIDERS,
  providerEntry,
  type ProviderId,
  type ProviderStatus,
  type Seat,
} from '@conclave/shared';
import { adapterMap, createAdapters } from './adapters/registry.js';
import type { CachedCatalog } from './store/catalogs.js';
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
    this.adapters = adapterMap(
      opts.adapters ?? createAdapters({ settings: () => this.store.settings.get() }),
    );
    const ctx = { store: this.store, adapters: this.adapters, cwd: this.home };
    this.chat = new ChatService(ctx);
    this.council = new Council(ctx);
  }

  private detected: { at: number; statuses: Promise<ProviderStatus[]> } | undefined;

  /**
   * Every CLI's install and sign-in state. Fresh by default (the Accounts screen); pass
   * `maxAgeMs` to reuse a recent check, since asking seven CLIs takes seconds.
   */
  async detectAll(opts: { maxAgeMs?: number } = {}): Promise<ProviderStatus[]> {
    const recent = this.detected && Date.now() - this.detected.at < (opts.maxAgeMs ?? -1);
    if (!recent) {
      const statuses = Promise.all([...this.adapters.values()].map((a) => a.detect()));
      this.detected = { at: Date.now(), statuses };
      statuses.catch(() => (this.detected = undefined));
    }
    return this.detected!.statuses;
  }

  /** Signed-in providers, in display order, from a check at most a minute old. */
  async readySeats(): Promise<Seat[]> {
    return (await this.detectAll({ maxAgeMs: 60_000 }))
      .filter((s) => s.auth === 'signed_in')
      .map((s) => ({ provider: s.provider }));
  }

  /**
   * A provider's models, from the cache when it's under an hour old; otherwise asked of the CLI
   * (which never spends usage) and cached. A CLI that can't list models gets its built-in list.
   */
  async catalog(
    provider: ProviderId,
    opts: { refresh?: boolean; maxAgeMs?: number } = {},
  ): Promise<CachedCatalog> {
    const adapter = this.adapters.get(provider);
    if (!adapter) throw new Error(`Provider not available: ${provider}`);
    const cached = this.store.catalogs.get(provider);
    const fresh = cached && Date.now() - cached.fetchedAt < (opts.maxAgeMs ?? CATALOG_MAX_AGE);
    if (cached && fresh && !opts.refresh && cached.models.length) return withoutRejected(cached);
    const listed = await adapter.models?.().catch(() => undefined);
    if (listed?.models.length) {
      this.store.catalogs.save(provider, listed);
      return withoutRejected(this.store.catalogs.get(provider)!);
    }
    // Nothing new: keep what was cached, or fall back to the adapter's own short list.
    if (cached?.models.length) return withoutRejected(cached);
    return {
      provider,
      models: adapter.capabilities.models.map((id) => ({ id })),
      ...(adapter.capabilities.defaultModel && { defaultModel: adapter.capabilities.defaultModel }),
      fetchedAt: 0,
      unavailable: [],
    };
  }

  close(): void {
    this.store.close();
  }
}

/** How long a model list is trusted before the CLI is asked again. */
export const CATALOG_MAX_AGE = 60 * 60_000;

function withoutRejected(c: CachedCatalog): CachedCatalog {
  if (!c.unavailable.length) return c;
  return { ...c, models: c.models.filter((m) => !c.unavailable.includes(m.id)) };
}

/** Parse "claude", "claude:opus", "codex@low" or "claude:opus@high" into a seat. */
export function parseSeat(text: string): Seat {
  const [who = '', effort = ''] = text.trim().split('@');
  const [provider = '', ...rest] = who.split(':');
  const model = rest.join(':').trim();
  if (!providerEntry(provider)) {
    const known = PROVIDERS.filter((p) => !p.hidden).map((p) => p.id);
    throw new Error(`Unknown provider "${provider}". Use ${known.join(', ')}.`);
  }
  if (effort && !/^[a-z]+$/.test(effort)) throw new Error(`Invalid effort "${effort}".`);
  return {
    provider: provider as ProviderId,
    ...(model && { model }),
    ...(effort && { effort }),
  };
}
