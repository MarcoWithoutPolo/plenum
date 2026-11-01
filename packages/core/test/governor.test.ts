import { describe, expect, it } from 'vitest';
import { shortReason } from '../src/governor/governor.js';

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
