import type { ProviderInfo } from '../../../shared/api';

/** Claude's models, weakest to strongest. */
const CLAUDE_TIERS = ['haiku', 'sonnet', 'opus', 'fable'];

/**
 * A clearly stronger model than `current` from the same provider, when one is known: the next
 * Claude tier up, or Codex's model described as frontier. Undefined when there's no clear answer.
 */
export function strongerModel(
  info: ProviderInfo | undefined,
  current: string | undefined,
): string | undefined {
  if (!info) return undefined;
  const now = current ?? info.defaultModel;
  if (info.provider === 'claude') {
    const ids = info.models.map((m) => m.id);
    // With the CLI's default and no known default model, the strongest one is the clear step up.
    if (!now) return [...CLAUDE_TIERS].reverse().find((t) => ids.includes(t));
    const at = CLAUDE_TIERS.indexOf(now);
    return at === -1 ? undefined : CLAUDE_TIERS.slice(at + 1).find((t) => ids.includes(t));
  }
  if (info.provider === 'codex') {
    const top = info.models.find((m) => /frontier/i.test(m.description ?? ''));
    return top && top.id !== now ? top.id : undefined;
  }
  return undefined;
}
