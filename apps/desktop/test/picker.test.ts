import { describe, expect, it } from 'vitest';
import { groupVariants } from '@conclave/shared';
import type { ProviderInfo } from '../src/shared/api';
import {
  modelLabel,
  pickerProviders,
  seatToValue,
  valueToSeat,
} from '../src/renderer/src/lib/picker';

const base = { installed: true, auth: 'signed_in', loginHint: 'Sign in' } as const;

const cursor = {
  ...base,
  provider: 'cursor',
  displayName: 'Cursor',
  models: groupVariants([
    { id: 'gpt-5.3-codex-low', label: 'Codex 5.3 Low' },
    { id: 'gpt-5.3-codex', label: 'Codex 5.3' },
    { id: 'gpt-5.3-codex-high', label: 'Codex 5.3 High' },
    { id: 'gpt-5.3-codex-high-fast', label: 'Codex 5.3 High Fast' },
    { id: 'claude-opus-5-5-high', label: 'Claude Opus 5.5 High' },
  ]),
} as unknown as ProviderInfo;

const claude = {
  ...base,
  provider: 'claude',
  displayName: 'Claude Code',
  detail: 'claude.ai, max plan',
  defaultModel: 'opus',
  models: [
    { id: 'opus', label: 'Opus 5.5', efforts: ['low', 'high'], maker: 'Claude' },
    { id: 'claude-opus-4-8', label: 'Opus 4.8', older: true, maker: 'Claude' },
  ],
} as unknown as ProviderInfo;

describe('picker data', () => {
  it('runs the id that carries the chosen effort, with no effort flag', () => {
    expect(
      valueToSeat(
        { provider: 'cursor', model: 'gpt-5.3-codex', effort: 'high', fast: true },
        cursor,
      ),
    ).toEqual({ provider: 'cursor', model: 'gpt-5.3-codex-high-fast' });
    expect(valueToSeat({ provider: 'cursor', model: 'gpt-5.3-codex' }, cursor)).toEqual({
      provider: 'cursor',
      model: 'gpt-5.3-codex',
    });
    // A flag-effort CLI keeps its effort.
    expect(valueToSeat({ provider: 'claude', model: 'opus', effort: 'high' }, claude)).toEqual({
      provider: 'claude',
      model: 'opus',
      effort: 'high',
    });
  });

  it('shows a saved variant id as its model and effort', () => {
    expect(seatToValue({ provider: 'cursor', model: 'gpt-5.3-codex-high-fast' }, cursor)).toEqual({
      provider: 'cursor',
      model: 'gpt-5.3-codex',
      effort: 'high',
      fast: true,
    });
    expect(modelLabel(cursor, 'gpt-5.3-codex-low')).toBe('Codex 5.3 Low');
    expect(modelLabel(claude, 'opus')).toBe('Opus 5.5');
    expect(modelLabel(claude, undefined)).toBe('Default');
  });

  it('gives each provider its own words, status, billing and maker groups', () => {
    const [c, cur] = pickerProviders([claude, cursor]);
    expect(c).toMatchObject({
      name: 'Claude',
      connected: true,
      status: 'claude.ai, max plan',
      billing: 'Your plan',
      effortName: 'Effort',
    });
    // One maker: no chips. Several: one chip per maker.
    expect(c!.models.every((m) => m.group === undefined)).toBe(true);
    expect(new Set(cur!.models.map((m) => m.group))).toEqual(new Set(['GPT', 'Claude']));
    expect(c!.models.find((m) => m.id === 'opus')!.efforts!.map((e) => e.label)).toEqual([
      'Low',
      'High',
    ]);
    expect(c!.models.find((m) => m.id === 'claude-opus-4-8')!.older).toBe(true);
  });

  it('says what a provider needs when it is not connected', () => {
    const [off] = pickerProviders([{ ...claude, auth: 'signed_out' } as ProviderInfo]);
    expect(off).toMatchObject({ connected: false, installed: true, status: 'Not signed in' });
    expect(off!.install!.command).toBe('npm install -g @anthropic-ai/claude-code');
  });
});
