import type { ProviderInfo } from '../../../shared/api';

/**
 * A clearly stronger model than `current` from the same provider: the next tier up, as the
 * provider's own model list ranks them (Claude's aliases, Codex's "frontier" model). Undefined
 * when the list doesn't rank its models.
 */
export function strongerModel(
  info: ProviderInfo | undefined,
  current: string | undefined,
): string | undefined {
  if (!info) return undefined;
  const ranked = info.models.filter((m) => m.tier !== undefined && !m.older);
  if (!ranked.length) return undefined;
  const now = current ?? info.defaultModel;
  // With the CLI's default and no known default model, the strongest one is the clear step up.
  if (!now) return ranked.reduce((a, b) => (b.tier! > a.tier! ? b : a)).id;
  const at = ranked.find((m) => m.id === now)?.tier;
  if (at === undefined) return undefined;
  const up = ranked.filter((m) => m.tier! > at);
  return up.length ? up.reduce((a, b) => (b.tier! < a.tier! ? b : a)).id : undefined;
}
