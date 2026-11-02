import { describe, expect, it } from 'vitest';
import { Engine, FakeAdapter, resolveSeat, Store } from '../src/index.js';
import { openDatabase } from '../src/store/db.js';

/** v1.0 F2 (default models) and E12 (one bad setting never resets the rest). */

const engine = () =>
  new Engine({
    store: new Store(':memory:'),
    home: process.cwd(),
    adapters: [
      new FakeAdapter({ reply: 'Claude here' }, { id: 'claude' }),
      new FakeAdapter({ reply: 'Codex here' }, { id: 'codex' }),
    ],
  });

describe('Default models (F2)', () => {
  it('fills a seat left on Default and keeps what a seat names', () => {
    const e = engine();
    e.store.settings.update({
      defaults: { providers: { codex: { model: 'gpt-6-luna', effort: 'low' } } },
    });
    const s = e.store.settings;
    expect(resolveSeat({ provider: 'codex' }, s)).toEqual({
      provider: 'codex',
      model: 'gpt-6-luna',
      effort: 'low',
    });
    expect(resolveSeat({ provider: 'codex', model: 'gpt-6-astra' }, s)).toEqual({
      provider: 'codex',
      model: 'gpt-6-astra',
      effort: 'low',
    });
    // No default for Claude: the CLI's own setting, as before.
    expect(resolveSeat({ provider: 'claude' }, s)).toEqual({ provider: 'claude' });
  });

  it('a chat and a council member on Default run with the default', async () => {
    const e = engine();
    e.store.settings.update({ defaults: { providers: { codex: { model: 'gpt-6-luna' } } } });
    const codex = e.adapters.get('codex') as FakeAdapter;
    const thread = e.chat.createThread({ provider: 'codex' });
    await e.chat.send(thread.id, 'hi', { provider: 'codex' });
    expect(codex.requests.at(-1)?.model).toBe('gpt-6-luna');
    await e.council.ask('which?', { members: [{ provider: 'claude' }, { provider: 'codex' }] });
    expect(codex.requests.at(-1)?.model).toBe('gpt-6-luna');
    // A model picked for the chat wins over the default.
    await e.chat.send(thread.id, 'again', { provider: 'codex', model: 'gpt-6-astra' });
    expect(codex.requests.at(-1)?.model).toBe('gpt-6-astra');
  });

  it('refuses a default that would reach the CLI as an option', () => {
    const e = engine();
    expect(() =>
      e.store.settings.update({ defaults: { providers: { codex: { model: '--yolo' } } } }),
    ).toThrow();
    expect(e.store.settings.get().defaults.providers.codex).toBeUndefined();
  });
});

describe('Settings survive a bad entry (E12)', () => {
  it('drops only the entry that does not fit; every other setting stays', () => {
    const db = openDatabase(':memory:');
    const store = new Store(db);
    store.settings.update({
      limits: { pauseAll: true, providers: { codex: { leaveForMe: 0.2, dailyCap: 5 } } },
      notifications: { done: false },
    });
    // A renamed or removed AI in the saved limits, and a value of the wrong type.
    const saved = JSON.parse(
      (db.prepare("SELECT value FROM settings WHERE key = 'limits'").get() as { value: string })
        .value,
    ) as Record<string, unknown>;
    (saved.providers as Record<string, unknown>).oldai = { leaveForMe: 0.3 };
    saved.quietHours = 'not a list';
    db.prepare("UPDATE settings SET value = ? WHERE key = 'limits'").run(JSON.stringify(saved));

    const now = store.settings.get();
    expect(now.limits.pauseAll).toBe(true);
    expect(now.limits.providers.codex).toEqual({ leaveForMe: 0.2, dailyCap: 5 });
    expect(now.limits.quietHours).toEqual([]);
    expect(now.notifications.done).toBe(false);
  });

  it('saving one section leaves the others exactly as stored', () => {
    const db = openDatabase(':memory:');
    const store = new Store(db);
    db.prepare("INSERT INTO settings (key, value) VALUES ('notifications', ?)").run(
      JSON.stringify({ done: false, fromANewerVersion: true }),
    );
    store.settings.update({ limits: { pauseAll: true } });
    const raw = db.prepare("SELECT value FROM settings WHERE key = 'notifications'").get() as {
      value: string;
    };
    expect(JSON.parse(raw.value)).toEqual({ done: false, fromANewerVersion: true });
  });
});
