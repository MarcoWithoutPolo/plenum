import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CopilotAdapter,
  CopilotParser,
  CursorAdapter,
  GrokAdapter,
  collect,
  copilotArgs,
  copilotPermissionGap,
  cursorArgs,
  cursorPermissionGap,
  grokArgs,
  parseCursorModels,
  parseGrokModels,
  type Exec,
} from '../src/index.js';
import { fixturePath, replay } from './helpers.js';

const types = (events: { type: string }[]) => [...new Set(events.map((e) => e.type))];

describe('CursorAdapter (recorded cursor-agent 2026.10.22)', () => {
  it('turns a chat into session, streamed text, usage and done', async () => {
    const exec = replay('cursor/pong.jsonl');
    const result = await collect(new CursorAdapter({ exec }).run({ prompt: 'x', cwd: '.' }));
    expect(result.text).toBe('pong');
    expect(result.ok).toBe(true);
    expect(result.events.find((e) => e.type === 'session')).toMatchObject({ model: 'Auto' });
    // The partial pieces and the whole message that repeats them count once.
    expect(
      result.events
        .filter((e) => e.type === 'message.delta')
        .map((e) => e.text)
        .join(''),
    ).toBe('pong');
    expect(result.usage).toMatchObject({ inputTokens: expect.any(Number), outputTokens: 27 });
    expect(exec.calls[0]!.stdin).toBe('x');
  });

  it('reports the edits and the commands a builder tried', async () => {
    const result = await collect(
      new CursorAdapter({ exec: replay('cursor/edit.jsonl') }).run({
        prompt: 'x',
        cwd: '.',
        role: 'builder',
        readOnly: false,
      }),
    );
    expect(result.events).toContainEqual(
      expect.objectContaining({ type: 'file.edit', path: expect.stringMatching(/README\.md$/) }),
    );
    expect(result.events).toContainEqual(
      expect.objectContaining({ type: 'tool.call', tool: 'shell', input: { command: 'npm test' } }),
    );
  });

  it('asks read-only roles for ask mode, builds without --force at level 2, and trusts its folder', () => {
    expect(cursorArgs({ prompt: 'x', cwd: '.' })).toEqual(
      expect.arrayContaining(['--mode', 'ask', '--trust', '--model', 'auto']),
    );
    const build = cursorArgs({ prompt: 'x', cwd: '.', role: 'builder', readOnly: false });
    expect(build).not.toContain('--force');
    expect(build).not.toContain('--mode');
    const full = cursorArgs({
      prompt: 'x',
      cwd: '.',
      role: 'builder',
      readOnly: false,
      permissions: { level: 5, network: true },
    });
    expect(full).toContain('--force');
    expect(cursorPermissionGap({ level: 3, network: false, commands: ['npm test'] })).toMatch(
      /levels 1, 2 and 5/,
    );
  });

  it("groups its 270 model ids and finds the CLI's default", () => {
    const list = parseCursorModels(readFileSync(fixturePath('cursor/models.txt'), 'utf8'));
    expect(list.defaultModel).toBe('auto');
    expect(list.models.length).toBeLessThan(70);
    expect(list.models.find((m) => m.id === 'auto')?.label).toBe('Auto');
  });
});

describe('GrokAdapter (recorded grok 1.0.70, free account)', () => {
  it('turns a chat into text, usage, session and done', async () => {
    const result = await collect(
      new GrokAdapter({ exec: replay('grok/pong.jsonl') }).run({ prompt: 'x', cwd: '.' }),
    );
    expect(result.text).toBe('pong');
    expect(result.ok).toBe(true);
    expect(types(result.events)).toEqual(
      expect.arrayContaining(['message.delta', 'session', 'usage', 'message.done', 'done']),
    );
    // input_tokens leaves out cache reads; Plenum counts every input token.
    expect(result.usage!.inputTokens).toBeGreaterThan(result.usage!.cachedInputTokens!);
  });

  it('reports edits and denied commands from a build', async () => {
    const result = await collect(
      new GrokAdapter({ exec: replay('grok/edit.jsonl') }).run({
        prompt: 'x',
        cwd: '.',
        role: 'builder',
        readOnly: false,
      }),
    );
    expect(result.events).toContainEqual(
      expect.objectContaining({ type: 'file.edit', kind: 'update' }),
    );
    expect(result.events).toContainEqual(
      expect.objectContaining({ type: 'tool.call', tool: 'shell' }),
    );
  });

  it('writes the prompt to a file and sets its own allow and deny rules per level', () => {
    const read = grokArgs({ prompt: 'secret plan', cwd: '.' });
    try {
      const file = read.args[read.args.indexOf('--prompt-file') + 1]!;
      expect(readFileSync(file, 'utf8')).toBe('secret plan');
      expect(read.args.join(' ')).toContain('--deny write --deny search_replace');
      expect(read.args).not.toContain('--allow');
    } finally {
      read.cleanup();
    }
    const build = grokArgs({
      prompt: 'x',
      cwd: '.',
      role: 'builder',
      readOnly: false,
      effort: 'xhigh',
    });
    try {
      const line = build.args.join(' ');
      expect(line).toContain('--permission-mode dontAsk --allow write --allow search_replace');
      expect(line).toContain('--deny run_terminal_command --deny web_fetch');
      expect(line).toContain('--effort xhigh');
      expect(line).not.toContain('bypassPermissions');
    } finally {
      build.cleanup();
    }
  });

  it('lists the models a free account has', () => {
    const list = parseGrokModels(readFileSync(fixturePath('grok/models.txt'), 'utf8'));
    expect(list).toMatchObject({ defaultModel: 'grok-4.7', models: [{ id: 'grok-4.7' }] });
    expect(list.models[0]!.efforts).toEqual(['low', 'medium', 'high', 'xhigh']);
  });
});

