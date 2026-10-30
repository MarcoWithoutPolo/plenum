import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  findVariant,
  groupVariants,
  makerOf,
  markOlder,
  resolveModel,
  splitVariant,
} from '../src/index.js';

const fixtures = fileURLToPath(new URL('../../../test/fixtures/', import.meta.url));

function cursorEntries() {
  return readFileSync(fixtures + 'cursor/models.txt', 'utf8')
    .split(/\r?\n/)
    .flatMap((l) => {
      const m = /^([\w.:/[\]-]+) - (.+)$/.exec(l.trim());
      return m ? [{ id: m[1]!, label: m[2]! }] : [];
    });
}

describe('model catalogs', () => {
  it('splits effort and speed out of ids', () => {
    expect(splitVariant('gpt-5.6-sol-xhigh-fast')).toEqual({
      family: 'gpt-5.6-sol',
      effort: 'xhigh',
      fast: true,
    });
    expect(splitVariant('claude-4.6-opus-high-thinking')).toEqual({
      family: 'claude-4.6-opus-thinking',
      effort: 'high',
      fast: false,
    });
    expect(splitVariant('composer-2.5-fast')).toEqual({ family: 'composer-2.5', fast: true });
    expect(splitVariant('auto')).toEqual({ family: 'auto', fast: false });
  });

  it("folds Cursor's 270 ids into a few dozen models, each with its efforts", () => {
    const entries = cursorEntries();
    expect(entries.length).toBeGreaterThan(250);
    const models = groupVariants(entries);
    expect(models.length).toBeLessThan(70);
    const codex = models.find((m) => m.id === 'gpt-5.3-codex')!;
    expect(codex).toMatchObject({ label: 'Codex 5.3', fast: true, maker: 'GPT' });
    expect(codex.efforts).toEqual(['low', 'high', 'xhigh']);
    // Every id the CLI listed is still reachable through some model.
    const reachable = new Set(models.flatMap((m) => m.variants?.map((v) => v.id) ?? [m.id]));
    for (const e of entries) expect(reachable.has(e.id)).toBe(true);
  });

  it('runs the variant that matches the chosen effort and speed', () => {
    const [codex] = groupVariants([
      { id: 'gpt-5.3-codex-low' },
      { id: 'gpt-5.3-codex' },
      { id: 'gpt-5.3-codex-fast' },
      { id: 'gpt-5.3-codex-high' },
      { id: 'gpt-5.3-codex-high-fast' },
    ]);
    expect(resolveModel(codex!, 'high', true)).toEqual({ model: 'gpt-5.3-codex-high-fast' });
    expect(resolveModel(codex!, 'low')).toEqual({ model: 'gpt-5.3-codex-low' });
    expect(resolveModel(codex!)).toEqual({ model: 'gpt-5.3-codex' });
    expect(resolveModel(codex!, undefined, true)).toEqual({ model: 'gpt-5.3-codex-fast' });
    expect(findVariant([codex!], 'gpt-5.3-codex-high-fast')).toMatchObject({
      option: { id: 'gpt-5.3-codex' },
      effort: 'high',
      fast: true,
    });
    // A model whose effort is a flag keeps it as one.
    expect(resolveModel({ id: 'opus', efforts: ['low', 'high'] }, 'high')).toEqual({
      model: 'opus',
      effort: 'high',
    });
  });

  it("groups Antigravity's thinking levels into one Gemini model", () => {
    const entries = readFileSync(fixtures + 'antigravity/models.txt', 'utf8')
      .split(/\r?\n/)
      .flatMap((l) => {
        const [id, label] = l.split('\t');
        return id && label ? [{ id: id.trim(), label: label.trim() }] : [];
      });
    const models = groupVariants(entries);
    const flash = models.find((m) => m.label === 'Gemini 3.8 Flash')!;
    expect(flash.efforts).toEqual(['low', 'medium', 'high']);
    expect(flash.defaultEffort).toBe('high');
    expect(resolveModel(flash, 'low')).toEqual({ model: 'gemini-3.8-flash-low' });
    expect(resolveModel(flash)).toEqual({ model: 'gemini-3.8-flash-high' });
  });

  it('marks earlier versions of a listed model as older', () => {
    const models = markOlder(
      [{ id: 'opus' }, { id: 'claude-opus-4-8' }, { id: 'claude-sonnet-5' }, { id: 'sonnet' }],
      { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5' },
    );
    expect(models.map((m) => Boolean(m.older))).toEqual([false, true, true, false]);
  });

  it('names the maker of common model families', () => {
    expect(makerOf('claude-opus-5')).toBe('Claude');
    expect(makerOf('gpt-5.6-sol')).toBe('GPT');
    expect(makerOf('cursor-grok-4.6')).toBe('Grok');
    expect(makerOf('composer-2.5')).toBe('Cursor');
    expect(makerOf('qwen2.5-coder:14b')).toBe('Qwen');
    expect(makerOf('glm-5.2')).toBe('Other');
  });
});
