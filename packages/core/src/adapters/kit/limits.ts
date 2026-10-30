/**
 * Messages that mean "this account can't do more right now" rather than
 * "this task failed": rate limits, plan windows, spend caps, exhausted credits.
 * The governor moves work elsewhere instead of charging the task an attempt.
 */
const LIMIT_PATTERN =
  /rate.?limit|usage limit|limit (?:reached|exceeded)|(?:hourly|daily|weekly|monthly) limit|reached (?:your |the )?(?:\w+ )?limit|quota|spend(?:ing)? cap|usage cap|credit balance|out of credits|insufficient (?:credits|quota|funds)|billing|too many requests|status\W*429|\b429\b/i;

export function looksLikeLimit(text: string | undefined): boolean {
  return Boolean(text && LIMIT_PATTERN.test(text));
}

/**
 * When a limit message says it lifts: "try again at 5:48 AM" (the next time it's that time) or
 * "try again in 2 hours 13 minutes". Without it the governor can only back off and ask again.
 */
export function limitResetsAt(text: string | undefined, now = new Date()): number | undefined {
  if (!text) return undefined;
  const at = /try again at (\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?/i.exec(text);
  if (at) {
    let hour = Number(at[1]);
    const minute = Number(at[2] ?? 0);
    const half = at[3]?.toLowerCase().replace(/\./g, '');
    if (hour > 23 || minute > 59 || (half && (hour < 1 || hour > 12))) return undefined;
    if (half === 'pm' && hour < 12) hour += 12;
    if (half === 'am' && hour === 12) hour = 0;
    const next = new Date(now);
    next.setHours(hour, minute, 0, 0);
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
    return next.getTime();
  }
  const within =
    /try again in ((?:\d+\s*(?:days?|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b[\s,and]*)+)/i.exec(
      text,
    );
  if (within) {
    const unit = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 } as const;
    let ms = 0;
    for (const [, n, u] of within[1]!.matchAll(/(\d+)\s*([dhms])/gi)) {
      ms += Number(n) * unit[u!.toLowerCase() as keyof typeof unit];
    }
    return ms > 0 ? now.getTime() + ms : undefined;
  }
  return undefined;
}
