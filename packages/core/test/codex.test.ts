import { describe, expect, it } from 'vitest';
import { AgentEvent } from '@conclave/shared';
import {
  CodexAdapter,
  CodexParser,
  codexArgs,
  collect,
  limitResetsAt,
  parseCodexModels,
} from '../src/index.js';
import { fixturePath, replay } from './helpers.js';

const home = fixturePath('codex/home');

describe('CodexAdapter (recorded codex-cli 0.163 output)', () => {
  it('turns a run into session, text, usage and done events', async () => {
    const exec = replay('codex/pong.jsonl');
    const result = await collect(
      new CodexAdapter({ exec, home }).run({ prompt: 'Reply with: pong', cwd: '.' }),
    );

    expect(result.ok).toBe(true);
    expect(result.text).toBe('pong');
    expect(result.sessionId).toBe('01a14c04-fafb-72d3-b9a9-d3ab6e1e34de');
    expect(result.usage).toEqual({ inputTokens: 16002, cachedInputTokens: 7296, outputTokens: 5 });
    for (const event of result.events) expect(AgentEvent.safeParse(event).success).toBe(true);
    expect(exec.calls[0]?.stdin).toBe('Reply with: pong');
    // Plan usage comes from the session log Codex wrote for this thread.
    expect(result.quotas).toEqual([
      { window: 'five_hour', utilization: 0.14, resetsAt: 1792294764000 },
      { window: 'seven_day', utilization: 0.02, resetsAt: 1792881564000 },
    ]);
  });

  it('lists the models the plan offers, best first, with the configured default', async () => {
    expect(await new CodexAdapter({ home }).models()).toEqual({
      models: [
        {
          id: 'gpt-a',
          label: 'GPT-A',
          description: 'Fast everyday model.',
          efforts: ['low'],
          defaultEffort: 'low',
          maker: 'GPT',
        },
        {
          id: 'gpt-b',
          label: 'GPT-B',
          efforts: ['low', 'medium'],
          defaultEffort: 'medium',
          maker: 'GPT',
        },
      ],
      defaultModel: 'gpt-a',
      defaultEffort: 'ultra',
    });
  });

  it('reads current limits without running anything', async () => {
    expect(await new CodexAdapter({ home }).limits()).toHaveLength(2);
    expect(await new CodexAdapter({ home: fixturePath('codex/missing') }).limits()).toEqual([]);
  });

  it('reports one readable error for a failed turn', async () => {
    const result = await collect(
      new CodexAdapter({ exec: replay('codex/unknown-model.jsonl', 1), home }).run({
        prompt: 'x',
        cwd: '.',
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      "The 'not-a-model' model is not supported when using Codex with a ChatGPT account.",
    ]);
  });

  it('maps usage-limit errors to rate_limit', () => {
    const parser = new CodexParser();
    const events = parser.parse({
      type: 'error',
      message: JSON.stringify({ status: 429, error: { message: "You've hit your usage limit." } }),
    });
    expect(events).toEqual([{ type: 'rate_limit', message: "You've hit your usage limit." }]);
  });

  it('treats a workspace spend cap as a usage limit, not a task failure', () => {
    // Seen live: Codex refused with this when a ChatGPT workspace hit its spend cap.
    const parser = new CodexParser();
    const message =
      'You hit your spend cap set by the owner of your workspace. Ask an owner to increase your spend cap to continue.';
    expect(parser.parse({ type: 'error', message })).toEqual([{ type: 'rate_limit', message }]);
  });

  it('reports shell commands and file changes', () => {
    const parser = new CodexParser();
    expect(
      parser.parse({
        type: 'item.completed',
        item: { type: 'command_execution', command: 'npm test' },
      }),
    ).toEqual([{ type: 'tool.call', tool: 'shell', input: { command: 'npm test' } }]);
    expect(
      parser.parse({
        type: 'item.completed',
        item: {
          type: 'file_change',
          changes: [
            { path: 'a.ts', kind: 'add' },
            { path: 'b.ts', kind: 'update' },
          ],
        },
      }),
    ).toEqual([
      { type: 'file.edit', path: 'a.ts', kind: 'add' },
      { type: 'file.edit', path: 'b.ts', kind: 'update' },
    ]);
  });
});

describe('codexArgs', () => {
  it('reads the prompt from stdin in a read-only sandbox by default', () => {
    expect(codexArgs({ prompt: 'x', cwd: '.' })).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--color',
      'never',
      '--sandbox',
      'read-only',
      '-',
    ]);
  });

  it('sets reasoning effort through a config override', () => {
    const args = codexArgs({ prompt: 'x', cwd: '.', model: 'gpt-a', effort: 'low' });
    expect(args.slice(-3)).toEqual(['-c', 'model_reasoning_effort=low', '-']);
    expect(() => codexArgs({ prompt: 'x', cwd: '.', effort: 'low"; rm' })).toThrow(
      /Invalid effort/,
    );
  });

  it('lets builders write to the workspace and resumes sessions', () => {
    expect(codexArgs({ prompt: 'x', cwd: '.', readOnly: false })).toContain('workspace-write');
    expect(
      codexArgs({ prompt: 'x', cwd: '.', sessionId: 'abc', model: 'gpt-x' }).slice(0, 3),
    ).toEqual(['exec', 'resume', 'abc']);
  });
});

