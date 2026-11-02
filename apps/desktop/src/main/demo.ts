import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FakeAdapter,
  GitHub,
  createProject,
  type Adapter,
  type CommandResult,
  type FakeOptions,
  type FakeScript,
  type RunRequest,
  type Store,
} from '@conclave/core';
import { groupVariants, markOlder, type ProviderId } from '@conclave/shared';

interface DemoTask {
  title: string;
  spec: string;
  file: string;
  body: string;
  /** More files the builder writes. */
  more?: Record<string, string>;
  /** What the builder writes once a reviewer sent it back (CONCLAVE_DEMO_VISUAL). */
  fixed?: string;
}

/** CONCLAVE_DEMO_WEB=1: a small web page, so the preview and the screenshots have something. */
const page = (align: 'left' | 'center') =>
  [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light dark">',
    '<title>Counter</title>',
    '<link rel="stylesheet" href="style.css">',
    '</head>',
    '<body>',
    '<main>',
    '<h1>Counter</h1>',
    `<p id="count" style="text-align: ${align}">0</p>`,
    '<button type="button" id="add">Add one</button>',
    '</main>',
    '<script>',
    'const n = document.getElementById("count");',
    'document.getElementById("add").onclick = () => (n.textContent = String(Number(n.textContent) + 1));',
    '</script>',
    '</body>',
    '</html>',
    '',
  ].join('\n');

const STYLE = [
  ':root { --bg: #ffffff; --ink: #1b1b1f; --accent: #4b3fd6; }',
  '@media (prefers-color-scheme: dark) { :root { --bg: #15151a; --ink: #f2f2f5; --accent: #9d94ff; } }',
  'body { margin: 0; background: var(--bg); color: var(--ink); font: 18px/1.5 system-ui, sans-serif; }',
  'main { max-width: 32rem; margin: 0 auto; padding: 3rem 1.25rem; text-align: center; }',
  '#count { font-size: 4rem; font-weight: 700; margin: 1rem 0; }',
  'button { min-height: 48px; padding: 0 1.5rem; border: 0; border-radius: 12px; background: var(--accent); color: #fff; font: inherit; }',
  '@media (prefers-color-scheme: dark) { button { color: #15151a; } }',
  '',
].join('\n');

const WEB_TASKS: DemoTask[] = [
  {
    title: 'Build the counter page',
    spec: 'Create index.html and style.css: a title, the count, and an "Add one" button, in light and dark.',
    file: 'index.html',
    body: page('left'),
    more: {
      'style.css': STYLE,
      'conclave.shots.json': `${JSON.stringify({ states: [{ name: 'counted', page: '/', steps: [{ click: 'Add one' }, { click: 'Add one' }] }] }, null, 2)}\n`,
    },
    fixed: page('center'),
  },
  {
    title: 'Document the page in USAGE.md',
    spec: 'Add a Usage section: open index.html, press "Add one".',
    file: 'USAGE.md',
    body: ['# Usage', '', 'Open index.html and press "Add one".', ''].join('\n'),
  },
];

/** Demo project work: a two-task plan, builders that write real files, reviewers that approve. */
const GREET_TASKS: DemoTask[] = [
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

const web = () => process.env.CONCLAVE_DEMO_WEB === '1';
const demoTasks = () => (web() ? WEB_TASKS : GREET_TASKS);

/**
 * CONCLAVE_DEMO_VISUAL=1: a reviewer that can see sends the page back once: the count sits at
 * the left on a phone. The builder centers it, and the next review approves.
 */
function visualReply(req: RunRequest): string | undefined {
  if (process.env.CONCLAVE_DEMO_VISUAL !== '1' || !req.images?.length) return undefined;
  const html = join(req.cwd, 'index.html');
  if (!existsSync(html) || readFileSync(html, 'utf8').includes('text-align: center')) {
    return undefined;
  }
  // The first screenshot's whole label, a sample state's included: "after: / (counted) (phone, dark)".
  const shot =
    /^- (after: .+?\((?:desktop|phone), (?:light|dark)\)): /m.exec(req.prompt)?.[1] ??
    'after: / (phone, dark)';
  return JSON.stringify({
    approve: false,
    issues: [],
    summary: 'The count is off-center.',
    visual: [
      {
        shot,
        issue: 'The count sits at the left edge, away from the title and button; center it',
        box: shot.includes('phone') ? [16, 150, 120, 260] : [384, 150, 520, 260],
      },
    ],
  });
}

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
    req.prompt.includes(`YOUR TASK: ${GREET_TASKS[1]!.title}`) &&
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
          : demoTasks().map(({ title, spec }) => ({ title, spec })),
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
    const todo = demoTasks().filter((t) => !existsSync(join(req.cwd, t.file)));
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
      : JSON.stringify({
          done: true,
          reason: web()
            ? 'The counter page and its usage notes are in place.'
            : 'greet.js and its usage notes are in place.',
        });
  }
  if (req.role === 'reviewer') {
    const visual = visualReply(req);
    if (visual) return visual;
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
  const task = demoTasks().find((t) => req.prompt.includes(`YOUR TASK: ${t.title}`));
  if (!task) return;
  const sentBack = task.fixed && /The count sits at the left edge/.test(req.prompt);
  writeFileSync(join(req.cwd, task.file), sentBack ? task.fixed! : task.body);
  for (const [file, body] of Object.entries(task.more ?? {}))
    writeFileSync(join(req.cwd, file), body);
}

