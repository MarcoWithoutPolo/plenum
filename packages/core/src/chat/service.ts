import { homedir } from 'node:os';
import type { AgentEvent, Message, ProviderId, Seat, Thread } from '@conclave/shared';
import type { Adapter } from '../adapters/types.js';
import { collect, type RunResult } from '../collect.js';
import type { Store } from '../store/store.js';
import { buildChatPrompt } from './transcript.js';

export interface EngineContext {
  store: Store;
  adapters: Map<ProviderId, Adapter>;
  /** Where chat CLIs run. Chat is read-only, so this is only the CLI's working directory. */
  cwd?: string;
}

export interface SendOptions {
  /** Switch this thread to another provider (and model) from this message on. */
  provider?: ProviderId;
  model?: string | null;
  /** Reasoning effort from this message on; null goes back to the CLI's setting. */
  effort?: string | null;
  onEvent?: (event: AgentEvent) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface SendResult {
  thread: Thread;
  user: Message;
  reply: Message;
  result: RunResult;
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;

export class ChatService {
  constructor(private readonly ctx: EngineContext) {}

  createThread(seat: Seat, title?: string): Thread {
    return this.ctx.store.createThread({
      provider: seat.provider,
      model: seat.model ?? null,
      effort: seat.effort ?? null,
      ...(title && { title }),
    });
  }

  async send(threadId: string, text: string, opts: SendOptions = {}): Promise<SendResult> {
    const { store } = this.ctx;
    let thread = store.getThread(threadId);
    if (!thread) throw new Error(`No such thread: ${threadId}`);
    if (!text.trim()) throw new Error('Message is empty');

    const seat = resolveSeat(thread, opts);
    if (
      seat.provider !== thread.provider ||
      (seat.model ?? null) !== thread.model ||
      (seat.effort ?? null) !== thread.effort
    ) {
      thread = store.updateThread(thread.id, {
        provider: seat.provider,
        model: seat.model ?? null,
        effort: seat.effort ?? null,
      })!;
    }
    const adapter = this.adapter(seat.provider);

    const history = store.listMessages(thread.id);
    const user = store.addMessage(thread.id, { role: 'user', content: text });

    const session = store.getProviderSession(thread.id, seat.provider);
    const run = (resume: boolean) =>
      collect(
        adapter.run({
          prompt: buildChatPrompt(history, text, resume ? session?.lastSeq : undefined),
          cwd: this.ctx.cwd ?? homedir(),
          role: 'chat',
          readOnly: true,
          timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          ...(seat.model && { model: seat.model }),
          ...(seat.effort && { effort: seat.effort }),
          ...(resume && session && { sessionId: session.sessionId }),
          ...(opts.signal && { signal: opts.signal }),
        }),
        opts.onEvent,
      );

    let result = await run(Boolean(session));
    // A CLI session can expire or be deleted; fall back to replaying the history once.
    if (!result.ok && session && !result.rateLimited && !opts.signal?.aborted) {
      result = await run(false);
    }

    recordQuotas(store, seat.provider, result);
    const reply = store.addMessage(thread.id, {
      role: 'assistant',
      provider: seat.provider,
      model: result.model ?? seat.model ?? null,
      effort: seat.effort ?? null,
      content: result.text,
      ok: result.ok,
      error: result.ok ? null : (result.rateLimited?.message ?? result.errors[0] ?? 'No reply'),
      usage: result.usage,
      durationMs: result.durationMs,
    });
    if (result.ok && result.sessionId && adapter.capabilities.resume) {
      store.setProviderSession(thread.id, seat.provider, result.sessionId, reply.seq);
    }
    if (history.length === 0 && thread.title === 'New chat') {
      thread = store.updateThread(thread.id, { title: titleFrom(text) })!;
    }
    return { thread: store.getThread(thread.id)!, user, reply, result };
  }

  private adapter(provider: ProviderId): Adapter {
    const adapter = this.ctx.adapters.get(provider);
    if (!adapter) throw new Error(`Provider not available: ${provider}`);
    return adapter;
  }
}

function resolveSeat(thread: Thread, opts: SendOptions): Seat {
  if (opts.provider && opts.provider !== thread.provider) {
    return {
      provider: opts.provider,
      ...(opts.model && { model: opts.model }),
      ...(opts.effort && { effort: opts.effort }),
    };
  }
  const model = opts.model === undefined ? thread.model : opts.model;
  const effort = opts.effort === undefined ? thread.effort : opts.effort;
  return { provider: thread.provider, ...(model && { model }), ...(effort && { effort }) };
}

export function recordQuotas(store: Store, provider: ProviderId, result: RunResult): void {
  const at = Date.now();
  for (const q of result.quotas) {
    store.recordQuota({
      provider,
      window: q.window,
      utilization: q.utilization ?? null,
      resetsAt: q.resetsAt ?? null,
      at,
    });
  }
  if (result.rateLimited) {
    store.recordQuota({
      provider,
      window: 'limit',
      utilization: 1,
      resetsAt: result.rateLimited.resetsAt ?? null,
      at,
    });
  }
}

export function titleFrom(text: string): string {
  const line = text.trim().split(/\r?\n/)[0] ?? '';
  return line.length > 60 ? `${line.slice(0, 57).trimEnd()}...` : line || 'New chat';
}
