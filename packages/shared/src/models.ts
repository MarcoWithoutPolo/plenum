/**
 * Model catalogs: what each CLI says it can run, grouped so the picker shows one row per model
 * with its effort levels, however the CLI spells them (a flag, or part of the id).
 */

/** One run of a model: the id the CLI takes, and the effort or speed it stands for. */
export interface ModelVariant {
  id: string;
  /** The effort level this id runs at; missing for the plain id ("Auto"). */
  effort?: string;
  fast?: boolean;
}

export interface ModelOption {
  /** The id to run. For a grouped model, the plain id or its first variant. */
  id: string;
  label?: string;
  /** One line on what the model is for, when the CLI provides it. */
  description?: string;
  /** Effort levels, weakest first. */
  efforts?: string[];
  defaultEffort?: string;
  /** What each effort level does, in the CLI's own words, when it says. */
  effortNotes?: Record<string, string>;
  /** For CLIs that put effort or speed in the id (Cursor, Antigravity): every id of this model. */
  variants?: ModelVariant[];
  /** A faster mode exists (a `-fast` variant). */
  fast?: boolean;
  /** Who made it, for maker chips in a provider that offers several makers' models. */
  maker?: string;
  /** A newer version of the same model is listed. */
  older?: boolean;
  /** Short facts: size, context, "too big" and so on. */
  tags?: string[];
  /**
   * How capable it is among this provider's models, when the CLI makes that clear (higher is
   * stronger): "Retry with a stronger model" steps up by it.
   */
  tier?: number;
}

export interface ModelList {
  models: ModelOption[];
  /** What "Default" means right now (the CLI's configured model). */
  defaultModel?: string;
  defaultEffort?: string;
}

/** Effort words, weakest first, as they appear at the end of ids and in labels. */
export const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

const EFFORT_LABELS: Record<string, string> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
  ultra: 'Ultra',
};

export function effortLabel(effort: string): string {
  return EFFORT_LABELS[effort] ?? effort.charAt(0).toUpperCase() + effort.slice(1);
}

export function sortEfforts(efforts: string[]): string[] {
  const rank = (e: string) => {
    const at = EFFORT_ORDER.indexOf(e);
    return at === -1 ? EFFORT_ORDER.length : at;
  };
  return [...new Set(efforts)].sort((a, b) => rank(a) - rank(b));
}

const ID_SUFFIX = new RegExp(`^(.*?)(?:-(${EFFORT_ORDER.join('|')}))?(-thinking)?(-fast)?$`);
const LABEL_WORDS = /\b(?:Extra High|XHigh|High|Medium|Low|Max|Minimal|None|Ultra)\b|\bFast\b/g;

/**
 * Splits an id like `gpt-5.6-sol-xhigh-fast` into its model and the effort and speed in it.
 * Ids without either come back whole.
 */
export function splitVariant(id: string): { family: string; effort?: string; fast: boolean } {
  const m = ID_SUFFIX.exec(id)!;
  // "-thinking" after the effort (`claude-4.6-opus-high-thinking`) belongs to the model's name.
  const family = m[2] ? `${m[1]}${m[3] ?? ''}` : id.replace(/-fast$/, '');
  return { family: family || id, ...(m[2] && { effort: m[2] }), fast: Boolean(m[4]) };
}

/**
 * Groups ids that differ only by an effort or `-fast` suffix into one model with variants.
 * Order follows the first appearance of each model. `label` gives each id's display name.
 */
export function groupVariants(
  entries: { id: string; label?: string; description?: string }[],
): ModelOption[] {
  const groups = new Map<
    string,
    { label?: string; description?: string; variants: ModelVariant[]; plainLabel?: string }
  >();
  for (const e of entries) {
    const { family, effort, fast } = splitVariant(e.id);
    let group = groups.get(family);
    if (!group) {
      group = { variants: [] };
      groups.set(family, group);
    }
    group.variants.push({ id: e.id, ...(effort && { effort }), ...(fast && { fast }) });
    if (e.label && !effort && !fast) group.plainLabel = e.label;
    if (e.label && !group.label) group.label = familyLabel(e.label);
    if (e.description && !group.description) group.description = e.description;
  }
  return [...groups].map(([family, g]) => {
    const efforts = sortEfforts(g.variants.flatMap((v) => (v.effort ? [v.effort] : [])));
    const plain = g.variants.find((v) => !v.effort && !v.fast);
    // One plain id needs no variants; an id with its effort in it does (it never takes a flag).
    const single = g.variants.length === 1 && !g.variants[0]!.effort && !g.variants[0]!.fast;
    const option: ModelOption = {
      id: plain?.id ?? (single ? g.variants[0]!.id : family),
      label: g.plainLabel ?? g.label ?? family,
      ...(g.description && { description: g.description }),
      ...(efforts.length && { efforts }),
      ...(g.variants.some((v) => v.fast) && { fast: true }),
      ...(!single && { variants: g.variants }),
      maker: makerOf(family),
    };
    // A model available at one effort only: that effort is its default.
    if (efforts.length && !plain)
      option.defaultEffort = efforts.includes('high') ? 'high' : efforts[0];
    return option;
  });
}

