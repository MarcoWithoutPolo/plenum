import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  PROVIDERS,
  ProviderId,
  firstPreferred,
  preferred,
  providerEntry,
  shortName,
} from '../src/index.js';

/** WCAG contrast of two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const v = parseInt(hex.slice(i, i + 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x! + 0.05) / (y! + 0.05);
}

describe('provider registry', () => {
  it('names every provider once, with ids the schema accepts', () => {
    const ids = PROVIDERS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(ProviderId.safeParse(id).success).toBe(true);
    expect(ProviderId.safeParse('Claude').success).toBe(false);
    expect(ProviderId.safeParse('').success).toBe(false);
    expect(ProviderId.safeParse('a b').success).toBe(false);
  });

  it('keeps the default team order Conclave has always used', () => {
    const real = (job: Parameters<typeof preferred>[0]) =>
      preferred(job).filter((id) => ['claude', 'codex', 'antigravity'].includes(id));
    expect(real('planner')).toEqual(['claude', 'antigravity', 'codex']);
    expect(real('builder')).toEqual(['codex', 'claude', 'antigravity']);
    expect(real('reviewer')).toEqual(['claude', 'antigravity', 'codex']);
    expect(firstPreferred([{ provider: 'codex' }, { provider: 'claude' }])?.provider).toBe(
      'claude',
    );
    expect(firstPreferred([{ provider: 'unknown-ai' }, { provider: 'amp' }])?.provider).toBe('amp');
  });

  it('falls back to the id for a provider this version does not know', () => {
    expect(shortName('claude')).toBe('Claude');
    expect(shortName('someday-ai')).toBe('someday-ai');
    expect(providerEntry('someday-ai')).toBeUndefined();
  });

  it('gives every visible provider a colour readable on both app surfaces', () => {
    // The app's panel colours in light and dark (apps/desktop/src/renderer/src/styles.css).
    for (const p of PROVIDERS.filter((x) => !x.hidden)) {
      expect(contrast(p.colour, '#ffffff'), `${p.id} on light`).toBeGreaterThanOrEqual(3);
      expect(contrast(p.colour, '#1a1b1e'), `${p.id} on dark`).toBeGreaterThanOrEqual(3);
    }
  });

  it('matches the colours the app paints with', () => {
    const css = readFileSync(
      new URL('../../../apps/desktop/src/renderer/src/styles.css', import.meta.url),
      'utf8',
    );
    for (const p of PROVIDERS.filter((x) => x.id !== 'gemini')) {
      expect(css, p.id).toMatch(new RegExp(`--${p.id}: ${p.colour};`, 'i'));
    }
  });

  it('only offers installs from the vendors themselves', () => {
    for (const p of PROVIDERS) {
      const lines = [p.install?.script?.windows, p.install?.script?.unix].filter(Boolean);
      for (const line of lines)
        expect(line, p.id).toMatch(/https:\/\/(antigravity\.google|cursor\.com|x\.ai)\//);
    }
  });
});
