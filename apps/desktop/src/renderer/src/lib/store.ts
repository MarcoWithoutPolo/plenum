import { create } from 'zustand';
import type { AgentEvent, Message, ProviderId, Seat, Thread } from '@conclave/shared';
import type { ProviderInfo, QuotaInfo, RunUpdate, ThreadDetail } from '../../../shared/api';
import { api, newRequestId } from './api';

export type Screen =
  | { name: 'chat'; threadId?: string }
  | { name: 'council'; threadId?: string }
  | { name: 'accounts' };

export type RunStatus = 'waiting' | 'thinking' | 'done' | 'failed';

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
}

export interface LiveCouncil {
  requestId: string;
  question: string;
  members: LiveSeat[];
  synth: LiveSeat;
  /** Set once the round is saved, so the screen can switch to the stored thread. */
  threadId?: string;
}

let initStarted = false;

/** Key for runs on a thread that doesn't exist yet. */
export const NEW = '__new__';

interface State {
  ready: boolean;
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
  open(screen: Screen): void;
  sendChat(threadId: string | undefined, text: string, seat: Seat): Promise<void>;
  askCouncil(
    threadId: string | undefined,
    question: string,
    members: Seat[],
    synthesizer: Seat,
  ): Promise<void>;
  cancel(requestId: string): void;
  removeThread(id: string): Promise<void>;
  renameThread(id: string, title: string): Promise<void>;
  showToast(kind: 'error' | 'info', text: string): void;
}

const errorText = (err: unknown) =>
  (err instanceof Error ? err.message : String(err)).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    '',
  );

export const useApp = create<State>((set, get) => ({
  ready: false,
  providers: [],
  quotas: [],
  threads: [],
  details: {},
  screen: { name: 'chat' },
  liveChats: {},
  liveCouncils: {},
  councilSeats: {},

  async init() {
    // StrictMode runs effects twice in development; subscribe only once.
    if (initStarted) return;
    initStarted = true;
    api().runs.onUpdate((u) => applyUpdate(u, set));
    window.addEventListener('focus', () => void get().refreshProviders());
    await Promise.all([get().refreshProviders(), get().refreshThreads()]);
    set({ ready: true });
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
    set({ screen });
    if ('threadId' in screen && screen.threadId) void get().loadThread(screen.threadId);
  },

  async sendChat(threadId, text, seat) {
    const requestId = newRequestId();
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
        // Move the live run onto the real thread and show it.
        set((s) => {
          const { [NEW]: live, ...rest } = s.liveChats;
          return {
            liveChats: live ? { ...rest, [thread.id]: live } : rest,
            screen: { name: 'chat', threadId: thread.id },
            details: { ...s.details, [thread.id]: { thread, messages: [] } },
          };
        });
        key = thread.id;
        void get().refreshThreads();
      }
      await api().chat.send({ requestId, threadId: id, text, seat });
      await get().loadThread(id);
    } catch (err) {
      get().showToast('error', errorText(err));
    } finally {
      set((s) => {
        const { [key]: _done, ...rest } = s.liveChats;
        return { liveChats: rest };
      });
      void get().refreshThreads();
      void refreshQuotas(set);
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
      set({ screen: { name: 'council', threadId: result.thread.id } });
    } catch (err) {
      get().showToast('error', errorText(err));
    } finally {
      set((s) => {
        const { [key]: _done, ...rest } = s.liveCouncils;
        return { liveCouncils: rest };
      });
      void get().refreshThreads();
      void refreshQuotas(set);
    }
  },

  cancel(requestId) {
    void api().runs.cancel(requestId);
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
        : { ...live, synth: step(live.synth, u.event) };
    return { liveCouncils: { ...s.liveCouncils, [key]: next } };
  });
}

const SHORT: Record<ProviderId, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  fake: 'Fake',
};

export function providerName(provider: ProviderId): string {
  return SHORT[provider];
}

export function seatText(seat: Seat): string {
  return [SHORT[seat.provider], seat.model, seat.effort && `${seat.effort} effort`]
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
    provider: m.provider ?? 'claude',
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
      ? `${SHORT[s.provider]} (${s.model})`
      : SHORT[s.provider],
  );
}

export function readyProviders(providers: ProviderInfo[]): ProviderInfo[] {
  return providers.filter((p) => p.auth === 'signed_in');
}

export function defaultSeat(providers: ProviderInfo[], last?: Seat): Seat | undefined {
  const ready = readyProviders(providers);
  if (last && ready.some((p) => p.provider === last.provider)) return last;
  const pick = ready.find((p) => p.provider === 'claude') ?? ready[0];
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
