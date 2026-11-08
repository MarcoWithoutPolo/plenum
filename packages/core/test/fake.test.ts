import { describe, expect, it } from 'vitest';
import { AgentEvent } from '@plenum/shared';
import { FakeAdapter, collect } from '../src/index.js';

describe('FakeAdapter', () => {
  it('streams a reply that collect() reassembles', async () => {
    const adapter = new FakeAdapter({ reply: 'hello from the fake model' });
    const seen: string[] = [];
    const result = await collect(adapter.run({ prompt: 'hi', cwd: '.' }), (e) => seen.push(e.type));

    expect(result.ok).toBe(true);
    expect(result.text).toBe('hello from the fake model');
    expect(result.usage.outputTokens).toBe(25);
    expect(seen[0]).toBe('session');
    expect(seen.at(-1)).toBe('done');
  });

  it('emits events that match the shared schema', async () => {
    const adapter = new FakeAdapter({ reply: 'ok' });
    for await (const event of adapter.run({ prompt: 'x', cwd: '.' })) {
      expect(AgentEvent.safeParse(event).success).toBe(true);
    }
  });

  it('reports rate limits instead of answering', async () => {
    const adapter = new FakeAdapter({
      reply: 'unused',
      rateLimited: { message: 'limit', resetsAt: 123 },
    });
    const result = await collect(adapter.run({ prompt: 'x', cwd: '.' }));
    expect(result.ok).toBe(false);
    expect(result.rateLimited).toEqual({ message: 'limit', resetsAt: 123 });
  });

  it('stops when cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const adapter = new FakeAdapter({ reply: 'a b c' });
    const result = await collect(adapter.run({ prompt: 'x', cwd: '.', signal: controller.signal }));
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('Cancelled');
  });
});
