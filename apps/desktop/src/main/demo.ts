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
  return [
    new FakeAdapter(
      { reply: answer('Claude'), delayMs: 25 },
      {
        id: 'claude',
        displayName: 'Claude Code',
        resume: true,
        efforts: ['low', 'medium', 'high'],
      },
    ),
    new FakeAdapter(
      { reply: answer('Codex'), delayMs: 40 },
      { id: 'codex', displayName: 'OpenAI Codex', resume: true },
    ),
    new FakeAdapter(
      { reply: '', fail: 'Gemini is not connected in demo mode' },
      {
        id: 'gemini',
        displayName: 'Gemini',
        status: { auth: 'unknown', detail: 'Not connected in demo mode' },
      },
    ),
  ];
}
