import { useEffect, useState } from 'react';
import { Sidebar } from '@/components/Sidebar';
import { Composer } from '@/components/Composer';
import { useApp } from '@/lib/store';
import {
  ModelPicker,
  type PickerEffort,
  type PickerModel,
  type PickerProvider,
  type PickerValue,
} from '@/components/ModelPicker';
import { settle } from '@/lib/settle';

/*
 * v0.9 design preview of the model picker inside the real app (demo mode, #picker-preview).
 * Claude, Codex, Antigravity and Cursor lists are what their CLIs reported on 2026-10-30;
 * Copilot and OpenCode are examples until they're installed.
 */

const levels = (notes: Record<string, string>, ids: string[]): PickerEffort[] =>
  ids.map((id) => ({
    id,
    label: id === 'xhigh' ? 'XHigh' : id[0]!.toUpperCase() + id.slice(1),
    note: notes[id] ?? '',
  }));

const CLAUDE_NOTES = {
  low: 'Quickest answers, lightest on your Claude plan',
  medium: 'Balanced speed and depth',
  high: 'Thinks longer before answering',
  xhigh: 'Thinks much longer on hard problems',
  max: 'Deepest reasoning; slowest and uses the most of your plan',
};
const claudeEfforts = levels(CLAUDE_NOTES, ['low', 'medium', 'high', 'xhigh', 'max']);

const CODEX_NOTES = {
  low: 'Fast responses with lighter reasoning',
  medium: 'Balances speed and reasoning depth for everyday tasks',
  high: 'Greater reasoning depth for complex problems',
  xhigh: 'Extra high reasoning depth for complex problems',
  max: 'Maximum reasoning depth for the hardest problems',
  ultra: 'Maximum reasoning with automatic task delegation',
};
const codex = (ids: string[], d: string) => ({
  efforts: levels(CODEX_NOTES, ids),
  defaultEffort: d,
});
const ALL = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

const inName = (ids: string[], model: string): PickerEffort[] =>
  levels(Object.fromEntries(ids.map((i) => [i, `Picks the ${model} ${i} variant`])), ids);

const cursor = (
  id: string,
  label: string,
  group: string,
  note: string,
  ids = ['low', 'medium', 'high', 'xhigh', 'max'],
  extra: Partial<PickerModel> = {},
): PickerModel => ({
  id,
  label,
  group,
  note,
  fast: true,
  efforts: ids.length ? inName(ids, label) : [],
  ...(ids.includes('high') && { defaultEffort: 'high' }),
  ...extra,
});

