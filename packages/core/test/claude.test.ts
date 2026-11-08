import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AgentEvent } from '@plenum/shared';
import { ClaudeAdapter, claudeArgs, collect, parseClaudeModels } from '../src/index.js';
import { fixturePath, replay } from './helpers.js';

describe('ClaudeAdapter (recorded Claude Code 2.1 output)', () => {
  it('turns a chat run into session, text, usage, quota and done events', async () => {
    const exec = replay('claude/chat-pong.jsonl');
    const adapter = new ClaudeAdapter({ exec });
    const result = await collect(adapter.run({ prompt: 'Reply with: pong', cwd: '.' }));

    expect(result.ok).toBe(true);
    expect(result.text).toBe('pong');
    expect(result.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.model).toBe('claude-haiku-5-5');
    expect(result.usage.costUsd).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
    expect(result.quotas.map((q) => q.window).sort()).toEqual(['five_hour', 'seven_day']);
    expect(result.quotas[0]?.resetsAt).toBeGreaterThan(1e12); // converted to epoch ms
    expect(result.rateLimited).toBeUndefined();
    for (const event of result.events) expect(AgentEvent.safeParse(event).success).toBe(true);
    expect(exec.calls[0]?.stdin).toBe('Reply with: pong');
  });

  it('reports tool calls and uses the final result as the answer', async () => {
    const adapter = new ClaudeAdapter({ exec: replay('claude/plan-mode-pong.jsonl') });
    const result = await collect(adapter.run({ prompt: 'x', cwd: '.' }));

    expect(result.ok).toBe(true);
    expect(result.text).toBe('pong');
    expect(
      result.events
        .filter((e) => e.type === 'tool.call')
        .map((e) => e.type === 'tool.call' && e.tool),
    ).toEqual(['ExitPlanMode']);
    // Streamed deltas are not repeated from the matching assistant messages.
    const deltas = result.events.filter((e) => e.type === 'message.delta');
    expect(deltas).toHaveLength(2);
  });

  it('fails cleanly on an unknown model', async () => {
    const adapter = new ClaudeAdapter({ exec: replay('claude/unknown-model.jsonl', 1) });
    const result = await collect(adapter.run({ prompt: 'x', cwd: '.' }));

    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/issue with the selected model/);
  });

  it('reports a missing CLI or crash from stderr when the stream says nothing', async () => {
    const exec = async function* () {
      yield { kind: 'stderr' as const, text: 'boom\nsomething went wrong\n' };
      yield { kind: 'exit' as const, code: 2 };
    };
    const result = await collect(new ClaudeAdapter({ exec }).run({ prompt: 'x', cwd: '.' }));
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(['something went wrong']);
  });
});

describe('claudeArgs', () => {
  it('runs chat with no tools and no MCP servers', () => {
    const args = claudeArgs({ prompt: 'x', cwd: '.', model: 'opus' });
    expect(args).toEqual(expect.arrayContaining(['-p', '--strict-mcp-config', '--model', 'opus']));
    expect(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2)).toEqual([
      '--tools',
      '',
    ]);
  });

  it('passes the reasoning effort', () => {
    expect(claudeArgs({ prompt: 'x', cwd: '.', effort: 'low' })).toEqual(
      expect.arrayContaining(['--effort', 'low']),
    );
    expect(claudeArgs({ prompt: 'x', cwd: '.' })).not.toContain('--effort');
  });

  it('limits read-only agents to read tools', () => {
    const args = claudeArgs({ prompt: 'x', cwd: '.', role: 'reviewer', readOnly: true });
    expect(args).toEqual(
      expect.arrayContaining(['--tools', 'Read,Grep,Glob', '--permission-mode', 'dontAsk']),
    );
  });

  it('lets builders edit files', () => {
    const args = claudeArgs({ prompt: 'x', cwd: '.', role: 'builder', readOnly: false });
    expect(args).toEqual(expect.arrayContaining(['--permission-mode', 'acceptEdits']));
    expect(args).not.toContain('--tools');
  });

  it('resumes sessions and rejects unsafe values', () => {
    expect(claudeArgs({ prompt: 'x', cwd: '.', sessionId: 'abc-123' })).toEqual(
      expect.arrayContaining(['--resume', 'abc-123']),
    );
    expect(() => claudeArgs({ prompt: 'x', cwd: '.', model: 'opus && calc' })).toThrow(
      /Invalid model/,
    );
    expect(() => claudeArgs({ prompt: 'x', cwd: '.', sessionId: 'a b' })).toThrow(
      /Invalid session/,
    );
  });
});

describe('claudeArgs with screenshots', () => {
  it('lets the reviewer read the screenshot folders, and refuses anything but PNGs', () => {
    const dir = process.platform === 'win32' ? 'C:\\shots\\n_1' : '/shots/n_1';
    const sep = process.platform === 'win32' ? '\\' : '/';
    const args = claudeArgs({
      prompt: 'x',
      cwd: '.',
      role: 'reviewer',
      readOnly: true,
      images: [`${dir}${sep}home-phone-dark.png`, `${dir}${sep}home-desktop-light.png`],
    });
    expect(args.filter((_a, i) => args[i - 1] === '--add-dir')).toEqual([dir]);
    expect(() => claudeArgs({ prompt: 'x', cwd: '.', images: ['relative.png'] })).toThrow(
      /Not a screenshot/,
    );
    expect(() => claudeArgs({ prompt: 'x', cwd: '.', images: [`${dir}${sep}notes.txt`] })).toThrow(
      /Not a screenshot/,
    );
  });
});

describe('Claude model list', () => {
  it('reads every model from the start-up handshake, with efforts and the default', () => {
    const recorded = JSON.parse(readFileSync(fixturePath('claude/initialize-models.json'), 'utf8'));
    const list = parseClaudeModels(recorded);
    expect(list.defaultModel).toBe('opus');
    const ids = list.models.map((m) => m.id);
    expect(ids).toEqual(expect.arrayContaining(['opus', 'fable', 'sonnet', 'haiku']));
    expect(ids).not.toContain('default');
    expect(list.models.find((m) => m.id === 'opus')).toMatchObject({
      label: 'Opus 5.5',
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    });
    // Pinned earlier versions fold under "Older models".
    expect(list.models.find((m) => m.id === 'claude-opus-4-8')?.older).toBe(true);
    expect(list.models.find((m) => m.id === 'opus')?.older).toBeUndefined();
  });
});
