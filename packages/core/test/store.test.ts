import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, Store, decisionsSection, openDatabase } from '../src/index.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
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
    const dir = mkdtempSync(join(tmpdir(), 'plenum-'));
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

  it('links earlier failed attempts to their newer twins when upgrading to schema 6', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plenum-db-'));
    dirs.push(dir);
    const path = join(dir, 'plenum.db');
    const store = new Store(path);
    const p = store.projects.create({
      name: 'Calc',
      repoPath: dir,
      goal: 'g',
      baseBranch: 'main',
      routing: { planner: [], builder: [], reviewer: [] },
    });
    const [a, b, c] = store.projects.addTasks(p.id, [
      { title: 'Add particle burst and screen shake on every button press', spec: 'x' },
      { title: 'Add fx.js hook called on every button activation', spec: 'x' },
      { title: 'Add keyboard support', spec: 'x' },
    ]);
    store.projects.updateTask(a!.id, { status: 'failed' });
    store.projects.updateTask(b!.id, { status: 'failed' });
    store.projects.updateTask(c!.id, { status: 'merged' });
    const [twin] = store.projects.addTasks(p.id, [
      { title: 'Add particle burst on every press in fx.js', spec: 'x' },
    ]);
    // Make the twin clearly newer, then pretend the database is from before schema 6.
    const db = openDatabase(path);
    db.prepare('UPDATE tasks SET created_at = created_at + 1000 WHERE id = ?').run(twin!.id);
    db.exec('PRAGMA user_version = 5');
    db.close();
    store.close();

    const reopened = new Store(path);
    const tasks = reopened.projects.listTasks(p.id);
    const byId = new Map(tasks.map((t) => [t.id, t]));
    expect(byId.get(a!.id)).toMatchObject({ status: 'replaced', replacedBy: twin!.id });
    expect(byId.get(b!.id)?.status).toBe('failed');
    expect(byId.get(c!.id)?.status).toBe('merged');
    reopened.close();
  });

  it('stores failure details, pinned seats and project settings', () => {
    const store = new Store(':memory:');
    const p = store.projects.create({
      name: 'x',
      repoPath: '/x',
      goal: 'g',
      baseBranch: 'main',
      routing: { planner: [], builder: [], reviewer: [] },
    });
    expect(p).toMatchObject({
      retryStrategy: 'escalate',
      askPolicy: 'ask',
      permissions: { level: 2, network: 'never', installs: 'ask', expiresAt: null },
    });
    const [t] = store.projects.addTasks(p.id, [{ title: 'T', spec: 's' }]);
    store.projects.updateTask(t!.id, {
      pinnedSeat: { provider: 'claude', model: 'opus', effort: 'high' },
      lastFailure: {
        kind: 'review',
        summary: 'Changes requested',
        detail: '- fix it',
        provider: 'claude',
        model: 'opus',
        at: 5,
      },
    });
    expect(store.projects.findTask(t!.id.slice(0, 10))).toMatchObject({
      pinnedSeat: { provider: 'claude', model: 'opus', effort: 'high' },
      lastFailure: { kind: 'review', at: 5 },
      freeRetries: 0,
      replacedBy: null,
    });
    store.projects.update(p.id, {
      retryStrategy: 'same',
      permissions: { level: 3, network: 'never', installs: 'never', expiresAt: null },
    });
    expect(store.projects.get(p.id)).toMatchObject({
      retryStrategy: 'same',
      permissions: { level: 3, installs: 'never' },
    });
  });

  it('keeps decisions, promotes assumptions and keeps overturned history', () => {
    const store = new Store(':memory:');
    const p = store.projects.create({
      name: 'x',
      repoPath: '/x',
      goal: 'g',
      baseBranch: 'main',
      routing: { planner: [], builder: [], reviewer: [] },
    });
    const a = store.decisions.add({
      projectId: p.id,
      kind: 'assumption',
      question: 'Decimals',
      answer: '3',
      source: 'agent',
    });
    store.decisions.add({
      projectId: p.id,
      kind: 'decision',
      question: 'Framework',
      answer: 'none',
      source: 'you',
    });
    expect(store.decisions.keep(a.id)?.kind).toBe('decision');
    const changed = store.decisions.change(a.id, '2');
    expect(changed).toMatchObject({ answer: '2', source: 'you', status: 'active' });
    expect(store.decisions.get(a.id)?.status).toBe('overturned');
    const section = decisionsSection(store.decisions.list(p.id));
    expect(section).toContain(
      'DECISIONS (follow these; they come from the user)\n- Framework: none\n- Decimals: 2',
    );
    expect(section).not.toContain('ASSUMPTIONS');
    expect(section).not.toContain(': 3');
  });

  it('caps the decisions section and says how many were left out', () => {
    const now = Date.now();
    const many = Array.from({ length: 45 }, (_, i) => ({
      id: `d${i}`,
      projectId: 'p',
      kind: 'assumption' as const,
      question: `Q${i}`,
      answer: 'A',
      source: 'agent' as const,
      provider: null,
      taskId: null,
      status: 'active' as const,
      createdAt: now + i,
      updatedAt: now + i,
    }));
    const section = decisionsSection(many);
    expect(section).toContain('- Q44: A');
    expect(section).not.toContain('- Q4: A');
    expect(section).toContain('(5 older items not shown)');
  });
});

describe('Settings', () => {
  it('starts from defaults, merges changes per section, and survives a damaged value', () => {
    const store = new Store(':memory:');
    expect(store.settings.get().notifications).toEqual({
      needsYou: true,
      approval: true,
      done: true,
      paused: true,
      limit: true,
    });
    store.settings.update({ notifications: { done: false } });
    expect(store.settings.get().notifications).toMatchObject({ done: false, needsYou: true });
    store.db.prepare("UPDATE settings SET value = '{oops' WHERE key = 'notifications'").run();
    expect(store.settings.get().notifications.done).toBe(true);
  });
});

describe('Settings patches', () => {
  it('only change the keys they name, and reject bad values', () => {
    const store = new Store(':memory:');
    store.settings.update({ notifications: { done: false } });
    store.settings.update({ notifications: { limit: false } });
    expect(store.settings.get().notifications).toMatchObject({
      done: false,
      limit: false,
      needsYou: true,
    });
    store.settings.update({
      limits: { providers: { codex: { lanes: 3, leaveForMe: 0.1, dailyCap: null } } },
    });
    store.settings.update({ limits: { pauseAll: true } });
    expect(store.settings.get().limits).toMatchObject({
      pauseAll: true,
      providers: { codex: { lanes: 3 } },
    });
    expect(() =>
      store.settings.update({
        limits: { quietHours: [{ days: [], from: '25:00', to: 'x' }] },
      } as never),
    ).toThrow();
    expect(store.settings.get().limits.quietHours).toEqual([]);
  });
});