describe('CopilotAdapter (recorded Copilot CLI 1.0.105, Copilot Free)', () => {
  it('turns a chat into text, session and done, and learns the models the plan allows', async () => {
    const result = await collect(
      new CopilotAdapter({ exec: replay('copilot/pong.jsonl') }).run({ prompt: 'x', cwd: '.' }),
    );
    expect(result.text).toBe('pong');
    expect(result.ok).toBe(true);
    expect(CopilotParser.availableModels.size).toBeGreaterThan(0);
    const models = await new CopilotAdapter({ home: fixturePath('copilot') }).models();
    expect(models.models[0]).toMatchObject({ id: 'auto', label: 'Auto' });
    expect(models.models.length).toBeGreaterThan(1);
  });

  it('reports the files a build changed', async () => {
    const result = await collect(
      new CopilotAdapter({ exec: replay('copilot/edit.jsonl') }).run({
        prompt: 'x',
        cwd: '.',
        role: 'builder',
        readOnly: false,
      }),
    );
    expect(result.events).toContainEqual(
      expect.objectContaining({ type: 'file.edit', path: expect.stringMatching(/README\.md$/) }),
    );
    expect(result.events).toContainEqual(
      expect.objectContaining({ type: 'tool.call', tool: 'shell', input: { command: 'npm test' } }),
    );
  });

  it('denies shell and URLs below level 5 and never uses --yolo', () => {
    const chat = copilotArgs({ prompt: 'x', cwd: '.' });
    expect(chat).toEqual(
      expect.arrayContaining(['--deny-tool=write', '--deny-tool=shell', '--deny-tool=url']),
    );
    const build = copilotArgs({ prompt: 'x', cwd: '.', role: 'builder', readOnly: false });
    expect(build).toEqual(expect.arrayContaining(['--allow-tool=write', '--deny-tool=shell']));
    const all = [
      chat,
      build,
      copilotArgs({
        prompt: 'x',
        cwd: '.',
        role: 'builder',
        readOnly: false,
        permissions: { level: 5, network: true },
      }),
    ].flat();
    expect(all).not.toContain('--yolo');
    expect(all).not.toContain('--autopilot');
    expect(copilotArgs({ prompt: 'x', cwd: '.', model: 'auto' })).not.toContain('--model');
    expect(copilotPermissionGap({ level: 4, network: false })).toMatch(/levels 1, 2 and 5/);
  });
});

// Scenario 21: none of the new AIs can be pushed to its limit on purpose, so their limit
// messages are simulated in each CLI's own event format. A usage limit hands the task off
// instead of failing it.
describe('usage limits from the new AIs', () => {
  const lines = (out: string[], code = 0, stderr = ''): Exec =>
    async function* () {
      for (const line of out) yield { kind: 'line' as const, line };
      if (stderr) yield { kind: 'stderr' as const, text: stderr };
      yield { kind: 'exit' as const, code };
    };

  it('Copilot: an exhausted monthly allowance', async () => {
    const result = await collect(
      new CopilotAdapter({
        exec: lines(
          [
            JSON.stringify({
              type: 'session.error',
              data: {
                message:
                  'You have reached your monthly limit of premium requests. Try again in 3 days.',
              },
            }),
          ],
          1,
        ),
      }).run({ prompt: 'x', cwd: '.' }),
    );
    expect(result.rateLimited?.message).toMatch(/monthly limit/);
    expect(result.rateLimited?.resetsAt).toBeGreaterThan(Date.now());
  });

  it('Grok Build: a rate limit', async () => {
    const result = await collect(
      new GrokAdapter({
        exec: lines(
          [
            JSON.stringify({
              type: 'error',
              message: 'Rate limit exceeded (429). Try again in 2 hours.',
            }),
          ],
          1,
        ),
      }).run({ prompt: 'x', cwd: '.' }),
    );
    expect(result.rateLimited).toBeDefined();
  });

  it('Cursor: a usage limit on stderr, with no result line', async () => {
    const result = await collect(
      new CursorAdapter({
        exec: lines(
          [],
          1,
          "You've hit your usage limit for this billing period. Upgrade or try again later.\n",
        ),
      }).run({ prompt: 'x', cwd: '.' }),
    );
    expect(result.rateLimited?.message).toMatch(/usage limit/);
  });
});
