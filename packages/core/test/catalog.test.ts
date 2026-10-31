import { describe, expect, it } from 'vitest';
import { Engine, FakeAdapter, REFUSAL_TTL, Store, recordUsage } from '../src/index.js';

describe('model catalogs', () => {
  it('asks the CLI once, then serves the cache until it is an hour old', async () => {
    let calls = 0;
    const adapter = new FakeAdapter({});
    Object.assign(adapter, {
      models: async () => {
        calls++;
        return { models: [{ id: `m${calls}` }], defaultModel: `m${calls}` };
      },
    });
    const engine = new Engine({ adapters: [adapter], store: new Store(':memory:') });
    expect((await engine.catalog('fake')).models.map((m) => m.id)).toEqual(['m1']);
    expect((await engine.catalog('fake')).models.map((m) => m.id)).toEqual(['m1']);
    expect(calls).toBe(1);
    expect((await engine.catalog('fake', { refresh: true })).defaultModel).toBe('m2');
    expect((await engine.catalog('fake', { maxAgeMs: -1 })).defaultModel).toBe('m3');
    engine.close();
  });

  it('keeps the last list when the CLI can no longer answer, and hides rejected ids', async () => {
    let fail = false;
    const adapter = new FakeAdapter({});
    Object.assign(adapter, {
      models: async () => {
        if (fail) throw new Error('offline');
        return { models: [{ id: 'good' }, { id: 'gone' }] };
      },
    });
    const engine = new Engine({ adapters: [adapter], store: new Store(':memory:') });
    await engine.catalog('fake');
    fail = true;
    engine.store.catalogs.markUnavailable('fake', 'gone');
    const list = await engine.catalog('fake', { refresh: true });
    expect(list.models.map((m) => m.id)).toEqual(['good']);
    expect(list.unavailable).toEqual(['gone']);
    engine.close();
  });

  it("falls back to the adapter's own list when nothing was ever listed", async () => {
    const engine = new Engine({
      adapters: [new FakeAdapter({})],
      store: new Store(':memory:'),
    });
    const list = await engine.catalog('fake');
    expect(list.fetchedAt).toBe(0);
    engine.close();
  });
});

describe('models a CLI refuses', () => {
  it('stop being offered after one refusal', async () => {
    const adapter = new FakeAdapter({
      fail: 'ActionRequiredError: Model unavailable on Free',
    } as never);
    Object.assign(adapter, {
      models: async () => ({ models: [{ id: 'auto' }, { id: 'pro-only' }] }),
    });
    const engine = new Engine({ adapters: [adapter], store: new Store(':memory:') });
    await engine.catalog('fake');
    recordUsage(
      engine.store,
      { seat: { provider: 'fake', model: 'pro-only' }, role: 'chat', source: 'chat' },
      {
        ok: false,
        text: '',
        usage: {},
        quotas: [],
        errors: ['ActionRequiredError: Model unavailable on Free Free includes Auto.'],
        durationMs: 1,
        events: [],
      },
    );
    expect((await engine.catalog('fake')).models.map((m) => m.id)).toEqual(['auto']);
    engine.close();
  });

  it('offer it again after a plan upgrade: a day later, or as soon as it works', async () => {
    const adapter = new FakeAdapter({});
    Object.assign(adapter, {
      models: async () => ({ models: [{ id: 'auto' }, { id: 'pro-only' }] }),
    });
    const engine = new Engine({ adapters: [adapter], store: new Store(':memory:') });
    await engine.catalog('fake');
    const ids = async () => (await engine.catalog('fake')).models.map((m) => m.id);
    engine.store.catalogs.markUnavailable('fake', 'pro-only', Date.now() - REFUSAL_TTL - 1);
    expect(await ids()).toEqual(['auto', 'pro-only']);
    engine.store.catalogs.markUnavailable('fake', 'pro-only');
    expect(await ids()).toEqual(['auto']);
    recordUsage(
      engine.store,
      { seat: { provider: 'fake', model: 'pro-only' }, role: 'chat', source: 'chat' },
      { ok: true, text: 'pong', usage: {}, quotas: [], errors: [], durationMs: 1, events: [] },
    );
    expect(await ids()).toEqual(['auto', 'pro-only']);
    // Rows from before marks carried a time (bare ids) have lapsed.
    engine.store.db.prepare(`UPDATE model_catalogs SET unavailable = '["pro-only"]'`).run();
    expect(await ids()).toEqual(['auto', 'pro-only']);
    engine.close();
  });
});
