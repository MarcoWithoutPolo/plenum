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
