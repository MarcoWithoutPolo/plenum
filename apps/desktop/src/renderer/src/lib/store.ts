import { create } from 'zustand';
import type { AgentEvent, Message, ProviderId, Seat, Thread } from '@conclave/shared';
import { firstPreferred, preferred, shortName } from '@conclave/shared';
import type { ProviderInfo, QuotaInfo, RunUpdate, ThreadDetail } from '../../../shared/api';
import { api, newRequestId } from './api';
import { settle } from './settle';
import { announce } from './announce';
import { applyLook } from '../../../shared/look';

export type Screen =
  | { name: 'chat'; threadId?: string }
  | { name: 'council'; threadId?: string }
  | { name: 'projects'; projectId?: string }
  | { name: 'approvals' }
  | { name: 'usage' }
  | { name: 'accounts' }
  | { name: 'settings' };

export type RunStatus = 'waiting' | 'thinking' | 'done' | 'failed' | 'skipped';

export interface LiveChat {
  requestId: string;
  seat: Seat;
  userText: string;
  text: string;
  status: RunStatus;
}

export interface LiveSeat {
  label: string;
  seat: Seat;
  text: string;
  status: RunStatus;
  durationMs?: number;
  /** Why it was skipped ("Skipped by you", "Skipped after 2 min"). */
  skipped?: string;
}

export interface LiveCouncil {
  requestId: string;
  question: string;
  members: LiveSeat[];
  synth: LiveSeat;
  /** Set once the round is saved, so the screen can switch to the stored thread. */
  threadId?: string;
}

/** Runs you stopped, so one that hasn't reached the engine yet never starts. */
const stopped = new Set<string>();
let initStarted = false;

/** Key for runs on a thread that doesn't exist yet. */
export const NEW = '__new__';

interface State {
  ready: boolean;
  /** Why the app couldn't load (it offers Retry), or null. */
  loadError: string | null;
  /** The AI new chats start with (Accounts → Start new chats with); null: the last one used. */
  chatDefault: ProviderId | null;
  setChatDefault(provider: ProviderId | null): Promise<void>;
  providers: ProviderInfo[];
  quotas: QuotaInfo[];
  threads: Thread[];
  details: Record<string, ThreadDetail>;
  screen: Screen;
  liveChats: Record<string, LiveChat>;
  liveCouncils: Record<string, LiveCouncil>;
  /** The seat a new chat starts with; remembered between chats. */
  lastSeat?: Seat;
  /** The seats picked for each council thread (what was asked for, not what the CLI resolved). */
  councilSeats: Record<string, { members: Seat[]; synthesizer: Seat }>;
  toast?: { kind: 'error' | 'info'; text: string };

  init(): Promise<void>;
  refreshProviders(): Promise<void>;
  refreshThreads(): Promise<void>;
  loadThread(id: string): Promise<ThreadDetail | null>;
  /**
   * Goes up each time you open a screen. Screens are keyed by it, so a round that finishes and
   * moves a new council to its saved thread doesn't remount it and wipe what you're typing.
   */
  screenSeq: number;
  open(screen: Screen): void;
  sendChat(threadId: string | undefined, text: string, seat: Seat): Promise<void>;
  askCouncil(
    threadId: string | undefined,
    question: string,
    members: Seat[],
    synthesizer: Seat,
  ): Promise<void>;
  cancel(requestId: string): void;
  /** Council (F4): stop one member of a running round, or merge what came back now. */
  skipMember(requestId: string, index: number): void;
  mergeNow(requestId: string): void;
  removeThread(id: string): Promise<void>;
  renameThread(id: string, title: string): Promise<void>;
  showToast(kind: 'error' | 'info', text: string): void;
}

export const errorText = (err: unknown) =>
  (err instanceof Error ? err.message : String(err)).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    '',
  );

