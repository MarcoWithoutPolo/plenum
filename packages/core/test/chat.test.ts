import { describe, expect, it } from 'vitest';
import type { ProviderId } from '@plenum/shared';
import {
  ChatService,
  FakeAdapter,
  Store,
  adapterMap,
  buildChatPrompt,
  renderTranscript,
  type Adapter,
} from '../src/index.js';

function setup(adapters: Adapter[]) {
  const store = new Store(':memory:');
  const chat = new ChatService({ store, adapters: adapterMap(adapters), cwd: '.' });
  return { store, chat };
}

const fake = (id: ProviderId, reply: string, resume = true) =>
  new FakeAdapter({ reply }, { id, displayName: id, resume });

describe('ChatService', () => {
  it('sends a message, stores both sides and titles the thread', async () => {
    const claude = fake('claude', 'Hello!');
    const { store, chat } = setup([claude]);
    const thread = chat.createThread({ provider: 'claude', model: 'opus' });

    const { reply, thread: after } = await chat.send(thread.id, 'Say hello to me');

    expect(reply.content).toBe('Hello!');
    expect(reply.provider).toBe('claude');
    expect(after.title).toBe('Say hello to me');
    expect(claude.requests[0]).toMatchObject({
      prompt: 'Say hello to me',
      model: 'opus',
      role: 'chat',
      readOnly: true,
    });
    expect(store.listMessages(thread.id)).toHaveLength(2);
  });

  it('resumes the provider session and only sends the new message', async () => {
    const claude = fake('claude', 'ok');
    const { chat } = setup([claude]);
    const thread = chat.createThread({ provider: 'claude' });
    await chat.send(thread.id, 'first');
    await chat.send(thread.id, 'second');

    expect(claude.requests[1]?.prompt).toBe('second');
    expect(claude.requests[0]?.sessionId).toBeUndefined();
    expect(claude.requests[1]?.sessionId).toMatch(/^fake-\d+$/);
  });

  it('keeps context when switching provider mid-thread', async () => {
    const claude = fake('claude', 'The capital is Paris.');
    const codex = fake('codex', 'About 2.1 million people.');
    const { store, chat } = setup([claude, codex]);
    const thread = chat.createThread({ provider: 'claude' });

    await chat.send(thread.id, 'What is the capital of France?');
    const { thread: switched } = await chat.send(thread.id, 'How many people live there?', {
      provider: 'codex',
    });

    expect(switched.provider).toBe('codex');
    const prompt = codex.requests[0]!.prompt;
    expect(prompt).toContain('What is the capital of France?');
    expect(prompt).toContain('Claude (fake-1):\nThe capital is Paris.');
    expect(prompt.trimEnd().endsWith('How many people live there?')).toBe(true);
    expect(codex.requests[0]!.sessionId).toBeUndefined();

    // Back to Claude: it resumes its own session and only hears what it missed.
    await chat.send(thread.id, 'Thanks!', { provider: 'claude' });
    const back = claude.requests[1]!;
    expect(back.sessionId).toBeTruthy();
    expect(back.prompt).toContain('Codex (fake-1):\nAbout 2.1 million people.');
    expect(back.prompt).not.toContain('What is the capital of France?');
    expect(store.listMessages(thread.id)).toHaveLength(6);
  });

  it('keeps the chosen effort for later messages until changed', async () => {
    const codex = fake('codex', 'ok');
    const { store, chat } = setup([codex]);
    const thread = chat.createThread({ provider: 'codex', effort: 'low' });
    await chat.send(thread.id, 'one');
    await chat.send(thread.id, 'two');
    await chat.send(thread.id, 'three', { effort: null });
    expect(codex.requests.map((r) => r.effort)).toEqual(['low', 'low', undefined]);
    expect(store.getThread(thread.id)?.effort).toBeNull();
    expect(
      store
        .listMessages(thread.id)
        .filter((m) => m.role === 'assistant')
        .map((m) => m.effort),
    ).toEqual(['low', 'low', null]);
  });

  it('stores failures with the error instead of throwing', async () => {
    const claude = new FakeAdapter({ reply: '', fail: 'boom' }, { id: 'claude' });
    const { chat } = setup([claude]);
    const thread = chat.createThread({ provider: 'claude' });
    const { reply } = await chat.send(thread.id, 'hi');
    expect(reply.ok).toBe(false);
    expect(reply.error).toBe('boom');
  });

  it('records quota and rate-limit readings', async () => {
    const claude = new FakeAdapter(
      { reply: '', rateLimited: { message: 'limit hit', resetsAt: 99 } },
      { id: 'claude' },
    );
    const { store, chat } = setup([claude]);
    const thread = chat.createThread({ provider: 'claude' });
    const { reply } = await chat.send(thread.id, 'hi');
    expect(reply.error).toBe('limit hit');
    expect(store.listQuotas()).toEqual([
      expect.objectContaining({ provider: 'claude', window: 'limit', resetsAt: 99 }),
    ]);
  });

  it('rejects unknown threads and providers', async () => {
    const { chat } = setup([fake('claude', 'x')]);
    await expect(chat.send('t_missing', 'hi')).rejects.toThrow(/No such thread/);
    const thread = chat.createThread({ provider: 'claude' });
    await expect(chat.send(thread.id, 'hi', { provider: 'gemini' })).rejects.toThrow(
      /not available/,
    );
  });
});

describe('transcripts', () => {
  it('drops the oldest turns when too long', () => {
    const store = new Store(':memory:');
    const t = store.createThread({ provider: 'claude' });
    for (let i = 0; i < 10; i++)
      store.addMessage(t.id, { role: 'user', content: `msg ${i} ${'x'.repeat(100)}` });
    const text = renderTranscript(store.listMessages(t.id), 350);
    expect(text).toMatch(/^\[\d+ earlier messages omitted\]/);
    expect(text).toContain('msg 9');
    expect(text).not.toContain('msg 0');
  });

  it('sends the bare message when there is no history', () => {
    expect(buildChatPrompt([], 'hello')).toBe('hello');
  });
});

describe('Resuming a chat that fails (E14)', () => {
  const run = async (fail: string) => {
    let calls = 0;
    const claude = new FakeAdapter(
      {
        reply: 'Hi',
        failWhen: (req) => (req.sessionId && ++calls > 0 ? fail : undefined),
      },
      { id: 'claude', resume: true },
    );
    const { store, chat } = setup([claude]);
    const thread = chat.createThread({ provider: 'claude' });
    await chat.send(thread.id, 'one', { provider: 'claude' });
    const before = store.usage.runsSince('claude', 0);
    await chat.send(thread.id, 'two', { provider: 'claude' });
    return { requests: claude.requests.length, runs: store.usage.runsSince('claude', 0) - before };
  };

  it('a refused resume is retried once without it, and both runs count', async () => {
    const r = await run('No conversation found with session ID abc');
    expect(r.requests).toBe(3);
    expect(r.runs).toBe(2);
  });

  it('a timeout is not retried (it would cost the same again)', async () => {
    const r = await run('Timed out after 600000 ms');
    expect(r.requests).toBe(2);
    expect(r.runs).toBe(1);
  });
});