const PROVIDERS: PickerProvider[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    connected: true,
    status: 'Signed in · Max plan',
    effortName: 'Effort',
    defaultModel: 'opus',
    models: [
      {
        id: 'fable',
        label: 'Fable 5.1',
        note: 'Most capable for your hardest and longest-running tasks',
        efforts: claudeEfforts,
      },
      {
        id: 'opus',
        label: 'Opus 5.5',
        note: 'Best for everyday, complex tasks',
        efforts: claudeEfforts,
        tags: ['CLI default'],
        fast: true,
      },
      {
        id: 'sonnet',
        label: 'Sonnet 5.5',
        note: 'Efficient for routine tasks',
        efforts: claudeEfforts,
      },
      {
        id: 'haiku',
        label: 'Haiku 5.5',
        note: 'Fastest for quick answers',
        efforts: claudeEfforts,
      },
      { id: 'claude-fable-5', label: 'Fable 5', older: true, efforts: claudeEfforts },
      { id: 'claude-opus-5', label: 'Opus 5', older: true, efforts: claudeEfforts },
      { id: 'claude-sonnet-5', label: 'Sonnet 5', older: true, efforts: claudeEfforts },
      { id: 'claude-opus-4-8', label: 'Opus 4.8', older: true, efforts: claudeEfforts },
      {
        id: 'claude-haiku-4-5-20251001',
        label: 'Haiku 4.5',
        older: true,
        note: 'No effort setting',
      },
    ],
  },
  {
    id: 'codex',
    name: 'Codex',
    connected: true,
    status: 'At its limit until 4:10 PM',
    tone: 'warn',
    effortName: 'Reasoning',
    defaultModel: 'gpt-6.1-sol',
    models: [
      {
        id: 'gpt-6.1-sol',
        label: 'GPT-6.1-Sol',
        note: 'Latest workhorse model for coding and everyday work',
        tags: ['CLI default'],
        ...codex(ALL, 'low'),
      },
      {
        id: 'gpt-6-astra',
        label: 'GPT-6-Astra',
        note: 'Frontier intelligence for the most demanding work',
        ...codex(ALL, 'low'),
      },
      {
        id: 'gpt-6.1-terra',
        label: 'GPT-6.1 Terra',
        note: 'Codex model tuned for code edits',
        ...codex(ALL, 'low'),
      },
      {
        id: 'gpt-6-luna',
        label: 'GPT-6-Luna',
        note: 'Fast and affordable model for easier tasks',
        ...codex(ALL.slice(0, 5), 'medium'),
      },
      { id: 'gpt-6-sol', label: 'GPT-6-Sol', older: true, ...codex(ALL, 'medium') },
      { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', older: true, ...codex(ALL, 'low') },
      { id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra', older: true, ...codex(ALL, 'medium') },
      {
        id: 'gpt-5.6-luna',
        label: 'GPT-5.6-Luna',
        older: true,
        ...codex(ALL.slice(0, 5), 'medium'),
      },
    ],
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    connected: true,
    status: 'Signed in · Google AI Pro',
    effortName: 'Thinking',
    defaultModel: 'gemini-3.8-flash',
    models: [
      {
        id: 'gemini-3.8-flash',
        label: 'Gemini 3.8 Flash',
        note: 'Fast; one model with three thinking levels',
        tags: ['CLI default'],
        efforts: inName(['low', 'medium', 'high'], 'Gemini 3.8 Flash'),
        defaultEffort: 'high',
      },
      {
        id: 'claude-opus-4-6-thinking',
        label: 'Claude Opus 4.6',
        note: 'Thinking · through your Google plan',
      },
      {
        id: 'claude-sonnet-4-6',
        label: 'Claude Sonnet 4.6',
        note: 'Thinking · through your Google plan',
      },
      { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B', note: 'Open model · medium reasoning' },
    ],
  },
  {
    id: 'cursor',
    name: 'Cursor',
    connected: true,
    status: 'Signed in · Hobby',
    effortName: 'Effort',
    defaultModel: 'auto',
    models: [
      {
        id: 'auto',
        label: 'Auto',
        group: 'Cursor',
        note: 'Cursor picks a model for each request',
        tags: ['CLI default'],
      },
      cursor('composer-2.5', 'Composer 2.5', 'Cursor', 'Cursor’s own coding model', []),
      cursor('claude-opus-5-5', 'Claude Opus 5.5', 'Claude', '1M context'),
      cursor('claude-fable-5-1', 'Claude Fable 5.1', 'Claude', 'Thinking · 1M context', [
        'high',
        'xhigh',
      ]),
      cursor('claude-sonnet-5-5', 'Claude Sonnet 5.5', 'Claude', '1M context'),
      cursor('claude-haiku-5-5', 'Claude Haiku 5.5', 'Claude', 'Fastest Claude'),
      cursor('gpt-5.6-sol', 'GPT-5.6 Sol', 'GPT', '1M context', [
        'none',
        'low',
        'medium',
        'high',
        'xhigh',
      ]),
      cursor('gpt-5.6-terra', 'GPT-5.6 Terra', 'GPT', '1M context', [
        'none',
        'low',
        'medium',
        'high',
        'xhigh',
      ]),
      cursor('gpt-5.6-luna', 'GPT-5.6 Luna', 'GPT', 'Light and quick', [
        'none',
        'low',
        'medium',
        'high',
        'xhigh',
      ]),
      cursor('gpt-5.3-codex', 'Codex 5.3', 'GPT', 'Tuned for code', [
        'low',
        'medium',
        'high',
        'xhigh',
      ]),
      cursor('grok-4.7', 'Grok 4.7', 'Grok', 'xAI', ['low', 'medium', 'high', 'xhigh']),
      cursor('gemini-4-argon', 'Gemini 4 Argon', 'Gemini', 'Google', []),
      cursor('gemini-3.8-flash', 'Gemini 3.8 Flash', 'Gemini', 'Google, fast', []),
      cursor('kimi-k3', 'Kimi K3', 'Other', 'Moonshot', []),
      cursor('glm-5.2', 'GLM 5.2', 'Other', 'Zhipu', []),
      cursor('deepseek-v41-flash', 'DeepSeek V4.1 Flash', 'Other', 'DeepSeek', []),
      ...[
        'Claude Opus 5',
        'Claude Fable 5',
        'Claude Sonnet 5',
        'Claude Opus 4.8',
        'Claude Opus 4.7',
        'Claude 4.6 Opus',
        'Claude 4.5 Sonnet',
        'Claude 4 Sonnet',
        'GPT-5.5',
        'GPT-5.4',
        'GPT-5.4 mini',
        'GPT-5.4 nano',
        'GPT-5.2',
        'GPT-5.1',
        'Grok 4.6',
        'Grok 4.5',
        'Gemini 3.7 Flash',
        'Gemini 3.6 Flash',
        'Muse Spark 1.3',
        'Muse Wonder 1.0',
      ].map((label) => ({
        id: label.toLowerCase().replace(/\s+/g, '-'),
        label,
        older: true,
        group: /^(Claude|GPT|Grok|Gemini)/.exec(label)?.[1] ?? 'Other',
      })),
    ],
  },
  {
    id: 'copilot',
    name: 'Copilot',
    connected: true,
    status: 'Copilot Free · auto model only',
    billing: 'Free plan',
    effortName: 'Effort',
    defaultModel: 'auto',
    models: [
      {
        id: 'auto',
        label: 'Auto',
        note: 'Copilot picks the model; the only choice on Copilot Free',
        tags: ['CLI default'],
        efforts: levels({ low: 'Fastest', medium: 'Balanced', high: 'Thinks longer' }, [
          'low',
          'medium',
          'high',
        ]),
      },
      {
        id: 'claude-sonnet-5-5',
        label: 'Claude Sonnet 5.5',
        note: 'Needs Copilot Pro',
        tags: ['Pro plan'],
      },
      { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', note: 'Needs Copilot Pro', tags: ['Pro plan'] },
    ],
  },
  {
    id: 'local',
    name: 'Local models',
    connected: true,
    status: 'Ollama · RTX 4070 Ti SUPER, 16 GB',
    billing: 'Free · on your GPU',
    effortHint:
      'Context 32k tokens, set for you. One task at a time on this GPU. Builds go through OpenCode.',
    defaultModel: 'gpt-oss:20b',
    models: [
      {
        id: 'gpt-oss:20b',
        label: 'GPT-OSS 20B',
        note: '13 GB · fits in GPU memory',
        tags: ['fits'],
      },
      {
        id: 'qwen2.5-coder:14b',
        label: 'Qwen2.5 Coder 14B',
        note: '9 GB · fits in GPU memory · fastest here',
        tags: ['fits'],
      },
      {
        id: 'qwen3-coder:30b',
        label: 'Qwen3 Coder 30B',
        note: '19 GB · partly on CPU: slower',
        tags: ['partly CPU'],
      },
      {
        id: 'llama4-scout',
        label: 'Llama 4 Scout',
        note: '67 GB · too big for this machine',
        tags: ['too big'],
      },
    ],
  },
  {
    id: 'grok',
    name: 'Grok Build',
    connected: false,
    status: 'Not connected',
    tone: 'off',
    models: [],
    install: {
      command: 'irm https://x.ai/cli/install.ps1 | iex',
      signIn: 'grok login',
      cost: 'Included with SuperGrok or X Premium+',
    },
  },
  {
    id: 'amp',
    name: 'Amp',
    connected: false,
    status: 'Not connected',
    tone: 'off',
    billing: 'Pays per use',
    models: [],
    install: {
      command: 'npm i -g @sourcegraph/amp',
      signIn: 'amp login',
      cost: 'Pay-as-you-go credits ($5 minimum); every run spends credits',
    },
  },
];

const RECENT: PickerValue[] = [
  { provider: 'codex', model: 'gpt-6.1-sol', effort: 'medium' },
  { provider: 'cursor', model: 'composer-2.5' },
  { provider: 'antigravity', model: 'gemini-3.8-flash', effort: 'high' },
];

export function PickerPreview() {
  const init = useApp((s) => s.init);
  const [value, setValue] = useState<PickerValue>({
    provider: 'claude',
    model: 'opus',
    effort: 'high',
  });
  useEffect(() => settle(init()), [init]);
  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="relative flex min-w-0 flex-1 flex-col">
        <header className="drag h-10 shrink-0" />
        <div className="flex flex-1 flex-col items-center justify-start px-8 pt-[12vh]">
          <div className="w-full max-w-2xl">
            <h2 className="text-center text-[26px] font-semibold tracking-tight">
              What are we working on?
            </h2>
            <p className="mt-2 mb-7 text-center text-[14px] text-muted">
              Pick who answers. You can switch models mid-chat, and the new one sees the whole
              conversation.
            </p>
            <Composer
              running={false}
              onSend={() => undefined}
              placeholder="Message Claude…"
              autoFocus={false}
              toolbar={
                <ModelPicker
                  providers={PROVIDERS}
                  value={value}
                  onChange={setValue}
                  recent={RECENT}
                  defaultOpen
                />
              }
            />
          </div>
        </div>
      </main>
    </div>
  );
}