function familyLabel(label: string): string {
  return label
    .replace(LABEL_WORDS, '')
    .replace(/\(\s*\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** The id to run for a model at an effort and speed: its matching variant, or its own id. */
export function resolveModel(
  option: ModelOption,
  effort?: string,
  fast = false,
): { model: string; effort?: string } {
  if (!option.variants) return { model: option.id, ...(effort && { effort }) };
  const want =
    effort ?? (option.variants.some((v) => !v.effort) ? undefined : option.defaultEffort);
  const match =
    option.variants.find((v) => v.effort === want && Boolean(v.fast) === fast) ??
    option.variants.find((v) => v.effort === want && !v.fast) ??
    option.variants.find((v) => !v.effort && Boolean(v.fast) === fast) ??
    option.variants[0]!;
  return { model: match.id };
}

/** The model a run id belongs to, with the effort and speed that id stands for. */
export function findVariant(
  models: ModelOption[],
  id: string | undefined,
): { option: ModelOption; effort?: string; fast: boolean } | undefined {
  if (!id) return undefined;
  for (const option of models) {
    if (option.id === id && !option.variants) return { option, fast: false };
    const v = option.variants?.find((x) => x.id === id);
    if (v) return { option, ...(v.effort && { effort: v.effort }), fast: Boolean(v.fast) };
  }
  return models.find((m) => m.id === id)
    ? { option: models.find((m) => m.id === id)!, fast: false }
    : undefined;
}

const MAKERS: [RegExp, string][] = [
  [/^(?:claude|anthropic)/, 'Claude'],
  [/^(?:gpt|o\d|codex|openai|chatgpt)/, 'GPT'],
  [/^gemini|^gemma/, 'Gemini'],
  [/grok/, 'Grok'],
  [/^(?:composer|cursor|auto$)/, 'Cursor'],
  [/^deepseek/, 'DeepSeek'],
  [/^(?:qwen|qwq)/, 'Qwen'],
  [/^(?:llama|meta)/, 'Llama'],
  [/^(?:kimi|moonshot)/, 'Kimi'],
  [/^(?:mistral|codestral|devstral)/, 'Mistral'],
];

export function makerOf(id: string): string {
  const lower = id.toLowerCase();
  return MAKERS.find(([re]) => re.test(lower))?.[1] ?? 'Other';
}

/** A model's line and version: `claude-opus-4-8` → line `claude-opus`, version [4, 8]. */
export function modelLine(id: string): { line: string; version: number[] } {
  const parts = id.toLowerCase().split(/[-_:]/);
  const version: number[] = [];
  const words: string[] = [];
  for (const p of parts) {
    if (/^\d+(?:\.\d+)*$/.test(p) && p.length < 5) version.push(...p.split('.').map(Number));
    else if (/^\d{6,}$/.test(p))
      continue; // dates
    else {
      const m = /^([a-z]+)(\d+(?:\.\d+)*)$/.exec(p);
      if (m && !/^(?:o|v|r)$/.test(m[1]!)) {
        words.push(m[1]!);
        version.push(...m[2]!.split('.').map(Number));
      } else words.push(p);
    }
  }
  return { line: words.join('-'), version };
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/**
 * Marks a model "older" when the same line is listed in a newer version (Opus 4.8 next to
 * Opus 5.5). `resolved` maps aliases to the version they stand for (`opus` → `claude-opus-5-5`).
 */
export function markOlder(
  models: ModelOption[],
  resolved: Record<string, string> = {},
): ModelOption[] {
  const lines = models.map((m) => modelLine(resolved[m.id] ?? splitVariant(m.id).family));
  return models.map((m, i) => {
    const me = lines[i]!;
    if (!me.version.length) return m;
    const newer = lines.some(
      (o, j) => j !== i && o.line === me.line && compareVersions(o.version, me.version) > 0,
    );
    return newer ? { ...m, older: true } : m;
  });
}
