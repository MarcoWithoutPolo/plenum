import { FakeAdapter, type Adapter, type RunRequest } from '@conclave/core';

/**
 * Demo providers for CONCLAVE_DEMO=1: the whole app works offline, costs
 * nothing, and end-to-end tests get deterministic answers.
 */
export function demoAdapters(): Adapter[] {
  const answer = (name: string) => (req: RunRequest) => {
    if (req.prompt.includes('You are the synthesizer')) {
      return [
        'Store settings as a JSON file in the app data folder [Claude, Codex].',
        '',
        'Use a small library that writes atomically [Codex].',
        '',
        '**Where they agree**',
        '- A JSON file in the user data folder.',
        '',
        '**Where they differ**',
        '- Nothing significant.',
      ].join('\n');
    }
    const question = req.prompt.split('\n').filter(Boolean).at(-1) ?? '';
    return `${name} (demo) here. You asked: "${question}". This is a demo answer that streams in word by word.`;
  };
  const hours = (h: number) => Date.now() + h * 3_600_000;
  const levels = ['low', 'medium', 'high', 'xhigh', 'max'];
  return [
    new FakeAdapter(
      { reply: answer('Claude'), delayMs: 25 },
      {
        id: 'claude',
        displayName: 'Claude Code',
        resume: true,
        efforts: levels,
        status: { version: '2.1.302', detail: 'claude.ai, max plan' },
        models: {
          models: ['fable', 'opus', 'sonnet', 'haiku'].map((id) => ({ id })),
        },
        limits: [
          { window: 'five_hour', utilization: 0.32, resetsAt: hours(2.2) },
          { window: 'seven_day', utilization: 0.43, resetsAt: hours(70) },
        ],
      },
    ),
    new FakeAdapter(
      { reply: answer('Codex'), delayMs: 40 },
      {
        id: 'codex',
        displayName: 'OpenAI Codex',
        resume: true,
        status: { version: '0.163.0', detail: 'Logged in using ChatGPT' },
        models: {
          defaultModel: 'gpt-6-astra',
          defaultEffort: 'ultra',
          models: [
            {
              id: 'gpt-6.1-sol',
              label: 'GPT-6.1-Sol',
              description: 'Latest workhorse model for coding and everyday work.',
              efforts: [...levels, 'ultra'],
              defaultEffort: 'medium',
            },
            {
              id: 'gpt-6-astra',
              label: 'GPT-6-Astra',
              description: 'Frontier model for the hardest problems.',
              efforts: [...levels, 'ultra'],
              defaultEffort: 'low',
            },
            {
              id: 'gpt-6-luna',
              label: 'GPT-6-Luna',
              description: 'Fast and light for quick tasks.',
              efforts: levels,
              defaultEffort: 'medium',
            },
          ],
        },
        limits: [
          { window: 'five_hour', utilization: 0.14, resetsAt: hours(3.4) },
          { window: 'seven_day', utilization: 0.02, resetsAt: hours(150) },
        ],
      },
    ),
    new FakeAdapter(
      { reply: '', fail: 'Gemini is not connected in demo mode' },
      {
        id: 'gemini',
        displayName: 'Gemini',
        status: {
          auth: 'unknown',
          version: '0.64.0',
          detail:
            'Google sign-in for individuals no longer works with this CLI; set GEMINI_API_KEY to use it',
        },
      },
    ),
  ];
}
