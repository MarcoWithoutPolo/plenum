import { homedir } from 'node:os';
import type { AgentEvent, Message, MessageOutcome, Seat, Thread } from '@conclave/shared';
import { newId } from '../store/store.js';
import { collect, type RunResult } from '../collect.js';
import { recordUsage, titleFrom, type EngineContext } from '../chat/service.js';
import { renderTranscript, seatLabels } from '../chat/transcript.js';
import { seatOptions } from '../seats.js';

export interface CouncilOptions {
  members: Seat[];
  /** Who merges the answers. Defaults to the first member. */
  synthesizer?: Seat;
  /** Add this round to an existing council thread; earlier rounds become context. */
  threadId?: string;
  onEvent?: (update: CouncilUpdate) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Skip a member or merge now while the round runs (v1.0 F4). */
  control?: CouncilControl;
  /** Members still answering after this long are skipped and the rest merged (Settings, MCP). */
  maxWaitMs?: number;
}

export type CouncilUpdate =
  | { phase: 'member'; index: number; label: string; seat: Seat; event: AgentEvent }
  | { phase: 'synthesis'; label: string; seat: Seat; event: AgentEvent }
  /** A member was skipped (by you, or after the wait limit): its card says so at once. */
  | { phase: 'skipped'; index: number; label: string; seat: Seat; reason: string };

export interface CouncilAnswer {
  seat: Seat;
  label: string;
  message: Message;
  result: RunResult;
  outcome: MessageOutcome;
}

export interface CouncilResult {
  thread: Thread;
  groupId: string;
  question: Message;
  answers: CouncilAnswer[];
  merged: Message;
  /** How the merged answer was produced. */
  mergedBy: 'synthesizer' | 'single-answer' | 'none';
}

/**
 * The handle the window (or MCP) holds while a round runs. Skipping a member that already
 * answered does nothing; once the round is over, nothing does.
 */
export class CouncilControl {
  private skipper: ((index: number, reason: string) => void) | undefined;
  private pending: { index: number; reason: string }[] = [];
  private merger: (() => void) | undefined;
  private mergeAsked = false;

  /** Stop this member and leave it out of the merge. */
  skip(index: number, reason = 'Skipped by you'): void {
    if (this.skipper) this.skipper(index, reason);
    else this.pending.push({ index, reason });
  }

  /** Skip every member still answering and merge what has come back. */
  mergeNow(): void {
    if (this.merger) this.merger();
    else this.mergeAsked = true;
  }

  /** @internal The round wires itself in when it starts. */
  attach(skip: (index: number, reason: string) => void, mergeNow: () => void): void {
    this.skipper = skip;
    this.merger = mergeNow;
    for (const p of this.pending.splice(0)) skip(p.index, p.reason);
    if (this.mergeAsked) mergeNow();
  }

  /** @internal */
  detach(): void {
    this.skipper = undefined;
    this.merger = undefined;
  }
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;

/** Ask several models the same question in parallel, then merge their answers into one. */
export class Council {
  constructor(private readonly ctx: EngineContext) {}

