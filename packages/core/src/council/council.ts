import { homedir } from 'node:os';
import type { AgentEvent, Message, Seat, Thread } from '@conclave/shared';
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
}

export type CouncilUpdate =
  | { phase: 'member'; index: number; label: string; seat: Seat; event: AgentEvent }
  | { phase: 'synthesis'; label: string; seat: Seat; event: AgentEvent };

export interface CouncilAnswer {
  seat: Seat;
  label: string;
  message: Message;
  result: RunResult;
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

    const results = await Promise.all(
      opts.members.map((seat, index) =>
        this.run(seat, memberPrompt, opts, (event) =>
          opts.onEvent?.({ phase: 'member', index, label: labels[index]!, seat, event }),
        ),
      ),
    );

    const answers: CouncilAnswer[] = opts.members.map((seat, i) => {
      const result = results[i]!;
      recordUsage(store, { seat, role: 'chat', source: 'council', refId: thread.id }, result);
      const message = store.addMessage(thread.id, {
        role: 'assistant',
        kind: 'council_answer',
        provider: seat.provider,
        model: result.model ?? seat.model ?? null,
        effort: seat.effort ?? null,
        content: result.text,
        ok: result.ok,
        error: result.ok ? null : failure(result),
        usage: result.usage,
        durationMs: result.durationMs,
        groupId,
      });
      return { seat, label: labels[i]!, message, result };
    });

    const good = answers.filter((a) => a.result.ok && a.result.text.trim());
    let merged: Message;
    let mergedBy: CouncilResult['mergedBy'];

    if (good.length === 0) {
      mergedBy = 'none';
      merged = store.addMessage(thread.id, {
        role: 'assistant',
        kind: 'council_merged',
        content: '',
        ok: false,
        error: 'No council member answered',
        groupId,
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
      });
    } else {
      mergedBy = 'synthesizer';
      const label = 'Synthesizer';
      const result = await this.run(
        synthesizer,
        synthesisPrompt(question, good, prior),
        opts,
        (event) => opts.onEvent?.({ phase: 'synthesis', label, seat: synthesizer, event }),
      );
      recordUsage(
        store,
        { seat: synthesizer, role: 'synthesizer', source: 'council', refId: thread.id },
        result,
      );
      merged = store.addMessage(thread.id, {
        role: 'assistant',
        kind: 'council_merged',
        provider: synthesizer.provider,
        model: result.model ?? synthesizer.model ?? null,
        effort: synthesizer.effort ?? null,
        content: result.text,
        ok: result.ok,
        error: result.ok ? null : failure(result),
        usage: result.usage,
        durationMs: result.durationMs,
        groupId,
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
  ): Promise<RunResult> {
    const adapter = this.ctx.adapters.get(seat.provider)!;
    return collect(
      adapter.run({
        prompt,
        cwd: this.ctx.cwd ?? homedir(),
        role: 'chat',
        readOnly: true,
        timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        ...seatOptions(seat, this.ctx.store.settings),
        ...(opts.signal && { signal: opts.signal }),
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
  answers: CouncilAnswer[],
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