/** CONCLAVE_DEMO_OUT=codex: that AI starts at its usage limit for 70 minutes (the start-up check). */
export function demoReadings(store: Store): void {
  const out = process.env.CONCLAVE_DEMO_OUT as ProviderId | undefined;
  if (!out) return;
  const now = Date.now();
  store.recordQuota({
    provider: out,
    window: 'limit',
    utilization: 1,
    resetsAt: now + 70 * 60_000,
    at: now,
  });
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
 * CONCLAVE_DEMO_CONNECTED=<n> (F7 tests): the first n installed AIs are signed in and the others
 * signed out, and Sign in signs one in after a moment, as if its own sign-in had finished.
 */
const signedIn = new Set<string>();
const connectedCount = process.env.CONCLAVE_DEMO_CONNECTED;

export function demoSignIn(provider: string): Promise<{ opened: boolean }> {
  setTimeout(() => signedIn.add(provider), 800);
  return Promise.resolve({ opened: true });
}

function withDemoAuth(adapters: Adapter[]): Adapter[] {
  if (connectedCount === undefined) return adapters;
  let left = Number(connectedCount);
  for (const a of adapters) {
    const detect = a.detect.bind(a);
    // Decided once, in registry order: the first n installed ones start signed in.
    const start = detect().then((s) => {
      if (s.installed && left > 0) {
        left--;
        signedIn.add(a.id);
      }
    });
    a.detect = async () => {
      await start;
      const s = await detect();
      return s.installed ? { ...s, auth: signedIn.has(a.id) ? 'signed_in' : 'signed_out' } : s;
    };
  }
  return adapters;
}

/** In CONCLAVE_DEMO_DATA=empty no AI is installed yet (the first run, every empty state). */
function installed(status: { version: string; detail: string }) {
  return demoData() === 'empty'
    ? { installed: false, auth: 'unknown' as const, version: undefined, detail: undefined }
    : status;
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
    // CONCLAVE_DEMO_SLOW_COUNCIL=1: Antigravity takes its time in a council, so there is a
    // member to skip (F4).
    if (process.env.CONCLAVE_DEMO_SLOW_COUNCIL && name === 'Antigravity' && req.role === 'chat')
      return `Antigravity (demo) is still thinking it through: ${'more detail '.repeat(150)}`;
    return `${name} (demo) here. You asked: "${question}". This is a demo answer that streams in word by word.`;
  };
  const hours = (h: number) => Date.now() + h * 3_600_000;
  const levels = ['low', 'medium', 'high', 'xhigh', 'max'];
  return withDemoAuth([
    new FakeAdapter(
      { reply: answer('Claude'), delayMs: 25, act: projectAct },
      {
        id: 'claude',
        displayName: 'Claude Code',
        // Like the real CLIs: Claude and Antigravity read screenshot files, Codex takes them attached.
        vision: 'files',
        resume: true,
        efforts: levels,
        status: installed({ version: '2.1.302', detail: 'claude.ai, max plan' }),
        // As Claude Code's start-up handshake reports them (test/fixtures/claude).
        models: {
          defaultModel: 'opus',
          models: [
            ['opus', 'Opus 5.5', 'Best for everyday, complex tasks'],
            ['fable', 'Fable 5.1', 'Most capable for your hardest and longest-running tasks'],
            ['sonnet', 'Sonnet 5.5', 'Efficient for routine tasks'],
            ['haiku', 'Haiku 5.5', 'Fastest for quick answers'],
            ['claude-opus-5', 'Opus 5', 'Best for everyday, complex tasks', true],
            ['claude-opus-4-8', 'Opus 4.8', 'Best for everyday, complex tasks', true],
          ].map(([id, label, description, older]) => ({
            id: id as string,
            label: label as string,
            description: description as string,
            efforts: levels,
            maker: 'Claude',
            ...(older ? { older: true } : {}),
            ...(['haiku', 'sonnet', 'opus', 'fable'].includes(id as string) && {
              tier: ['haiku', 'sonnet', 'opus', 'fable'].indexOf(id as string) + 1,
            }),
          })),
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
        vision: 'native',
        resume: true,
        status: installed({ version: '0.163.0', detail: 'Logged in using ChatGPT' }),
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
              tier: 2,
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
        vision: 'files',
        resume: true,
        status: installed({ version: '1.4.6', detail: 'Google account · 6 models' }),
        // As `agy models` lists them; Gemini's thinking levels group into one model.
        models: {
          models: groupVariants([
            { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
            { id: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)' },
            { id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)' },
            { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)' },
            { id: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 (Thinking)' },
            { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' },
          ]),
        },
      },
    ),
    ...moreAIs(answer, projectAct),
  ]);
}

/**
 * The AIs v0.9 added. Not installed in the demo by default, so every scenario keeps its
 * three-AI team and they show under "AIs you can add". CONCLAVE_DEMO_TEAM=9 signs them all in.
 */
function moreAIs(
  answer: (who: string) => FakeScript['reply'],
  act: FakeScript['act'],
): FakeAdapter[] {
  const on = process.env.CONCLAVE_DEMO_TEAM === '9' || demoData() === 'stress';
  const status = (version: string, detail: string) =>
    on
      ? { version, detail }
      : { installed: false, auth: 'unknown' as const, version: undefined, detail: undefined };
  const fake = (id: string, name: string, delayMs: number, options: Partial<FakeOptions>) =>
    new FakeAdapter({ reply: answer(name), delayMs, act }, { id, displayName: name, ...options });
  return [
    fake('copilot', 'GitHub Copilot', 35, {
      vision: 'native',
      status: status('1.0.105', 'GitHub account'),
      models: {
        defaultModel: 'auto',
        models: [
          {
            id: 'auto',
            label: 'Auto',
            description: 'Copilot picks the best model your plan allows',
          },
          { id: 'gpt-6-luna', label: 'gpt-6-luna' },
        ],
      },
    }),
    fake('cursor', 'Cursor', 30, {
      vision: 'files',
      status: status('2026.10.22', 'Cursor account'),
      // A slice of `cursor-agent models`, grouped as the real list is.
      models: {
        defaultModel: 'auto',
        models: markOlder(
          groupVariants([
            { id: 'auto', label: 'Auto' },
            { id: 'composer-2.5', label: 'Composer 2.5' },
            { id: 'composer-2.5-fast', label: 'Composer 2.5 Fast' },
            { id: 'grok-5-code', label: 'Grok 5 Code' },
            { id: 'claude-opus-5-5-low', label: 'Claude Opus 5.5 1M Low' },
            { id: 'claude-opus-5-5-high', label: 'Claude Opus 5.5 1M High' },
            { id: 'claude-opus-5-5-xhigh', label: 'Claude Opus 5.5 1M Extra High' },
            { id: 'claude-opus-5-5-high-fast', label: 'Claude Opus 5.5 1M High Fast' },
            { id: 'claude-opus-4-8-high', label: 'Claude Opus 4.8 1M High' },
            { id: 'gpt-5.6-sol-low', label: 'GPT-5.6 Sol 1M Low' },
            { id: 'gpt-5.6-sol-high', label: 'GPT-5.6 Sol 1M High' },
            { id: 'gpt-5.6-sol-xhigh', label: 'GPT-5.6 Sol 1M Extra High' },
            { id: 'grok-4.7-low', label: 'Grok 4.7 Low' },
            { id: 'grok-4.7-high', label: 'Grok 4.7 High' },
            { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash' },
            { id: 'kimi-k3-high', label: 'Kimi K3 High' },
            { id: 'claude-sonnet-5-5-high', label: 'Claude Sonnet 5.5 High' },
            { id: 'gpt-5.3-codex', label: 'Codex 5.3' },
            { id: 'gpt-5.3-codex-high', label: 'Codex 5.3 High' },
          ]),
        ),
      },
    }),
    fake('grok', 'Grok Build', 30, {
      vision: 'files',
      status: status('1.0.70', 'grok.com account'),
      models: {
        defaultModel: 'grok-4.7',
        models: [
          {
            id: 'grok-4.7',
            label: 'Grok 4.7',
            efforts: ['low', 'medium', 'high', 'xhigh'],
            maker: 'Grok',
          },
        ],
      },
    }),
    fake('local', 'Local models', 45, {
      status: status('0.32.14', '3 models on this computer · OpenCode 1.19.5 builds'),
      models: {
        defaultModel: 'gpt-oss:20b',
        models: [
          {
            id: 'gpt-oss:20b',
            label: 'GPT-OSS 20B',
            description: '20.9B · MXFP4 · uses tools',
            tags: ['14 GB', 'fits', '128k context'],
            maker: 'GPT',
          },
          {
            id: 'qwen2.5-coder:14b',
            label: 'Qwen2.5 Coder 14B',
            description: '14.8B · Q4_K_M · answers only',
            tags: ['9.0 GB', 'fits', '32k context'],
            maker: 'Qwen',
          },
          {
            id: 'llama3.2:1b',
            label: 'Llama 3.2 1B',
            description: '1.2B · Q8_0 · answers only',
            tags: ['1.3 GB', 'fits', '128k context'],
            maker: 'Llama',
          },
        ],
      },
    }),
  ];
}

/**
 * CONCLAVE_DEMO_FAIL=<channel,…> (or `*`): those calls from the window fail, so the tests can
 * check every action shows its failure. Read on every call, so a test can change it while the
 * app runs.
 */
export function demoFailure(channel: string): void {
  const fail = process.env.CONCLAVE_DEMO_FAIL?.split(',').map((c) => c.trim());
  if (fail?.includes(channel) || fail?.includes('*')) {
    throw new Error(`Demo failure: ${channel} was made to fail`);
  }
}

/** CONCLAVE_DEMO_DATA: `empty` (no AI installed, nothing yet) or `stress` (long, many, mixed). */
export const demoData = () => process.env.CONCLAVE_DEMO_DATA as 'empty' | 'stress' | undefined;

const LONG_WORD = 'Supercalifragilisticexpialidocious'.repeat(9);
const MIXED = [
  'Café menu with crème brûlée 🍮 and 日本語のメニュー',
  'تطبيق لإدارة المهام مع دعم الكتابة من اليمين إلى اليسار',
  '한국어 사용자 인터페이스와 이모지 지원 ✅🚀',
  'Kanban board with drag and drop, offline sync, conflict resolution and an export to CSV',
];

/**
 * CONCLAVE_DEMO_DATA=stress: 300 threads, a project with 60 tasks and an Inbox of 40, with
 * 80-character titles, a 300-character word, emoji, CJK and right-to-left text. Every screen
 * has to stay usable with it.
 */
export async function seedStress(store: Store, repo: string | undefined): Promise<void> {
  const title = (i: number) =>
    i % 7 === 0 ? LONG_WORD : `${MIXED[i % MIXED.length]} — part ${i + 1} of a much longer plan`;
  for (let i = 0; i < 300; i++) {
    const thread = store.createThread({
      title: title(i).slice(0, 200),
      provider: (['claude', 'codex', 'antigravity'] as const)[i % 3]!,
      mode: i % 5 === 0 ? 'council' : 'chat',
    });
    store.addMessage(thread.id, { role: 'user', content: `${title(i)}\n\n${LONG_WORD}` });
    store.addMessage(thread.id, {
      role: 'assistant',
      provider: thread.provider,
      content: `An answer with a long word: ${LONG_WORD}\n\n\`\`\`js\nconst x = '${LONG_WORD}';\n\`\`\``,
    });
  }
  if (!repo) return;
  const project = await createProject(
    store,
    [{ provider: 'claude' }, { provider: 'codex' }, { provider: 'antigravity' }],
    {
      repoPath: repo,
      name: `A project with a very long name that goes on and on ${LONG_WORD}`.slice(0, 120),
      goal: `${MIXED.join('. ')}. ${LONG_WORD}`,
      testCommand: 'node -e 0',
    },
  );
  const tasks = store.projects.addTasks(
    project.id,
    Array.from({ length: 60 }, (_, i) => ({
      title: title(i).slice(0, 80),
      spec: `${MIXED[i % MIXED.length]}\n\n${LONG_WORD}`,
    })),
  );
  tasks.forEach((t, i) => {
    if (i < 20) store.projects.updateTask(t.id, { status: 'merged' });
    else if (i < 25) store.projects.updateTask(t.id, { status: 'failed' });
  });
  for (let i = 0; i < 40; i++) {
    store.projects.requestApproval({
      projectId: project.id,
      taskId: tasks[25 + (i % 30)]!.id,
      kind: 'question',
      summary: title(i).slice(0, 120),
      payload: {
        question: `${title(i)}?`,
        why: LONG_WORD,
        options: [MIXED[0]!, MIXED[1]!, `${LONG_WORD.slice(0, 120)}`],
        recommended: MIXED[0],
        stage: 'build',
        provider: 'codex',
      },
    });
  }
  store.projects.setStatus(project.id, 'needs_you', '40 questions waiting for you');
}
