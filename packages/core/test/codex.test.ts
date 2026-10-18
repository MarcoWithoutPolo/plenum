import { describe, expect, it } from 'vitest';
import { AgentEvent } from '@conclave/shared';
import { CodexAdapter, CodexParser, codexArgs, collect } from '../src/index.js';
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
        },
        { id: 'gpt-b', label: 'GPT-B', efforts: ['low', 'medium'], defaultEffort: 'medium' },
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
