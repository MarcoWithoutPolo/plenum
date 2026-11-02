import type { ProviderId, Seat } from '@conclave/shared';
import type { RunResult } from '../collect.js';
import type { QuotaReading } from '../store/store.js';
import { ceilingFor, policyBlock, type GovernorPolicy } from './policy.js';

export interface GovernorOptions {
  /** Stop handing a provider work once any of its windows is this full (0 to 1). */
  ceiling?: number;
  /** First cooldown after a limit with no reset time; doubles on each repeat. */
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  now?: () => number;
  /** Your rules from Settings: pause all, quiet hours, daily caps, what to leave for you. */
  policy?: GovernorPolicy;
}

/** Limits that need someone to act (raise a cap, add credits), not just time to pass. */
export const HARD_CAP =
  /spend(ing)? (cap|limit)|out of credits|credits? (are |have been )?(exhausted|used up|depleted)|billing (hard )?limit|check your billing|payment required|insufficient (quota|credit|balance)/i;

/** How long a usage reading without a reset time counts (E10). */
const STALE_READING_MS = 60 * 60_000;

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
  private readonly policy: GovernorPolicy | undefined;
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
    this.policy = opts.policy;
  }

  availability(provider: ProviderId): Availability {
    const now = this.now();
    const block = this.policy && policyBlock(this.policy, provider, new Date(now));
    if (block) return { ok: false, ...block };
    const cool = this.cooldowns.get(provider);
    if (cool && cool.until > now) return { ok: false, reason: cool.reason, until: cool.until };

    const ceiling = ceilingFor(this.policy, provider, this.ceiling);
    for (const q of this.readings()) {
      if (q.provider !== provider || q.utilization === null) continue;
      // A reading only counts until its window resets.
      if (q.resetsAt !== null && q.resetsAt <= now) continue;
      if (q.window === 'limit' && q.resetsAt === null && now - q.at > this.base) continue;
      // A usage reading with no reset time can't block for ever: the AI would never run, so no
      // fresher reading would ever come (E10). After an hour it's tried again.
      if (q.window !== 'limit' && q.resetsAt === null && now - q.at > STALE_READING_MS) continue;
      if (q.utilization >= ceiling) {
        const pct = Math.round(q.utilization * 100);
        const left = Math.round((1 - ceiling) * 100);
        return {
          ok: false,
          reason:
            q.window === 'limit'
              ? 'usage limit reached'
              : this.policy && left > 0
                ? `leaving ${left}% for you, ${windowName(q.window)} at ${pct}%`
                : `${windowName(q.window)} at ${pct}%`,
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
      // A spend cap or exhausted credits doesn't lift in minutes: don't keep knocking.
      const backoff = HARD_CAP.test(result.rateLimited.message ?? '')
        ? this.maxBackoff
        : Math.min(this.maxBackoff, this.base * 2 ** (strikes - 1));
      const until = result.rateLimited.resetsAt ?? this.now() + backoff;
      this.cooldowns.set(provider, {
        until,
        strikes,
        reason: shortReason(result.rateLimited.message) || 'usage limit reached',
      });
    } else if (result.ok) {
      this.cooldowns.delete(provider);
    }
  }
}

/**
 * A CLI's limit message cut to its first sentence, so every provider's reason fits on one
 * "no headroom" line (Codex's runs on with upgrade links). The reset time is shown separately.
 */
export function shortReason(message: string | undefined): string {
  const text = (message ?? '').replace(/\s+/g, ' ').trim();
  const first = /^.*?[.!?](?=\s|$)/.exec(text)?.[0] ?? text;
  return first.length > 120 ? `${first.slice(0, 119)}…` : first;
}

function windowName(window: string): string {
  return window === 'five_hour'
    ? '5-hour window'
    : window === 'seven_day'
      ? 'weekly limit'
      : window;
}
