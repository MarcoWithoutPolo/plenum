import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FakeAdapter, type Adapter, type RunRequest } from '@conclave/core';

/** Demo project work: a two-task plan, builders that write real files, reviewers that approve. */
const DEMO_TASKS = [
  {
    title: 'Add a greet() helper',
    spec: 'Create greet.js exporting greet(name) that returns "Hello, <name>!".',
    file: 'greet.js',
    body: ['module.exports = (name) => `Hello, ${name}!`;', ''].join('\n'),
  },
  {
    title: 'Document greet() in the README',
    spec: 'Add a Usage section showing greet("Ada").',
    file: 'USAGE.md',
    body: [
      '# Usage',
      '',
      '```js',
      'const greet = require("./greet");',
      'greet("Ada"); // Hello, Ada!',
      '```',
      '',
    ].join('\n'),
  },
];

function projectReply(req: RunRequest): string | undefined {
  if (req.role === 'planner') {
    const todo = DEMO_TASKS.filter((t) => !existsSync(join(req.cwd, t.file)));
    return todo.length
      ? JSON.stringify({ done: false, tasks: todo.map(({ title, spec }) => ({ title, spec })) })
      : JSON.stringify({ done: true, reason: 'greet.js and its usage notes are in place.' });
  }
  if (req.role === 'reviewer') {
    return JSON.stringify({
      approve: true,
      issues: [],
      summary: 'Small, focused and matches the task.',
    });
  }
  if (req.role === 'builder') return 'Made the change and checked it locally.';
  return undefined;
}

async function projectAct(req: RunRequest): Promise<void> {
  if (req.role !== 'builder') return;
  // CONCLAVE_DEMO_SLOW keeps builders busy long enough to see a project mid-run.
  if (process.env.CONCLAVE_DEMO_SLOW) await new Promise((r) => setTimeout(r, 2500));
  const task = DEMO_TASKS.find((t) => req.prompt.includes(`YOUR TASK: ${t.title}`));
  if (task) writeFileSync(join(req.cwd, task.file), task.body);
}

/**
 * Demo providers for CONCLAVE_DEMO=1: the whole app works offline, costs
 * nothing, and end-to-end tests get deterministic answers.
 */
export function demoAdapters(): Adapter[] {
  const answer = (name: string) => (req: RunRequest) => {
    const work = projectReply(req);
    if (work) return work;
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
      { reply: answer('Claude'), delayMs: 25, act: projectAct },
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
      {
        reply: answer('Codex'),
        delayMs: 40,
        act: projectAct,
      },
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
