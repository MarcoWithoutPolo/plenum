import { describe, expect, it } from 'vitest';
import { Engine, FakeAdapter, Store, parseSeat } from '../src/index.js';

describe('parseSeat', () => {
  it('reads provider and optional model', () => {
    expect(parseSeat('claude')).toEqual({ provider: 'claude' });
    expect(parseSeat(' codex:gpt-x ')).toEqual({ provider: 'codex', model: 'gpt-x' });
    expect(parseSeat('claude:us.anthropic:opus')).toEqual({
      provider: 'claude',
      model: 'us.anthropic:opus',
    });
  });

  it('rejects unknown providers', () => {
    expect(() => parseSeat('chatgpt')).toThrow(/Unknown provider "chatgpt"/);
  });
});

describe('Engine', () => {
  it('wires chat and council over one store and lists ready seats', async () => {
    const engine = new Engine({
      home: '.',
      store: new Store(':memory:'),
      adapters: [
        new FakeAdapter({ reply: 'one' }, { id: 'claude' }),
        new FakeAdapter({ reply: 'two' }, { id: 'codex' }),
      ],
    });
    expect(await engine.readySeats()).toEqual([{ provider: 'claude' }, { provider: 'codex' }]);

    const thread = engine.chat.createThread({ provider: 'claude' });
    await engine.chat.send(thread.id, 'hi');
    const council = await engine.council.ask('q', { members: await engine.readySeats() });
    expect(
      engine.store
        .listThreads()
        .map((t) => t.mode)
        .sort(),
    ).toEqual(['chat', 'council']);
    expect(council.mergedBy).toBe('synthesizer');
    engine.close();
  });
});
