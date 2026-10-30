import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AgentEvent } from '@conclave/shared';
import { AntigravityAdapter, antigravityArgs, collect, parseModels } from '../src/index.js';
import { fixturePath, replay } from './helpers.js';

describe('AntigravityAdapter (recorded agy 1.4.6 output)', () => {
  it('turns a run into session, text, usage and done events', async () => {
    const exec = replay('antigravity/pong.jsonl');
    const result = await collect(
      new AntigravityAdapter({ exec, command: 'agy' }).run({
        prompt: 'Reply with: pong',
        cwd: '.',
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.text).toBe('pong');
    expect(result.sessionId).toBe('ede958a9-203e-447f-9b6f-d4bbbeaadb68');
    expect(result.usage).toEqual({ inputTokens: 6881, cachedInputTokens: 0, outputTokens: 1 });
    for (const e of result.events) expect(AgentEvent.safeParse(e).success).toBe(true);
    // The prompt rides on --print, because agy has no stdin prompt in print mode.
    expect(exec.calls[0]?.args[0]).toBe('--print=Reply with: pong');
    expect(exec.calls[0]?.stdin).toBeUndefined();
  });

  it('reports file edits and the command the headless sandbox denied', async () => {
    const result = await collect(
      new AntigravityAdapter({
        exec: replay('antigravity/edit-and-denied-command.jsonl'),
        command: 'agy',
      }).run({
        prompt: 'x',
        cwd: '.',
        role: 'builder',
        readOnly: false,
      }),
    );
    expect(result.ok).toBe(true);
    const tools = result.events.flatMap((e) => (e.type === 'tool.call' ? [e.tool] : []));
    expect(tools).toEqual(['write_file', 'shell']); // each tool step reported once
    const edits = result.events.flatMap((e) => (e.type === 'file.edit' ? [e.path] : []));
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatch(/hello\.js$/);
  });

  it('fails readably on an unknown model and an empty prompt', async () => {
    const bad = await collect(
      new AntigravityAdapter({
        exec: replay('antigravity/unknown-model.jsonl', 1),
        command: 'agy',
      }).run({ prompt: 'x', cwd: '.' }),
    );
    expect(bad.ok).toBe(false);
    expect(bad.errors).toEqual([expect.stringContaining('not recognized as a known model')]);
    const empty = await collect(
      new AntigravityAdapter({
        exec: replay('antigravity/empty-prompt.jsonl', 1),
        command: 'agy',
      }).run({ prompt: 'x', cwd: '.' }),
    );
    expect(empty.errors[0]).toContain('empty prompt');
  });

  it('reads the model list', () => {
    const models = parseModels(readFileSync(fixturePath('antigravity/models.txt'), 'utf8'));
    expect(models[0]).toEqual({ id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' });
    expect(models.map((m) => m.id)).toContain('claude-opus-4-6-thinking');
  });
});

describe('antigravityArgs', () => {
  it('plans for read-only roles and accepts edits for builders', () => {
    const mode = (role: 'chat' | 'builder' | 'reviewer', readOnly: boolean) => {
      const { args } = antigravityArgs({ prompt: 'x', cwd: '.', role, readOnly });
      return args[args.indexOf('--mode') + 1];
    };
    expect(mode('chat', true)).toBe('plan');
    expect(mode('reviewer', true)).toBe('plan');
    expect(mode('builder', false)).toBe('accept-edits');
  });

  it('passes model and resume; the effort is the model id, never a flag', () => {
    const { args } = antigravityArgs({
      prompt: 'x',
      cwd: '.',
      model: 'gemini-3.8-flash-low',
      // A seat saved before v0.9 may still carry one; its default model rejects xhigh and max.
      effort: 'xhigh',
      sessionId: 'abc-1',
    });
    expect(args).toEqual(
      expect.arrayContaining(['--model', 'gemini-3.8-flash-low', '--conversation', 'abc-1']),
    );
    expect(args).not.toContain('--effort');
  });

  it('moves very long prompts into a file the agent can read, and cleans it up', () => {
    const long = 'x'.repeat(30_000);
    const { args, cleanup } = antigravityArgs({ prompt: long, cwd: '.' });
    expect(args[0]!.length).toBeLessThan(500);
    const dir = args[args.indexOf('--add-dir') + 1]!;
    const file = /instructions are in the file (.+instructions\.md)/.exec(args[0]!)?.[1];
    expect(file && readFileSync(file, 'utf8')).toBe(long);
    cleanup();
    expect(() => readFileSync(file!, 'utf8')).toThrow();
    expect(dir).toBeTruthy();
  });
});

describe('Antigravity and shell commands', () => {
  it('reports a turn that died on a denied command as an error, not an empty success', async () => {
    const result = await collect(
      new AntigravityAdapter({
        exec: replay('antigravity/denied-command.jsonl'),
        command: 'agy',
      }).run({ prompt: 'x', cwd: '.', role: 'reviewer' }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('it tried to run `git status`, which headless mode denies');
  });

  it('keeps --mode working and tells agents there is no shell, except in chat and at level 5', () => {
    const builder = antigravityArgs({
      prompt: 'Build it',
      cwd: '.',
      role: 'builder',
      readOnly: false,
    });
    expect(builder.args).not.toContain('--disable-slash-commands');
    expect(builder.args[0]).toMatch(/^--print=IMPORTANT: This session has no shell/);
    expect(builder.args[0]).toContain('Build it');
    const chat = antigravityArgs({ prompt: 'hi', cwd: '.', role: 'chat' });
    expect(chat.args[0]).toBe('--print=hi');
    const full = antigravityArgs({
      prompt: 'Build it',
      cwd: '.',
      role: 'builder',
      readOnly: false,
      permissions: { level: 5, network: true },
    });
    expect(full.args[0]).toBe('--print=Build it');
    expect(antigravityArgs({ prompt: '/help', cwd: '.', role: 'chat' }).args[0]).toBe(
      '--print=Request: /help',
    );
  });
});

describe('antigravityArgs with screenshots', () => {
  it('lets the reviewer read the screenshot folders, and refuses anything but PNGs', () => {
    const dir = process.platform === 'win32' ? 'C:\\shots\\n_1' : '/shots/n_1';
    const sep = process.platform === 'win32' ? '\\' : '/';
    const { args } = antigravityArgs({
      prompt: 'x',
      cwd: '.',
      role: 'reviewer',
      readOnly: true,
      images: [`${dir}${sep}home-phone-dark.png`, `${dir}${sep}home-desktop-light.png`],
    });
    expect(args.filter((_a, i) => args[i - 1] === '--add-dir')).toEqual([dir]);
    expect(() => antigravityArgs({ prompt: 'x', cwd: '.', images: ['relative.png'] })).toThrow(
      /Not a screenshot/,
    );
    expect(new AntigravityAdapter().capabilities.vision).toBe('files');
  });
});
