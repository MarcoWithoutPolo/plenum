import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, Store, openDatabase } from '../src/index.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('Store', () => {
  it('creates threads and keeps messages in order', () => {
    const store = new Store(':memory:');
    const t = store.createThread({ provider: 'claude', model: 'opus' });
    store.addMessage(t.id, { role: 'user', content: 'hi' });
    store.addMessage(t.id, {
      role: 'assistant',
      provider: 'claude',
      content: 'hello',
      usage: { outputTokens: 3 },
    });

    const messages = store.listMessages(t.id);
    expect(messages.map((m) => [m.seq, m.role, m.content])).toEqual([
      [1, 'user', 'hi'],
      [2, 'assistant', 'hello'],
    ]);
    expect(messages[1]?.usage).toEqual({ outputTokens: 3 });
    expect(store.listThreads()[0]?.id).toBe(t.id);
  });

  it('finds threads by unique id prefix', () => {
    const store = new Store(':memory:');
    const t = store.createThread({ provider: 'codex' });
    expect(store.findThread(t.id.slice(0, 12))?.id).toBe(t.id);
    expect(store.findThread('nope')).toBeUndefined();
  });

  it('tracks provider sessions and quota readings', () => {
    const store = new Store(':memory:');
    const t = store.createThread({ provider: 'claude' });
    store.setProviderSession(t.id, 'claude', 's1', 2);
    store.setProviderSession(t.id, 'claude', 's2', 4);
    expect(store.getProviderSession(t.id, 'claude')).toEqual({ sessionId: 's2', lastSeq: 4 });
    expect(store.getProviderSession(t.id, 'codex')).toBeUndefined();

    store.recordQuota({
      provider: 'claude',
      window: 'five_hour',
      utilization: 0.2,
      resetsAt: 1,
      at: 1,
    });
    store.recordQuota({
      provider: 'claude',
      window: 'five_hour',
      utilization: 0.3,
      resetsAt: 2,
      at: 2,
    });
    expect(store.listQuotas()).toEqual([
      { provider: 'claude', window: 'five_hour', utilization: 0.3, resetsAt: 2, at: 2 },
    ]);
  });

  it('deletes a thread with its messages', () => {
    const store = new Store(':memory:');
    const t = store.createThread({ provider: 'claude' });
    store.addMessage(t.id, { role: 'user', content: 'x' });
    expect(store.deleteThread(t.id)).toBe(true);
    expect(store.listMessages(t.id)).toEqual([]);
  });

  it('stores the reasoning effort on threads and messages', () => {
    const store = new Store(':memory:');
    const t = store.createThread({ provider: 'codex', model: 'gpt-a', effort: 'low' });
    expect(store.getThread(t.id)?.effort).toBe('low');
    store.updateThread(t.id, { effort: null });
    expect(store.getThread(t.id)?.effort).toBeNull();
    store.addMessage(t.id, { role: 'assistant', provider: 'codex', effort: 'high', content: 'x' });
    expect(store.listMessages(t.id)[0]?.effort).toBe('high');
  });

  it('persists to disk and reopens at the same schema version', () => {
    const dir = mkdtempSync(join(tmpdir(), 'conclave-'));
    dirs.push(dir);
    const path = join(dir, 'c.db');
    const first = new Store(path);
    const t = first.createThread({ provider: 'claude' });
    first.close();

    const db = openDatabase(path);
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(
      SCHEMA_VERSION,
    );
    const second = new Store(db);
    expect(second.getThread(t.id)?.provider).toBe('claude');
    second.close();
  });
});
