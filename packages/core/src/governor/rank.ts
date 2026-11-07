import type { ProviderId, Routing, Seat } from '@conclave/shared';
import { seatLabel } from '../chat/transcript.js';

/** How a provider has done in one role lately, on this machine. */
export interface SeatStats {
  runs: number;
  /** Share of runs that finished without an error (usage limits not counted). */
  okRate: number;
  medianMs: number;
  /** Still leaning on Conclave's benchmark defaults: too few runs here yet. */
  prior?: boolean;
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

/**
 * Starting points measured in Conclave's benchmark and real projects (bench/RESULTS.md, "Team
 * finder"), so a new install doesn't start blind. Each counts as RANK.minRuns runs and fades out
 * as real runs come in. Only reviews: they sit on every task's critical path. A provider with no
 * entry starts unknown.
 */
export const PRIORS: Partial<
  Record<RankRole, Partial<Record<ProviderId, Omit<SeatStats, 'runs'>>>>
> = {
  reviewer: {
    claude: { okRate: 1, medianMs: 22_000 },
    codex: { okRate: 1, medianMs: 23_000 },
    copilot: { okRate: 1, medianMs: 46_000 },
    antigravity: { okRate: 0.9, medianMs: 65_000 },
    cursor: { okRate: 1, medianMs: 117_000 },
  },
};

/** Real stats blended with the benchmark priors until there are RANK.minRuns real runs. */
export function withPriors(
  role: RankRole,
  stats: Map<ProviderId, SeatStats>,
): Map<ProviderId, SeatStats> {
  const out = new Map(stats);
  for (const [provider, prior] of Object.entries(PRIORS[role] ?? {}) as [
    ProviderId,
    Omit<SeatStats, 'runs'>,
  ][]) {
    const real = stats.get(provider);
    const n = real?.runs ?? 0;
    if (n >= RANK.minRuns) continue;
    const k = RANK.minRuns;
    const mix = (p: number, r: number | undefined) =>
      real && Number.isFinite(r) ? (p * k + r! * n) / (k + n) : p;
    out.set(provider, {
      runs: n + k,
      okRate: mix(prior.okRate, real?.okRate),
      medianMs: mix(prior.medianMs, real?.medianMs),
      prior: true,
    });
  }
  return out;
}

export interface Ranked {
  seats: Seat[];
  /** Why the order changed, in plain words; empty when it didn't. */
  reasons: string[];
}

const time = (ms: number) =>
  ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${(ms / 60_000).toFixed(1)} min`;

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
    .map((s) => ({ seat: s, stats: known(s.provider) }))
    .filter((x) => x.stats && x.stats.okRate >= RANK.unreliable);
  const fastest = reliable.reduce<(typeof reliable)[number] | undefined>(
    (best, x) => (!best || x.stats!.medianMs < best.stats!.medianMs ? x : best),
    undefined,
  );
  const reasons = new Map<ProviderId, string>();
  const penalty = (seat: Seat): number => {
    const p = seat.provider;
    const name = seatLabel({ provider: p });
    const s = known(p);
    if (s && s.okRate < RANK.unreliable) {
      reasons.set(
        p,
        `${name} finished only ${Math.round(s.okRate * 100)}% of its recent ${role} runs`,
      );
      return 100;
    }
    const used = utilization(p);
    if (used !== null && used >= RANK.scarce) {
      reasons.set(
        p,
        `${name} is ${Math.round(used * 100)}% into its usage window, so it's saved for later`,
      );
      return 50;
    }
    if (
      role === 'reviewer' &&
      s &&
      fastest &&
      fastest.seat.provider !== p &&
      s.medianMs >= RANK.slow * fastest.stats!.medianMs
    ) {
      const where = s.prior || fastest.stats!.prior ? " in Conclave's benchmarks" : ' here';
      reasons.set(
        p,
        `${name} reviews take about ${time(s.medianMs)} (${seatLabel({ provider: fastest.seat.provider })} about ${time(fastest.stats!.medianMs)})${where}, so faster reviewers go first`,
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

/** For the team screen: the order each role will really use, and why it differs from yours. */
export interface RoleInsight {
  order: Seat[];
  reasons: string[];
  /** Median time per provider in this role, when known (here or from the benchmark). */
  times: Partial<Record<ProviderId, { medianMs: number; runs: number; prior: boolean }>>;
}

export function routingInsights(
  routing: Routing,
  roleRuns: (role: RankRole) => { provider: ProviderId; ok: boolean; durationMs: number }[],
  utilization: (provider: ProviderId) => number | null,
): Record<RankRole, RoleInsight> {
  const out = {} as Record<RankRole, RoleInsight>;
  for (const role of ['planner', 'builder', 'reviewer'] as const) {
    const stats = withPriors(role, seatStats(roleRuns(role)));
    const ranked = rankSeats(routing[role], role, stats, utilization);
    const times: RoleInsight['times'] = {};
    for (const seat of routing[role]) {
      const s = stats.get(seat.provider);
      if (s && Number.isFinite(s.medianMs))
        times[seat.provider] = {
          medianMs: s.medianMs,
          runs: s.prior ? s.runs - RANK.minRuns : s.runs,
          prior: Boolean(s.prior),
        };
    }
    out[role] = { order: ranked.seats, reasons: ranked.reasons, times };
  }
  return out;
}
