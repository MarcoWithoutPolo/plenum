import type { LimitSettings, ProviderId, QuietHours } from '@plenum/shared';

/** What the user set in Settings, plus today's run counts: the governor's house rules. */
export interface GovernorPolicy {
  limits(): LimitSettings;
  /** Runs this provider made since local midnight (any role, any project). */
  runsToday(provider: ProviderId): number;
}

export type Block = { reason: string; until: number | null };

const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return h * 60 + m;
};

const at = (day: Date, mins: number) => {
  const d = new Date(day);
  d.setHours(Math.floor(mins / 60), mins % 60, 0, 0);
  return d;
};

const clock = (d: Date) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** If `provider` is in quiet hours at `now`, when they end. Handles windows past midnight. */
export function quietUntil(rules: QuietHours[], provider: ProviderId, now: Date): number | null {
  const mins = now.getHours() * 60 + now.getMinutes();
  let end: number | null = null;
  for (const rule of rules) {
    if (rule.providers && !rule.providers.includes(provider)) continue;
    const from = minutes(rule.from);
    const to = minutes(rule.to);
    if (from === to) continue;
    const today = now.getDay();
    const yesterday = (today + 6) % 7;
    let until: Date | null = null;
    if (from < to) {
      if (rule.days.includes(today) && mins >= from && mins < to) until = at(now, to);
    } else if (mins >= from && rule.days.includes(today)) {
      // Started this evening, ends tomorrow morning.
      const tomorrow = new Date(now);
      tomorrow.setDate(now.getDate() + 1);
      until = at(tomorrow, to);
    } else if (mins < to && rule.days.includes(yesterday)) {
      until = at(now, to);
    }
    if (until && (end === null || until.getTime() > end)) end = until.getTime();
  }
  return end;
}

/** Why the user's own rules keep `provider` from starting anything right now, if they do. */
export function policyBlock(policy: GovernorPolicy, provider: ProviderId, now: Date): Block | null {
  const limits = policy.limits();
  if (limits.pauseAll) return { reason: 'you paused everything', until: null };
  const quiet = quietUntil(limits.quietHours, provider, now);
  if (quiet !== null)
    return { reason: `quiet hours until ${clock(new Date(quiet))}`, until: quiet };
  const cap = limits.providers[provider]?.dailyCap ?? null;
  if (cap !== null && policy.runsToday(provider) >= cap) {
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);
    return {
      reason: `daily cap reached (${cap} runs), resumes at midnight`,
      until: midnight.getTime(),
    };
  }
  return null;
}

/** The share of a plan window Plenum may use before leaving the rest for you. */
export function ceilingFor(
  policy: GovernorPolicy | undefined,
  provider: ProviderId,
  fallback: number,
): number {
  if (!policy) return fallback;
  return 1 - (policy.limits().providers[provider]?.leaveForMe ?? 0.1);
}
