/**
 * Messages that mean "this account can't do more right now" rather than
 * "this task failed": rate limits, plan windows, spend caps, exhausted credits.
 * The governor moves work elsewhere instead of charging the task an attempt.
 */
const LIMIT_PATTERN = new RegExp(
  [
    String.raw`rate.?limit`,
    String.raw`usage limit`,
    String.raw`limit (?:reached|exceeded)`,
    String.raw`(?:hourly|daily|weekly|monthly) limit`,
    String.raw`reached (?:your |the )?(?:\w+ )?limit`,
    // Phrases only: a bare "quota", "billing" or "429" is as likely a file name or a number in
    // a stack trace (E9), and reading one as a limit sidelines the AI for an hour.
    String.raw`quota (?:has been |was )?(?:exceeded|reached|exhausted)`,
    String.raw`exceeded (?:your |the )?(?:current )?quota`,
    String.raw`(?:out of|insufficient) quota`,
    String.raw`spend(?:ing)? cap`,
    String.raw`usage cap`,
    String.raw`credit balance (?:is )?too low`,
    String.raw`out of credits`,
    String.raw`insufficient (?:credits|funds)`,
    String.raw`billing (?:hard )?limit`,
    String.raw`check your billing`,
    String.raw`payment required`,
    String.raw`too many requests`,
    String.raw`(?:status|http|error)\W{0,3}429`,
    String.raw`429 too many`,
  ].join('|'),
  'i',
);

export function looksLikeLimit(text: string | undefined): boolean {
  return Boolean(text && LIMIT_PATTERN.test(text));
}

/**
 * When a limit message says it lifts: "try again at 5:48 AM" (the next time it's that time) or
 * "try again in 2 hours 13 minutes". Without it the governor can only back off and ask again.
 */
export function limitResetsAt(text: string | undefined, now = new Date()): number | undefined {
  if (!text) return undefined;
  const at = /try again at (\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?\s*(UTC|GMT)?/i.exec(text);
  if (at) {
    let hour = Number(at[1]);
    const minute = Number(at[2] ?? 0);
    const half = at[3]?.toLowerCase().replace(/\./g, '');
    if (hour > 23 || minute > 59 || (half && (hour < 1 || hour > 12))) return undefined;
    if (half === 'pm' && hour < 12) hour += 12;
    if (half === 'am' && hour === 12) hour = 0;
    const next = new Date(now);
    // A time with UTC or GMT is that time in UTC; otherwise it's this computer's local time
    // (the CLI runs here and prints its own local time).
    if (at[4]) next.setUTCHours(hour, minute, 0, 0);
    else next.setHours(hour, minute, 0, 0);
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
