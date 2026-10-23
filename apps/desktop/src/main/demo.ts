import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FakeAdapter,
  GitHub,
  type Adapter,
  type CommandResult,
  type RunRequest,
} from '@conclave/core';

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

/**
 * CONCLAVE_DEMO_ASK=1: the second task's builder asks a question before it builds;
 * CONCLAVE_DEMO_ASK=install: it asks to install a package instead.
 */
const DEMO_QUESTION = {
  question: 'Which tone should the usage notes use?',
  why: 'It sets how all the docs read.',
  options: ['Short and plain', 'Friendly, with examples'],
  recommended: 'Short and plain',
};

function asksFirst(req: RunRequest): boolean {
  return (
    (process.env.CONCLAVE_DEMO_ASK === '1' || process.env.CONCLAVE_DEMO_ASK === 'install') &&
    req.role === 'builder' &&
    req.prompt.includes(`YOUR TASK: ${DEMO_TASKS[1]!.title}`) &&
    !/The user answered|Assumption made|Settled by/.test(req.prompt)
  );
}

function projectReply(req: RunRequest): string | undefined {
  if (req.prompt.includes('Before any work starts, find out what only the user can decide')) {
    return JSON.stringify({
      questions: [
        {
          id: 'q1',
          question: 'What should greet() say?',
          why: 'Every later task builds on the wording.',
          options: ['Hello, <name>!', 'Hi <name>', 'Welcome, <name>.'],
          recommended: 'Hello, <name>!',
        },
        {
          id: 'q2',
          question: 'Where should the usage notes live?',
          options: ['A USAGE.md file', 'The README'],
          recommended: 'A USAGE.md file',
        },
      ],
      // With lanes on, the planner plans the tasks (independent) instead of the clarify step.
      tasks:
        process.env.CONCLAVE_DEMO_LANES === '1'
          ? []
          : DEMO_TASKS.map(({ title, spec }) => ({ title, spec })),
      test_command: null,
    });
  }
  if (asksFirst(req)) {
    return JSON.stringify(
      process.env.CONCLAVE_DEMO_ASK === 'install'
        ? {
            question:
              'May I run `npm install marked` to render the usage notes from Markdown? I have no shell here and the rules do not let me reach the network.',
            why: 'The task asks for formatted usage notes, and marked turns Markdown into HTML.',
            permission: {
              kind: 'install',
              command: 'npm install marked',
              alternative: 'write the notes as plain HTML by hand, without a Markdown renderer',
            },
          }
        : DEMO_QUESTION,
    );
  }
  if (req.role === 'planner' && req.prompt.includes('THE USER SAYS')) {
    // Steering from the Chat tab: one task to add and one decision to record.
    return JSON.stringify({
      reply: 'Sure. I’d add a farewell() helper next to greet(), and keep the docs short.',
      actions: [
        {
          type: 'add_task',
          title: 'Add a farewell() helper',
          spec: 'Create farewell.js exporting farewell(name) that returns "Bye, <name>!".',
          after: [],
        },
        { type: 'decision', question: 'How long should the docs be?', answer: 'Short and plain' },
      ],
    });
  }
  if (req.role === 'planner') {
    const todo = DEMO_TASKS.filter((t) => !existsSync(join(req.cwd, t.file)));
    // CONCLAVE_DEMO_LANES=1: the tasks are independent and touch different files, so they run at once.
    const lanes = process.env.CONCLAVE_DEMO_LANES === '1';
    return todo.length
      ? JSON.stringify({
          done: false,
          tasks: todo.map(({ title, spec, file }) => ({
            title,
            spec,
            ...(lanes && {
              after: [],
              estimate: { files: [file], lines: 200, risk: 'low' },
            }),
          })),
        })
      : JSON.stringify({ done: true, reason: 'greet.js and its usage notes are in place.' });
  }
  if (req.role === 'reviewer') {
    // CONCLAVE_DEMO_REJECT=1: reviewers always ask for changes, to show the issue checklist.
    if (process.env.CONCLAVE_DEMO_REJECT === '1') {
      return JSON.stringify({
        approve: false,
        issues: ['Add a JSDoc comment to greet()', 'Rename the parameter to fullName'],
        summary: 'Two small things before this merges.',
      });
    }
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
  if (process.env.CONCLAVE_DEMO_SLOW) {
    const ms = process.env.CONCLAVE_DEMO_LANES === '1' ? 6000 : 2500;
    await new Promise((r) => setTimeout(r, ms));
  }
  if (asksFirst(req)) return;
  const task = DEMO_TASKS.find((t) => req.prompt.includes(`YOUR TASK: ${t.title}`));
  if (task) writeFileSync(join(req.cwd, task.file), task.body);
}

/** A GitHub CLI stand-in for demo mode: signed in, two repositories, two issues. */
export function demoGitHub(): GitHub {
  const ok = (stdout: string): CommandResult => ({ code: 0, stdout, stderr: '' });
  return new GitHub({
    command: 'gh',
    exec: async (args) => {
      const cmd = args.slice(0, 2).join(' ');
      if (args[0] === '--version') return ok('gh version 2.96.0 (2026-07-02)');
      if (cmd === 'auth status') {
        return ok(
          JSON.stringify({
            hosts: {
              'github.com': [
                {
                  state: 'success',
                  active: true,
                  login: 'demo-user',
                  scopes: 'gist, read:org, repo, workflow',
                  gitProtocol: 'https',
                },
              ],
            },
          }),
        );
      }
      if (cmd === 'repo list') {
        return ok(
          JSON.stringify([
            {
              nameWithOwner: 'demo-user/calculator',
              description: 'A calculator with too many particles',
              isPrivate: true,
              pushedAt: '2026-10-20T09:00:00Z',
              primaryLanguage: { name: 'JavaScript' },
              defaultBranchRef: { name: 'main' },
            },
            {
              nameWithOwner: 'demo-user/landing',
              description: 'Personal site',
              isPrivate: false,
              pushedAt: '2026-09-01T09:00:00Z',
              primaryLanguage: { name: 'HTML' },
              defaultBranchRef: { name: 'main' },
            },
          ]),
        );
      }
      if (cmd === 'repo clone') {
        // A real local repository, so the rest of the flow works offline.
        const dest = args[3]!;
        mkdirSync(dest, { recursive: true });
        const git = (...a: string[]) =>
          execFileSync('git', ['-c', 'user.name=Demo', '-c', 'user.email=demo@localhost', ...a], {
            cwd: dest,
          });
        git('init', '-q', '-b', 'main');
        writeFileSync(join(dest, 'README.md'), `# ${args[2]}\n`);
        git('add', '-A');
        git('commit', '-q', '-m', 'init');
        return ok('');
      }
      if (cmd === 'issue list') {
        return ok(
          JSON.stringify([
            {
              number: 12,
              title: 'Add a greet() helper',
              body: 'greet(name) should return a friendly greeting.',
              url: 'https://github.com/demo-user/calculator/issues/12',
              labels: [{ name: 'enhancement' }],
            },
          ]),
        );
      }
      return { code: 1, stdout: '', stderr: `demo gh has no answer for: gh ${args.join(' ')}` };
    },
  });
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
        // CONCLAVE_DEMO_LIMIT=1: Codex is at its workspace spend cap, to show limit handling.
        limitWhen: () =>
          process.env.CONCLAVE_DEMO_LIMIT === '1'
            ? {
                message:
                  'You hit your spend cap set by the owner of your workspace. Ask an owner to increase your spend cap to continue.',
              }
            : undefined,
        // CONCLAVE_DEMO_BREAK=1: Codex's builds crash, to show failure recovery.
        failWhen: (req) =>
          process.env.CONCLAVE_DEMO_BREAK === '1' && req.role === 'builder'
            ? 'codex exec: stream disconnected before completion (connection reset)'
            : undefined,
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
      { reply: answer('Antigravity'), delayMs: 30, act: projectAct },
      {
        id: 'antigravity',
        displayName: 'Antigravity',
        resume: true,
        efforts: levels,
        status: { version: '1.4.6', detail: 'Google account · 6 models' },
        models: {
          models: [
            { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
            { id: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 (Thinking)' },
            { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' },
          ],
        },
      },
    ),
  ];
}