  async ask(question: string, opts: CouncilOptions): Promise<CouncilResult> {
    const { store } = this.ctx;
    if (!question.trim()) throw new Error('Question is empty');
    if (opts.members.length === 0) throw new Error('A council needs at least one member');
    for (const seat of [...opts.members, ...(opts.synthesizer ? [opts.synthesizer] : [])]) {
      if (!this.ctx.adapters.has(seat.provider)) {
        throw new Error(`Provider not available: ${seat.provider}`);
      }
    }
    const synthesizer = opts.synthesizer ?? opts.members[0]!;

    let thread = opts.threadId ? store.getThread(opts.threadId) : undefined;
    if (opts.threadId && !thread) throw new Error(`No such thread: ${opts.threadId}`);
    thread ??= store.createThread({
      mode: 'council',
      title: titleFrom(question),
      provider: synthesizer.provider,
      model: synthesizer.model ?? null,
    });

    // Earlier rounds count as context only through their questions and merged answers.
    const prior = store
      .listMessages(thread.id)
      .filter((m) => m.role === 'user' || m.kind === 'council_merged');
    const groupId = newId('g');
    const questionMsg = store.addMessage(thread.id, { role: 'user', content: question, groupId });

    const labels = seatLabels(opts.members);
    const memberPrompt = prior.length
      ? `Earlier in this conversation:\n\n${renderTranscript(prior)}\n\nNew question:\n\n${question}`
      : question;

    // Each member on its own stop, joined with the round's (Stop): a skip ends one member only.
    const stops = opts.members.map(() => new AbortController());
    const skipped = new Map<number, string>();
    const finished = new Set<number>();
    const skip = (index: number, reason: string) => {
      if (index < 0 || index >= opts.members.length) return;
      if (finished.has(index) || skipped.has(index)) return;
      skipped.set(index, reason);
      stops[index]!.abort();
      opts.onEvent?.({
        phase: 'skipped',
        index,
        label: labels[index]!,
        seat: opts.members[index]!,
        reason,
      });
    };
    const mergeNow = (reason = 'Skipped so the answers could merge') => {
      opts.members.forEach((_, i) => skip(i, reason));
    };
    opts.control?.attach(skip, mergeNow);
    const waitLimit =
      opts.maxWaitMs !== undefined
        ? setTimeout(
            () =>
              mergeNow(`Skipped after ${Math.max(1, Math.round(opts.maxWaitMs! / 60_000))} min`),
            opts.maxWaitMs,
          )
        : undefined;

    let results: RunResult[];
    try {
      results = await Promise.all(
        opts.members.map((seat, index) =>
          this.run(
            seat,
            memberPrompt,
            opts,
            (event) => {
              // Finished the moment it says so: a skip pressed just after can't undo an answer.
              if (event.type === 'done') finished.add(index);
              opts.onEvent?.({ phase: 'member', index, label: labels[index]!, seat, event });
            },
            stops[index]!.signal,
          ).then((result) => {
            finished.add(index);
            return result;
          }),
        ),
      );
    } finally {
      if (waitLimit) clearTimeout(waitLimit);
      opts.control?.detach();
    }

    const stopped = opts.signal?.aborted === true;
    const answers: CouncilAnswer[] = opts.members.map((seat, i) => {
      const result = results[i]!;
      const outcome: MessageOutcome = skipped.has(i)
        ? 'skipped'
        : result.ok
          ? 'answered'
          : stopped
            ? 'stopped'
            : 'failed';
      recordUsage(store, { seat, role: 'chat', source: 'council', refId: thread.id }, result);
      const message = store.addMessage(thread.id, {
        role: 'assistant',
        kind: 'council_answer',
        provider: seat.provider,
        model: result.model ?? seat.model ?? null,
        effort: seat.effort ?? null,
        // A skipped or stopped member keeps what it had written so far (shown folded).
        content: result.text,
        ok: outcome === 'answered',
        error:
          outcome === 'answered'
            ? null
            : outcome === 'skipped'
              ? skipped.get(i)!
              : outcome === 'stopped'
                ? 'Stopped by you'
                : failure(result),
        usage: result.usage,
        durationMs: result.durationMs,
        groupId,
        outcome,
      });
      return { seat, label: labels[i]!, message, result, outcome };
    });

    const good = answers.filter((a) => a.outcome === 'answered' && a.result.text.trim());
    const skippedNote = answers
      .filter((a) => a.outcome === 'skipped')
      .map((a) => a.label)
      .join(', ');
    let merged: Message;
    let mergedBy: CouncilResult['mergedBy'];

    if (stopped) {
      // Stop keeps what came back, and merges nothing (C1).
      mergedBy = 'none';
      merged = store.addMessage(thread.id, {
        role: 'assistant',
        kind: 'council_merged',
        content: '',
        ok: false,
        error: 'Stopped before merging',
        groupId,
        outcome: 'stopped',
      });
    } else if (good.length === 0) {
      mergedBy = 'none';
      merged = store.addMessage(thread.id, {
        role: 'assistant',
        kind: 'council_merged',
        content: '',
        ok: false,
        error: skippedNote
          ? 'No member answered: every one was skipped or failed'
          : 'No council member answered',
        groupId,
        outcome: 'failed',
      });
    } else if (good.length === 1) {
      mergedBy = 'single-answer';
      const only = good[0]!;
      merged = store.addMessage(thread.id, {
        role: 'assistant',
        kind: 'council_merged',
        provider: only.seat.provider,
        model: only.message.model,
        content: only.result.text,
        groupId,
        outcome: 'answered',
        ...(skippedNote && { error: `Only ${only.label} answered; skipped: ${skippedNote}` }),
      });
    } else {
      mergedBy = 'synthesizer';
      const label = 'Synthesizer';
      // The chosen merger first; if it fails or is at its limit, the next member that answered
      // merges instead (C2).
      const mergers = [
        synthesizer,
        ...good.map((a) => a.seat).filter((s) => s.provider !== synthesizer.provider),
      ];
      let result: RunResult | undefined;
      let by = synthesizer;
      for (const seat of mergers) {
        by = seat;
        result = await this.run(seat, synthesisPrompt(question, good, prior), opts, (event) =>
          opts.onEvent?.({ phase: 'synthesis', label, seat, event }),
        );
        recordUsage(
          store,
          { seat, role: 'synthesizer', source: 'council', refId: thread.id },
          result,
        );
        if (result.ok && result.text.trim()) break;
        if (opts.signal?.aborted) break;
      }
      const fellBack = by.provider !== synthesizer.provider;
      merged = store.addMessage(thread.id, {
        role: 'assistant',
        kind: 'council_merged',
        provider: by.provider,
        model: result!.model ?? by.model ?? null,
        effort: by.effort ?? null,
        content: result!.text,
        ok: result!.ok,
        error: result!.ok
          ? fellBack
            ? `Merged by ${labels[opts.members.findIndex((m) => m.provider === by.provider)] ?? by.provider}: the chosen merger couldn’t`
            : null
          : opts.signal?.aborted
            ? 'Stopped before merging'
            : failure(result!),
        usage: result!.usage,
        durationMs: result!.durationMs,
        groupId,
        outcome: result!.ok ? 'answered' : opts.signal?.aborted ? 'stopped' : 'failed',
      });
    }

    return {
      thread: store.getThread(thread.id)!,
      groupId,
      question: questionMsg,
      answers,
      merged,
      mergedBy,
    };
  }

