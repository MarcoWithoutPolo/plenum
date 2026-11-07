/**
 * Every AI Conclave knows about, as data. Display names, colours, install and sign-in steps,
 * default lanes and the default team order all come from here, so adding a provider means one
 * entry and one adapter, never a switch on its id elsewhere. An entry without an adapter in
 * core simply isn't offered yet.
 */

export type ProviderCost = 'plan' | 'credits' | 'free-local';

export interface ProviderEntry {
  id: string;
  /** Full product name ("Claude Code"). */
  name: string;
  /** Short name for labels and transcripts ("Claude"). */
  short: string;
  /** Validated with the dataviz palette script against the light and dark surfaces. */
  colour: string;
  cost: ProviderCost;
  install?: {
    /** npm package of the official CLI, for guided installs. */
    npm?: string;
    /** A PowerShell or shell line from the vendor's docs, shown and run only after approval. */
    script?: { windows?: string; unix?: string };
    docs?: string;
    note?: string;
  };
  /** How many tasks it may build at once across projects, by default. */
  laneCap: number;
  /** Whether the CLI reports plan usage, so "leave some for me" can apply. */
  reportsUsage?: boolean;
  /**
   * Default team order: lower goes first. Set from measured speed and reliability (bench/RESULTS.md,
   * "Team finder", and real projects): Claude plans and reviews fastest and most reliably, Codex
   * builds fastest, Copilot reviews reliably in under a minute, Antigravity and Cursor are slower.
   * The brain adjusts this from measured reliability, quota and speed.
   */
  prefer: { planner: number; builder: number; reviewer: number; chat: number };
  /** Listed only for people who set it up themselves (an API key, a retired CLI). */
  hidden?: boolean;
  /** What the CLI calls its effort setting ("Reasoning", "Thinking"). Defaults to "Effort". */
  effortName?: string;
  /** One sentence on what it is, for "AIs you can add". */
  blurb?: string;
  /** Shown in the picker instead of an effort control, for AIs without effort levels. */
  effortHint?: string;
}

export const PROVIDERS: readonly ProviderEntry[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    short: 'Claude',
    colour: '#d0683f',
    cost: 'plan',
    install: { npm: '@anthropic-ai/claude-code', docs: 'https://code.claude.com/docs' },
    laneCap: 2,
    reportsUsage: true,
    prefer: { planner: 1, builder: 2, reviewer: 1, chat: 1 },
    effortName: 'Effort',
    blurb: "Anthropic's coding agent; uses your Claude plan.",
  },
  {
    id: 'codex',
    name: 'Codex',
    short: 'Codex',
    colour: '#10a37f',
    cost: 'plan',
    install: { npm: '@openai/codex', docs: 'https://developers.openai.com/codex/cli' },
    laneCap: 2,
    reportsUsage: true,
    prefer: { planner: 2, builder: 1, reviewer: 2, chat: 2 },
    effortName: 'Reasoning',
    blurb: "OpenAI's coding agent; uses your ChatGPT plan.",
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    short: 'Antigravity',
    colour: '#3b7de0',
    cost: 'plan',
    install: {
      script: { windows: 'irm https://antigravity.google/cli/install.ps1 | iex' },
      docs: 'https://antigravity.google/docs/install/',
      note: 'Antigravity replaced the Gemini CLI for Google accounts.',
    },
    laneCap: 1,
    prefer: { planner: 3, builder: 3, reviewer: 4, chat: 3 },
    effortName: 'Thinking',
    blurb: "Google's agent CLI; uses your Google account.",
  },
  {
    id: 'copilot',
    name: 'Copilot',
    short: 'Copilot',
    colour: '#c2569b',
    cost: 'plan',
    install: {
      npm: '@github/copilot',
      docs: 'https://docs.github.com/en/copilot/how-tos/copilot-cli',
      note: 'Every GitHub account includes Copilot Free.',
    },
    laneCap: 1,
    prefer: { planner: 5, builder: 4, reviewer: 3, chat: 5 },
    effortName: 'Effort',
    blurb: "GitHub's agent CLI; every GitHub account has Copilot Free.",
  },
  {
    id: 'cursor',
    name: 'Cursor',
    short: 'Cursor',
    colour: '#b38600',
    cost: 'plan',
    install: {
      script: {
        windows: "irm 'https://cursor.com/install?win32=true' | iex",
        unix: 'curl https://cursor.com/install -fsS | bash',
      },
      docs: 'https://cursor.com/docs/cli/installation',
    },
    laneCap: 1,
    prefer: { planner: 4, builder: 5, reviewer: 5, chat: 4 },
    effortName: 'Effort',
    blurb: "Cursor's agent CLI, with many makers' models; Hobby plan is free.",
  },
  {
    id: 'grok',
    name: 'Grok Build',
    short: 'Grok',
    colour: '#a0522d',
    cost: 'plan',
    install: {
      script: {
        windows: 'irm https://x.ai/cli/install.ps1 | iex',
        unix: 'curl -fsSL https://x.ai/cli/install.sh | bash',
      },
      docs: 'https://docs.x.ai/build/overview',
      note: 'Its installer also adds an `agent` command, which can shadow Cursor’s.',
    },
    laneCap: 1,
    prefer: { planner: 6, builder: 6, reviewer: 6, chat: 6 },
    effortName: 'Reasoning',
    blurb: "xAI's Grok Build CLI; a free grok.com account works.",
  },
  {
    id: 'amp',
    name: 'Amp',
    short: 'Amp',
    colour: '#6d8f00',
    cost: 'credits',
    install: { npm: '@ampcode/cli', docs: 'https://ampcode.com/docs/cli' },
    laneCap: 1,
    prefer: { planner: 8, builder: 8, reviewer: 8, chat: 8 },
    // Deferred past v0.9: its headless runs need a token the user creates.
    hidden: true,
    effortName: 'Mode',
    blurb: "Sourcegraph's agent; pays per use.",
  },
  {
    id: 'local',
    name: 'Local models',
    short: 'Local',
    colour: '#7e57c2',
    cost: 'free-local',
    install: { docs: 'https://ollama.com/download' },
    laneCap: 1,
    prefer: { planner: 7, builder: 7, reviewer: 7, chat: 7 },
    effortName: 'Context',
    effortHint:
      'No effort setting: Conclave gives each job the context it needs (8k to chat, 16k to review, 32k to build).',
    blurb: 'Models on your own computer through Ollama: free, private, offline.',
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    short: 'Gemini',
    colour: '#3b7de0',
    cost: 'plan',
    install: { npm: '@google/gemini-cli' },
    laneCap: 1,
    prefer: { planner: 9, builder: 9, reviewer: 9, chat: 9 },
    hidden: true,
  },
  {
    id: 'fake',
    name: 'Fake',
    short: 'Fake',
    colour: '#8a8a8a',
    cost: 'free-local',
    laneCap: 2,
    prefer: { planner: 10, builder: 10, reviewer: 10, chat: 10 },
    hidden: true,
  },
];

const BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]));

export function providerEntry(id: string): ProviderEntry | undefined {
  return BY_ID.get(id);
}

/** Short name for any provider id, including one this version doesn't know. */
export function shortName(id: string): string {
  return BY_ID.get(id)?.short ?? id;
}

/** Display order: the registry's order, unknown ids last. */
export function providerOrder(id: string): number {
  const at = PROVIDERS.findIndex((p) => p.id === id);
  return at === -1 ? PROVIDERS.length : at;
}

/** The item whose provider comes first for a job (chat: who answers by default). */
export function firstPreferred<T extends { provider: string }>(
  items: readonly T[],
  job: keyof ProviderEntry['prefer'] = 'chat',
): T | undefined {
  const rank = (id: string) => providerEntry(id)?.prefer[job] ?? Number.MAX_SAFE_INTEGER;
  return [...items].sort((a, b) => rank(a.provider) - rank(b.provider))[0];
}

/** Ids best first for a job, from the registry's default preference. */
export function preferred(job: keyof ProviderEntry['prefer']): string[] {
  return [...PROVIDERS].sort((a, b) => a.prefer[job] - b.prefer[job]).map((p) => p.id);
}

/** A short list of models to download for local use, with what each is good for. */
export const LOCAL_LIBRARY: readonly { id: string; label: string; sizeGb: number; use: string }[] =
  [
    { id: 'llama3.2:3b', label: 'Llama 3.2 3B', sizeGb: 2, use: 'Quick answers on any machine' },
    {
      id: 'qwen2.5-coder:7b',
      label: 'Qwen2.5 Coder 7B',
      sizeGb: 4.7,
      use: 'Code questions and reviews',
    },
    {
      id: 'gpt-oss:20b',
      label: 'GPT-OSS 20B',
      sizeGb: 13.8,
      use: 'Builds through OpenCode (uses tools well); needs about 16 GB of graphics memory',
    },
    {
      id: 'qwen2.5-coder:32b',
      label: 'Qwen2.5 Coder 32B',
      sizeGb: 20,
      use: 'Stronger code answers; 24 GB GPU',
    },
    {
      id: 'gpt-oss:120b',
      label: 'GPT-OSS 120B',
      sizeGb: 65,
      use: 'For big machines: 80 GB of GPU memory',
    },
  ];
