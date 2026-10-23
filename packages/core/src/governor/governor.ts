import type { ProviderId, Seat } from '@conclave/shared';
import type { RunResult } from '../collect.js';
import type { QuotaReading } from '../store/store.js';

export interface GovernorOptions {
  /** Stop handing a provider work once any of its windows is this full (0 to 1). */
  ceiling?: number;
  /** First cooldown after a limit with no reset time; doubles on each repeat. */
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  now?: () => number;
}

export type Availability = { ok: true } | { ok: false; reason: string; until: number | null };

/**
 * Keeps work flowing across several subscriptions. It reads the usage each
 * CLI reports, pauses a provider that hit (or is close to) a limit until its
 * window resets, and hands work to the next provider in a role's routing.
 */
export class Governor {
  private readonly ceiling: number;
  private readonly base: number;
  private readonly maxBackoff: number;
  private readonly now: () => number;
  private readonly cooldowns = new Map<
    ProviderId,
    { until: number; strikes: number; reason: string }
  >();

  constructor(
    private readonly readings: () => QuotaReading[],
    opts: GovernorOptions = {},
  ) {
    this.ceiling = opts.ceiling ?? 0.92;
    this.base = opts.baseBackoffMs ?? 5 * 60_000;
    this.maxBackoff = opts.maxBackoffMs ?? 60 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  availability(provider: ProviderId): Availability {
    const now = this.now();
    const cool = this.cooldowns.get(provider);
    if (cool && cool.until > now) return { ok: false, reason: cool.reason, until: cool.until };

    for (const q of this.readings()) {
      if (q.provider !== provider || q.utilization === null) continue;
      // A reading only counts until its window resets.
      if (q.resetsAt !== null && q.resetsAt <= now) continue;
      if (q.window === 'limit' && q.resetsAt === null && now - q.at > this.base) continue;
      if (q.utilization >= this.ceiling) {
        const pct = Math.round(q.utilization * 100);
        return {
          ok: false,
          reason:
            q.window === 'limit' ? 'usage limit reached' : `${windowName(q.window)} at ${pct}%`,
          until: q.resetsAt,
        };
      }
    }
    return { ok: true };
  }

  /** How full the provider's fullest current usage window is (0 to 1), if it reports one. */
  utilization(provider: ProviderId): number | null {
    const now = this.now();
    let max: number | null = null;
    for (const q of this.readings()) {
      if (q.provider !== provider || q.utilization === null || q.window === 'limit') continue;
      if (q.resetsAt !== null && q.resetsAt <= now) continue;
      max = Math.max(max ?? 0, q.utilization);
    }
    return max;
  }

  /** The first seat in `seats` whose provider has headroom, skipping `avoid` when possible. */
  pick(
    seats: Seat[],
    avoid: ProviderId[] = [],
  ): { seat: Seat } | { seat: null; until: number | null; reasons: string[] } {
    const ordered = [
      ...seats.filter((s) => !avoid.includes(s.provider)),
      ...seats.filter((s) => avoid.includes(s.provider)),
    ];
    const reasons: string[] = [];
    let until: number | null = null;
    for (const seat of ordered) {
      const a = this.availability(seat.provider);
      if (a.ok) return { seat };
      reasons.push(`${seat.provider}: ${a.reason}`);
      if (a.until !== null) until = until === null ? a.until : Math.min(until, a.until);
    }
    return { seat: null, until, reasons };
  }

  /** Learn from a finished run: a rate limit pauses that provider. */
  observe(provider: ProviderId, result: Pick<RunResult, 'ok' | 'rateLimited'>): void {
    if (result.rateLimited) {
      const prev = this.cooldowns.get(provider);
      const strikes = (prev?.strikes ?? 0) + 1;
      const backoff = Math.min(this.maxBackoff, this.base * 2 ** (strikes - 1));
      const until = result.rateLimited.resetsAt ?? this.now() + backoff;
      this.cooldowns.set(provider, {
        until,
        strikes,
        reason: result.rateLimited.message || 'usage limit reached',
      });
    } else if (result.ok) {
      this.cooldowns.delete(provider);
    }
  }
}

function windowName(window: string): string {
  return window === 'five_hour'
    ? '5-hour window'
    : window === 'seven_day'
      ? 'weekly limit'
      : window;
}