export const useApp = create<State>((set, get) => ({
  ready: false,
  loadError: null,
  chatDefault: null,
  providers: [],
  quotas: [],
  threads: [],
  details: {},
  screen: { name: 'chat' },
  screenSeq: 0,
  liveChats: {},
  liveCouncils: {},
  councilSeats: {},

  async init() {
    // StrictMode runs effects twice in development; subscribe only once.
    if (!initStarted) {
      initStarted = true;
      api().runs.onUpdate((u) => applyUpdate(u, set));
      window.addEventListener('focus', () => settle(get().refreshProviders()));
    }
    // A failure shows with Retry instead of "Loading…" for good (U9).
    try {
      set({ loadError: null });
      const [settings] = await Promise.all([
        api().settings.get(),
        get().refreshProviders(),
        get().refreshThreads(),
      ]);
      applyLook(document.documentElement, settings.appearance);
      set({ ready: true, chatDefault: settings.defaults.chat });
    } catch (err) {
      set({ loadError: errorText(err) });
      throw err;
    }
  },

  async refreshProviders() {
    try {
      const [providers, quotas] = await Promise.all([
        api().accounts.list(),
        api().accounts.quotas(),
      ]);
      set({ providers, quotas });
    } catch (err) {
      get().showToast('error', errorText(err));
    }
  },

  async refreshThreads() {
    set({ threads: await api().threads.list() });
  },

  async loadThread(id) {
    const detail = await api().threads.get(id);
    if (detail) set((s) => ({ details: { ...s.details, [id]: detail } }));
    return detail;
  },

  open(screen) {
    set((s) => ({ screen, screenSeq: s.screenSeq + 1 }));
    if ('threadId' in screen && screen.threadId) settle(get().loadThread(screen.threadId));
  },

  async sendChat(threadId, text, seat) {
    const requestId = newRequestId();
    stopped.delete(requestId);
    let key = threadId ?? NEW;
    set((s) => ({
      lastSeat: seat,
      liveChats: {
        ...s.liveChats,
        [key]: { requestId, seat, userText: text, text: '', status: 'waiting' },
      },
    }));
    try {
      let id = threadId;
      if (!id) {
        const thread = await api().chat.create(seat);
        id = thread.id;
        // Move the live run onto the real thread, and show it if you're still on the new chat
        // (U5: finishing never pulls you away from another screen).
        set((s) => {
          const { [NEW]: live, ...rest } = s.liveChats;
          const here = s.screen.name === 'chat' && !s.screen.threadId;
          return {
            liveChats: live ? { ...rest, [thread.id]: live } : rest,
            ...(here && { screen: { name: 'chat', threadId: thread.id } as Screen }),
            details: { ...s.details, [thread.id]: { thread, messages: [] } },
          };
        });
        key = thread.id;
        settle(get().refreshThreads());
      }
      // Stop pressed while the chat was being created (U10): nothing is sent.
      if (stopped.has(requestId)) return;
      await api().chat.send({ requestId, threadId: id, text, seat });
      await get().loadThread(id);
    } catch (err) {
      get().showToast('error', errorText(err));
    } finally {
      set((s) => {
        const { [key]: _done, ...rest } = s.liveChats;
        return { liveChats: rest };
      });
      settle(get().refreshThreads());
      settle(refreshQuotas(set));
    }
  },

  async askCouncil(threadId, question, members, synthesizer) {
    const requestId = newRequestId();
    const key = threadId ?? NEW;
    const labels = labelSeats(members);
    set((s) => ({
      liveCouncils: {
        ...s.liveCouncils,
        [key]: {
          requestId,
          question,
          members: members.map((seat, i) => ({
            label: labels[i]!,
            seat,
            text: '',
            status: 'waiting',
          })),
          synth: { label: 'Merged answer', seat: synthesizer, text: '', status: 'waiting' },
        },
      },
    }));
    try {
      const result = await api().council.ask({
        requestId,
        question,
        members,
        synthesizer,
        ...(threadId && { threadId }),
      });
      set((s) => ({
        councilSeats: {
          ...s.councilSeats,
          [result.thread.id]: { members, synthesizer },
          [NEW]: { members, synthesizer },
        },
      }));
      await get().loadThread(result.thread.id);
      announce('The council answered');
      // Show the round only if you're still where you asked it (U5).
      set((s) =>
        s.screen.name === 'council' && (s.screen.threadId ?? undefined) === threadId
          ? { screen: { name: 'council', threadId: result.thread.id } }
          : {},
      );
    } catch (err) {
      get().showToast('error', errorText(err));
    } finally {
      set((s) => {
        const { [key]: _done, ...rest } = s.liveCouncils;
        return { liveCouncils: rest };
      });
      settle(get().refreshThreads());
      settle(refreshQuotas(set));
    }
  },

  async setChatDefault(provider) {
    const saved = await api().settings.update({ defaults: { chat: provider } });
    set({ chatDefault: saved.defaults.chat });
  },

  skipMember(requestId, index) {
    settle(api().council.skip(requestId, index));
  },

  mergeNow(requestId) {
    settle(api().council.mergeNow(requestId));
  },

  cancel(requestId) {
    stopped.add(requestId);
    settle(api().runs.cancel(requestId));
  },

  async removeThread(id) {
    await api().threads.remove(id);
    set((s) => {
      const { [id]: _gone, ...details } = s.details;
      const screen =
        'threadId' in s.screen && s.screen.threadId === id ? { name: s.screen.name } : s.screen;
      return { details, screen: screen as Screen };
    });
    await get().refreshThreads();
  },

  async renameThread(id, title) {
    await api().threads.rename(id, title);
    await Promise.all([get().refreshThreads(), get().loadThread(id)]);
  },

  showToast(kind, text) {
    set({ toast: { kind, text } });
    window.setTimeout(() => {
      if (get().toast?.text === text) set({ toast: undefined });
    }, 6000);
  },
}));

