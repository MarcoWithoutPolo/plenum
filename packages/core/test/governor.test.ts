import { describe, expect, it } from 'vitest';
import { Governor, shortReason } from '../src/governor/governor.js';

describe('shortReason', () => {
  it('keeps the first sentence of a long limit message', () => {
    expect(
      shortReason(
        'You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 7:15 AM.',
      ),
    ).toBe('You’ve hit your usage limit.');
  });

  it('caps a long sentence and keeps short ones whole', () => {
    expect(shortReason('rate limited')).toBe('rate limited');
    expect(shortReason(`${'x'.repeat(200)}.`)).toHaveLength(120);
    expect(shortReason(undefined)).toBe('');
  });
});

describe('Governor readings without a reset time (E10)', () => {
  const at = Date.UTC(2026, 10, 2, 12);
  it('a usage reading at the ceiling with no reset blocks for an hour, not for ever', () => {
    let now = at;
    const g = new Governor(
      () => [{ provider: 'codex', window: 'five_hour', utilization: 0.99, resetsAt: null, at }],
      { now: () => now },
    );
    expect(g.availability('codex').ok).toBe(false);
    now = at + 59 * 60_000;
    expect(g.availability('codex').ok).toBe(false);
    now = at + 61 * 60_000;
    expect(g.availability('codex').ok).toBe(true);
  });
});

describe('Shared plans (F12)', () => {
  const at = Date.UTC(2026, 10, 2, 12);
  const policy = (sharedPlans: ('cursor' | 'grok')[][]) => ({
    limits: () => ({ providers: {}, quietHours: [], pauseAll: false, sharedPlans }),
    runsToday: () => 0,
  });
  const limited = () => [
    { provider: 'grok' as const, window: 'limit', utilization: 1, resetsAt: at + 3_600_000, at },
  ];

  it('a limit on Grok pauses Cursor too when they share a plan, and says why', () => {
    const g = new Governor(limited, { now: () => at, policy: policy([['cursor', 'grok']]) });
    const a = g.availability('cursor');
    expect(a.ok).toBe(false);
    expect(!a.ok && a.reason).toBe('usage limit reached (on Grok, which shares its plan)');
    expect(!a.ok && a.until).toBe(at + 3_600_000);
  });

  it('a rate-limited run on Cursor cools Grok down too', () => {
    const g = new Governor(() => [], { now: () => at, policy: policy([['cursor', 'grok']]) });
    g.observe('cursor', {
      ok: false,
      rateLimited: { message: 'Rate limit', resetsAt: at + 60_000 },
    });
    expect(g.availability('grok').ok).toBe(false);
    expect(g.availability('codex').ok).toBe(true);
  });

  it('without the setting, each stands alone', () => {
    const g = new Governor(limited, { now: () => at, policy: policy([]) });
    expect(g.availability('cursor').ok).toBe(true);
    expect(g.availability('grok').ok).toBe(false);
  });
});
