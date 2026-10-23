import { describe, expect, it } from 'vitest';
import type { BrainEvent, NotificationSettings } from '@conclave/shared';
import { Notifier, noticeFor, type Notice } from '../src/main/notify';

const ALL_ON: NotificationSettings = {
  needsYou: true,
  approval: true,
  done: true,
  paused: true,
  limit: true,
};

let id = 0;
const event = (kind: BrainEvent['kind'], message: string, extra: Partial<BrainEvent> = {}) =>
  ({
    id: ++id,
    projectId: 'p1',
    taskId: null,
    kind,
    message,
    provider: null,
    data: null,
    at: 0,
    ...extra,
  }) as BrainEvent;

function setup(opts: { focused?: boolean; settings?: Partial<NotificationSettings> } = {}) {
  const shown: Notice[] = [];
  let attention = 0;
  let now = 1_000_000;
  const notifier = new Notifier({
    show: (n) => shown.push(n),
    focused: () => opts.focused ?? false,
    settings: () => ({ ...ALL_ON, ...opts.settings }),
    projectName: () => 'greeter',
    attention: () => attention++,
    now: () => now,
  });
  return {
    notifier,
    shown,
    attention: () => attention,
    tick: (ms: number) => (now += ms),
  };
}

describe('Notifications', () => {
  it('maps the events that need you, and nothing else', () => {
    expect(noticeFor(event('question', 'Codex asks: Which tone?'), 'greeter')).toMatchObject({
      kind: 'needsYou',
      title: 'greeter',
      body: 'Codex asks: Which tone?',
    });
    expect(
      noticeFor(event('approval', 'Waiting for you: Merge conclave/integration into main'), 'g'),
    ).toMatchObject({ kind: 'approval', body: 'Merge conclave/integration into main' });
    expect(noticeFor(event('done', 'Goal met: all done'), 'g')?.kind).toBe('done');
    expect(
      noticeFor(event('stop', '3 tasks in a row failed with nothing merged. Paused…'), 'g')?.kind,
    ).toBe('paused');
    expect(
      noticeFor(event('wait', 'Codex hit a usage limit; the task goes back in the queue'), 'g'),
    ).toMatchObject({ kind: 'limit', body: 'Codex hit a usage limit' });
    expect(noticeFor(event('task', 'Building: Add a'), 'g')).toBeNull();
    expect(noticeFor(event('question', 'Waiting for you: 1 question'), 'g')).toBeNull();
    expect(noticeFor(event('stop', 'Stopped by you'), 'g')).toBeNull();
  });

  it('only shows while the window is elsewhere, and flashes for questions', () => {
    const away = setup();
    away.notifier.handle(event('question', 'Codex asks: Which tone?'));
    expect(away.shown).toHaveLength(1);
    expect(away.attention()).toBe(1);

    const here = setup({ focused: true });
    here.notifier.handle(event('question', 'Codex asks: Which tone?'));
    expect(here.shown).toHaveLength(0);
  });

  it('respects the kinds you turned off', () => {
    const s = setup({ settings: { done: false } });
    s.notifier.handle(event('done', 'Goal met: x'));
    s.notifier.handle(event('stop', '3 tasks in a row failed'));
    expect(s.shown.map((n) => n.kind)).toEqual(['paused']);
  });

  it('says "out of usage" once per AI per day', () => {
    const s = setup();
    const limit = (provider: 'codex' | 'claude') =>
      event('wait', `${provider} hit a usage limit; back in the queue`, { provider });
    s.notifier.handle(limit('codex'));
    s.notifier.handle(limit('codex'));
    s.notifier.handle(limit('claude'));
    expect(s.shown).toHaveLength(2);
    s.tick(25 * 60 * 60 * 1000);
    s.notifier.handle(limit('codex'));
    expect(s.shown).toHaveLength(3);
  });

  it('skips "ready to merge" right after "goal met" for the same project', () => {
    const s = setup();
    s.notifier.handle(event('done', 'Goal met: x'));
    s.notifier.handle(event('approval', 'Waiting for you: Merge conclave/integration into main'));
    expect(s.shown.map((n) => n.kind)).toEqual(['done']);
    s.tick(60_000);
    s.notifier.handle(event('approval', 'Waiting for you: Open a pull request'));
    expect(s.shown.map((n) => n.kind)).toEqual(['done', 'approval']);
  });
});
