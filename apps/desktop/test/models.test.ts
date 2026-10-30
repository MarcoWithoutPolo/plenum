import { describe, expect, it } from 'vitest';
import type { ProviderInfo } from '../src/shared/api';
import { strongerModel } from '../src/renderer/src/lib/models';

const info = (
  provider: string,
  models: { id: string; description?: string; tier?: number }[],
  defaultModel?: string,
) => ({ provider, models, ...(defaultModel && { defaultModel }) }) as unknown as ProviderInfo;

describe('strongerModel', () => {
  // Tiers as the Claude adapter sets them from its aliases.
  const claude = info(
    'claude',
    ['fable', 'opus', 'sonnet', 'haiku'].map((id, i) => ({ id, tier: 4 - i })),
  );

  it('steps Claude up one tier', () => {
    expect(strongerModel(claude, 'haiku')).toBe('sonnet');
    expect(strongerModel(claude, 'sonnet')).toBe('opus');
    expect(strongerModel(claude, 'opus')).toBe('fable');
    expect(strongerModel(claude, 'fable')).toBeUndefined();
    expect(strongerModel(claude, 'claude-custom-1')).toBeUndefined();
  });

  it('offers the strongest Claude model when the CLI default is unknown', () => {
    expect(strongerModel(claude, undefined)).toBe('fable');
  });

  it("offers Codex's frontier model unless it's already in use", () => {
    const codex = info(
      'codex',
      [
        { id: 'gpt-6.1-sol', description: 'Latest workhorse model for coding.', tier: 1 },
        {
          id: 'gpt-6-astra',
          description: 'Frontier intelligence for the most demanding work.',
          tier: 2,
        },
      ],
      'gpt-6.1-sol',
    );
    expect(strongerModel(codex, undefined)).toBe('gpt-6-astra');
    expect(strongerModel(codex, 'gpt-6-astra')).toBeUndefined();
  });

  it('makes no claim for providers without a known ranking', () => {
    expect(
      strongerModel(info('antigravity', [{ id: 'gemini-3.8-flash-low' }]), undefined),
    ).toBeUndefined();
  });
});