  private run(
    seat: Seat,
    prompt: string,
    opts: CouncilOptions,
    onEvent: (event: AgentEvent) => void,
    own?: AbortSignal,
  ): Promise<RunResult> {
    const adapter = this.ctx.adapters.get(seat.provider)!;
    const signal = own && opts.signal ? AbortSignal.any([own, opts.signal]) : (own ?? opts.signal);
    return collect(
      adapter.run({
        prompt,
        cwd: this.ctx.cwd ?? homedir(),
        role: 'chat',
        readOnly: true,
        timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        ...seatOptions(seat, this.ctx.store.settings),
        ...(signal && { signal }),
      }),
      onEvent,
    );
  }
}

function failure(result: RunResult): string {
  return result.rateLimited?.message ?? result.errors[0] ?? 'No answer';
}

export function synthesisPrompt(
  question: string,
  answers: { label: string; result: RunResult }[],
  prior: Message[] = [],
): string {
  const names = answers.map((a) => a.label).join(', ');
  return [
    `You are the synthesizer for a council of AI assistants (${names}). Each answered the same question independently. Write the single best answer for the user.`,
    '',
    'Rules:',
    '- Merge the strongest points into one answer. Do not list the answers one after another.',
    `- Cite which members support each claim in square brackets, like [${answers[0]!.label}] or [${answers
      .slice(0, 2)
      .map((a) => a.label)
      .join(', ')}].`,
    '- Where members disagree, say so plainly, and say which view is better supported and why.',
    '- Do not add facts no member stated unless you mark them [Synthesizer].',
    '- End with two short sections titled exactly "Where they agree" and "Where they differ". Write "Nothing significant" if a section is empty.',
    '',
    ...(prior.length ? ['Earlier in this conversation:', '', renderTranscript(prior), ''] : []),
    'Question:',
    '',
    question,
    '',
    'Answers:',
    '',
    ...answers.flatMap((a) => [`=== ${a.label} ===`, a.result.text.trim(), '']),
  ].join('\n');
}
