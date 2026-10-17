import { describe, expect, it } from 'vitest';
import { AgentEvent } from '@conclave/shared';
import { CodexAdapter, CodexParser, codexArgs, collect } from '../src/index.js';
import { replay } from './helpers.js';

describe('CodexAdapter (recorded codex-cli 0.163 output)', () => {
  it('turns a run into session, text, usage and done events', async () => {
    const exec = replay('codex/pong.jsonl');
    const result = await collect(
      new CodexAdapter({ exec }).run({ prompt: 'Reply with: pong', cwd: '.' }),
    );

    expect(result.ok).toBe(true);
    expect(result.text).toBe('pong');
    expect(result.sessionId).toBe('01a14c04-fafb-72d3-b9a9-d3ab6e1e34de');
    expect(result.usage).toEqual({ inputTokens: 16002, cachedInputTokens: 7296, outputTokens: 5 });
    for (const event of result.events) expect(AgentEvent.safeParse(event).success).toBe(true);
    expect(exec.calls[0]?.stdin).toBe('Reply with: pong');
  });

  it('reports one readable error for a failed turn', async () => {
    const result = await collect(
      new CodexAdapter({ exec: replay('codex/unknown-model.jsonl', 1) }).run({
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

  it('lets builders write to the workspace and resumes sessions', () => {
    expect(codexArgs({ prompt: 'x', cwd: '.', readOnly: false })).toContain('workspace-write');
    expect(
      codexArgs({ prompt: 'x', cwd: '.', sessionId: 'abc', model: 'gpt-x' }).slice(0, 3),
    ).toEqual(['exec', 'resume', 'abc']);
  });
});
