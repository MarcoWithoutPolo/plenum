import type { BrainEvent, NotificationSettings } from '@conclave/shared';

export type NoticeKind = keyof NotificationSettings;

export interface Notice {
  kind: NoticeKind;
  projectId: string;
  title: string;
  body: string;
}

/** What deserves a desktop notification, from one brain event. Everything else is silent. */
export function noticeFor(event: BrainEvent, projectName: string): Notice | null {
  const base = { projectId: event.projectId, title: projectName };
  const m = event.message;
  if (event.kind === 'question' && / asks: /.test(m)) {
    return { ...base, kind: 'needsYou', body: m.slice(0, 200) };
  }
  if (event.kind === 'approval' && m.startsWith('Waiting for you: ')) {
    return { ...base, kind: 'approval', body: m.slice('Waiting for you: '.length, 200) };
  }
  if (event.kind === 'done') {
    return { ...base, kind: 'done', body: m.replace(/^Goal met: /, 'Goal met. ').slice(0, 200) };
  }
  if (event.kind === 'stop' && /in a row failed/.test(m)) {
    return {
      ...base,
      kind: 'paused',
      body: 'Paused after several failures in a row. Have a look.',
    };
  }
  if (event.kind === 'wait' && /usage limit/.test(m)) {
    return { ...base, kind: 'limit', body: m.split(';')[0]!.slice(0, 200) };
  }
  return null;
}

export interface NotifierDeps {
  show(notice: Notice): void;
  /** Notifications only matter while you're elsewhere. */
  focused(): boolean;
  settings(): NotificationSettings;
  projectName(projectId: string): string;
  /** Windows: flash the taskbar icon when something needs you. */
  attention?(): void;
  now?: () => number;
}

/**
 * Turns brain events into desktop notifications: only while the window isn't focused, only
 * the kinds you left on, at most one "out of usage" per AI per day, and no "ready to merge"
 * right after a "goal met" for the same project (the goal-met one already says so).
 */
export class Notifier {
  private readonly limitDays = new Map<string, string>();
  private readonly doneAt = new Map<string, number>();

  constructor(private readonly deps: NotifierDeps) {}

  handle(event: BrainEvent): Notice | null {
    const now = this.deps.now?.() ?? Date.now();
    const notice = noticeFor(event, this.deps.projectName(event.projectId));
    if (!notice) return null;
    if (notice.kind === 'done') this.doneAt.set(event.projectId, now);
    if (
      notice.kind === 'approval' &&
      now - (this.doneAt.get(event.projectId) ?? -Infinity) < 10_000
    ) {
      return null;
    }
    if (notice.kind === 'limit') {
      const day = new Date(now).toDateString();
      const key = event.provider ?? notice.body;
      if (this.limitDays.get(key) === day) return null;
      this.limitDays.set(key, day);
    }
    if (!this.deps.settings()[notice.kind] || this.deps.focused()) return null;
    this.deps.show(notice);
    if (notice.kind === 'needsYou') this.deps.attention?.();
    return notice;
  }
}