async function refreshQuotas(set: (partial: Partial<State>) => void) {
  try {
    set({ quotas: await api().accounts.quotas() });
  } catch {
    // quotas are informational
  }
}

function step(seat: LiveSeat, event: AgentEvent): LiveSeat {
  // Skipped stays skipped: words still in flight, and the run ending as a failure, change
  // nothing on its card.
  if (seat.status === 'skipped')
    return event.type === 'done' ? { ...seat, durationMs: event.durationMs } : seat;
  switch (event.type) {
    case 'session':
      return { ...seat, status: 'thinking' };
    case 'message.delta':
      return { ...seat, status: 'thinking', text: seat.text + event.text };
    case 'message.done':
      return { ...seat, text: event.text || seat.text };
    case 'done':
      return { ...seat, status: event.ok ? 'done' : 'failed', durationMs: event.durationMs };
    default:
      return seat;
  }
}

function applyUpdate(u: RunUpdate, set: (fn: (s: State) => Partial<State>) => void) {
  set((s) => {
    if (u.kind === 'chat') {
      const entry = Object.entries(s.liveChats).find(([, live]) => live.requestId === u.requestId);
      if (!entry) return {};
      const [key, live] = entry;
      const next = step(
        { label: '', seat: live.seat, text: live.text, status: live.status },
        u.event,
      );
      return {
        liveChats: { ...s.liveChats, [key]: { ...live, text: next.text, status: next.status } },
      };
    }
    const entry = Object.entries(s.liveCouncils).find(([, live]) => live.requestId === u.requestId);
    if (!entry) return {};
    const [key, live] = entry;
    const next =
      u.kind === 'member'
        ? { ...live, members: live.members.map((m, i) => (i === u.index ? step(m, u.event) : m)) }
        : u.kind === 'skipped'
          ? {
              ...live,
              members: live.members.map((m, i) =>
                i === u.index ? { ...m, status: 'skipped' as const, skipped: u.reason } : m,
              ),
            }
          : { ...live, synth: step(live.synth, u.event) };
    return { liveCouncils: { ...s.liveCouncils, [key]: next } };
  });
}

export function providerName(provider: ProviderId): string {
  return shortName(provider);
}

export function seatText(seat: Seat): string {
  return [shortName(seat.provider), seat.model, seat.effort && `${seat.effort} effort`]
    .filter(Boolean)
    .join(' · ');
}

/** The seat a stored message or thread was answered with. */
export function seatOf(m: {
  provider: ProviderId | null;
  model: string | null;
  effort: string | null;
}): Seat {
  return {
    provider: m.provider ?? preferred('chat')[0]!,
    ...(m.model && { model: m.model }),
    ...(m.effort && { effort: m.effort }),
  };
}

/** Same rule as the engine: show the model only when a provider sits twice. */
export function labelSeats(seats: Seat[]): string[] {
  const counts = new Map<ProviderId, number>();
  for (const s of seats) counts.set(s.provider, (counts.get(s.provider) ?? 0) + 1);
  return seats.map((s) =>
    (counts.get(s.provider) ?? 0) > 1 && s.model
      ? `${shortName(s.provider)} (${s.model})`
      : shortName(s.provider),
  );
}

export function readyProviders(providers: ProviderInfo[]): ProviderInfo[] {
  return providers.filter((p) => p.auth === 'signed_in');
}

export function defaultSeat(
  providers: ProviderInfo[],
  last?: Seat,
  chatDefault?: ProviderId | null,
): Seat | undefined {
  const ready = readyProviders(providers);
  // The AI you chose for new chats (F2) comes before the one you used last.
  if (chatDefault && ready.some((p) => p.provider === chatDefault))
    return { provider: chatDefault };
  if (last && ready.some((p) => p.provider === last.provider)) return last;
  const pick = firstPreferred(ready);
  return pick && { provider: pick.provider };
}

/** Group a council thread's messages into rounds. */
export interface Round {
  groupId: string;
  question?: Message;
  answers: Message[];
  merged?: Message;
}

export function councilRounds(messages: Message[]): Round[] {
  const rounds = new Map<string, Round>();
  for (const m of messages) {
    const id = m.groupId ?? m.id;
    const round = rounds.get(id) ?? { groupId: id, answers: [] };
    if (m.role === 'user') round.question = m;
    else if (m.kind === 'council_answer') round.answers.push(m);
    else if (m.kind === 'council_merged') round.merged = m;
    rounds.set(id, round);
  }
  return [...rounds.values()];
}
