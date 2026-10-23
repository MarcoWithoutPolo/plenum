import type { ProviderId, Seat } from '@conclave/shared';

/** How a provider has done in one role lately, on this machine. */
export interface SeatStats {
  runs: number;
  /** Share of runs that finished without an error (usage limits not counted). */
  okRate: number;
  medianMs: number;
}

export type RankRole = 'planner' | 'builder' | 'reviewer';

export const RANK = {
  /** Below this many runs, a provider keeps its place in the team order. */
  minRuns: 5,
  unreliable: 0.7,
  /** A provider this far into its usage window is saved for later. */
  scarce: 0.75,
  /** A reviewer this many times slower than the fastest one moves back. */
  slow: 2,
} as const;

export interface Ranked {
  seats: Seat[];
  /** Why the order changed, for the activity log; empty when it didn't. */
  reasons: string[];
}

/**
 * The team order, adjusted only when the data clearly says so: unreliable providers
 * move back, and so do nearly spent ones (to save them for later). For reviews, which
 * sit on every task's critical path, much slower reviewers move back too.
 */
export function rankSeats(
  seats: Seat[],
  role: RankRole,
  stats: Map<ProviderId, SeatStats>,
  utilization: (provider: ProviderId) => number | null,
): Ranked {
  const known = (p: ProviderId) => {
    const s = stats.get(p);
    return s && s.runs >= RANK.minRuns ? s : undefined;
  };
  const reliable = seats
    .map((s) => known(s.provider))
    .filter((s) => s && s.okRate >= RANK.unreliable);
  const fastest = Math.min(...reliable.map((s) => s!.medianMs));
  const reasons = new Map<ProviderId, string>();
  const penalty = (seat: Seat): number => {
    const p = seat.provider;
    const s = known(p);
    if (s && s.okRate < RANK.unreliable) {
      reasons.set(
        p,
        `${p} finished only ${Math.round(s.okRate * 100)}% of its recent ${role} runs`,
      );
      return 100;
    }
    const used = utilization(p);
    if (used !== null && used >= RANK.scarce) {
      reasons.set(
        p,
        `${p} is ${Math.round(used * 100)}% into its usage window, so it's saved for later`,
      );
      return 50;
    }
    if (role === 'reviewer' && s && Number.isFinite(fastest) && s.medianMs >= RANK.slow * fastest) {
      reasons.set(
        p,
        `${p} reviews take ${(s.medianMs / fastest).toFixed(1)}× longer than the fastest`,
      );
      return 20;
    }
    return 0;
  };
  const scored = seats.map((seat, i) => ({ seat, score: i + penalty(seat) }));
  const ordered = [...scored].sort((a, b) => a.score - b.score).map((x) => x.seat);
  const moved = ordered.some((s, i) => s !== seats[i]);
  return { seats: ordered, reasons: moved ? [...reasons.values()] : [] };
}

/** Per-provider stats from recent runs, newest first (at most `window` per provider). */
export function seatStats(
  runs: { provider: ProviderId; ok: boolean; durationMs: number }[],
  window = 20,
): Map<ProviderId, SeatStats> {
  const by = new Map<ProviderId, { ok: boolean; durationMs: number }[]>();
  for (const r of runs) {
    const list = by.get(r.provider) ?? [];
    if (list.length < window) list.push(r);
    by.set(r.provider, list);
  }
  const out = new Map<ProviderId, SeatStats>();
  for (const [provider, list] of by) {
    const ok = list.filter((r) => r.ok);
    const times = ok.map((r) => r.durationMs).sort((a, b) => a - b);
    const mid = Math.floor(times.length / 2);
    const median =
      times.length === 0
        ? Infinity
        : times.length % 2
          ? times[mid]!
          : (times[mid - 1]! + times[mid]!) / 2;
    out.set(provider, { runs: list.length, okRate: ok.length / list.length, medianMs: median });
  }
  return out;
}