describe('codexArgs with screenshots', () => {
  it('attaches each image before the other flags, and not on a resumed session', () => {
    const png = process.platform === 'win32' ? 'C:\\shots\\a.png' : '/shots/a.png';
    const args = codexArgs({
      prompt: 'x',
      cwd: '.',
      role: 'reviewer',
      readOnly: true,
      images: [png],
    });
    expect(args.slice(0, 3)).toEqual(['exec', '--image', png]);
    expect(args.at(-1)).toBe('-');
    expect(codexArgs({ prompt: 'x', cwd: '.', sessionId: 'abc', images: [png] })).not.toContain(
      '--image',
    );
  });
});

describe('limitResetsAt', () => {
  const now = new Date(2026, 9, 25, 2, 30);
  const at = (h: number, m: number, day = 25) => new Date(2026, 9, day, h, m).getTime();

  it("reads the reset time from Codex's limit message", () => {
    const message =
      'You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 5:48 AM.';
    expect(limitResetsAt(message, now)).toBe(at(5, 48));
    // A time already past today means tomorrow.
    expect(limitResetsAt('try again at 1:15 AM', now)).toBe(at(1, 15, 26));
    expect(limitResetsAt('try again at 12:05 PM', now)).toBe(at(12, 5));
    expect(limitResetsAt('try again at 12:05 am', now)).toBe(at(0, 5, 26));
    expect(limitResetsAt('Try again at 17:30.', now)).toBe(at(17, 30));
  });

  it('reads "in N hours M minutes", and nothing from other messages', () => {
    expect(limitResetsAt('try again in 2 hours 13 minutes', now)).toBe(at(4, 43));
    expect(limitResetsAt('Please try again in 45m', now)).toBe(at(3, 15));
    expect(limitResetsAt('usage limit reached', now)).toBeUndefined();
    expect(limitResetsAt('try again at 25:00', now)).toBeUndefined();
    expect(limitResetsAt('try again at 13:00 PM', now)).toBeUndefined();
  });

  it('puts the reset time on the limit event', () => {
    const parser = new CodexParser();
    const events = parser.parse({
      type: 'error',
      message: 'You’ve hit your usage limit. Try again at 5:48 AM.',
    });
    expect(events).toEqual([
      expect.objectContaining({ type: 'rate_limit', resetsAt: expect.any(Number) }),
    ]);
  });
});

describe('Codex model list', () => {
  it("keeps Codex's description of each reasoning level", () => {
    const [model] = parseCodexModels(
      JSON.stringify({
        models: [
          {
            slug: 'gpt-x',
            supported_reasoning_levels: [
              { effort: 'low', description: 'Fast responses with lighter reasoning' },
              { effort: 'ultra' },
            ],
          },
        ],
      }),
    );
    expect(model).toMatchObject({
      efforts: ['low', 'ultra'],
      effortNotes: { low: 'Fast responses with lighter reasoning' },
    });
  });
});
