import type { Message, ProviderId, Seat } from '@conclave/shared';

const SHORT_NAMES: Record<ProviderId, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  fake: 'Fake',
};

/** Keep replayed history well under every CLI's context and stdin limits. */
export const MAX_TRANSCRIPT_CHARS = 60_000;

export function seatLabel(seat: Seat): string {
  return SHORT_NAMES[seat.provider] + (seat.model ? ` (${seat.model})` : '');
}

/** Labels for a set of seats; the model is only shown when a provider appears more than once. */
export function seatLabels(seats: Seat[]): string[] {
  const counts = new Map<ProviderId, number>();
  for (const s of seats) counts.set(s.provider, (counts.get(s.provider) ?? 0) + 1);
  const labels = seats.map((s) =>
    (counts.get(s.provider) ?? 0) > 1 ? seatLabel(s) : SHORT_NAMES[s.provider],
  );
  const seen = new Map<string, number>();
  return labels.map((label) => {
    const n = (seen.get(label) ?? 0) + 1;
    seen.set(label, n);
    return n > 1 ? `${label} #${n}` : label;
  });
}

function speaker(m: Message): string {
  if (m.role === 'user') return 'User';
  const who = m.provider
    ? seatLabel({ provider: m.provider, ...(m.model && { model: m.model }) })
    : 'Assistant';
  if (m.kind === 'council_merged') return `Council (merged by ${who})`;
  if (m.kind === 'council_answer') return `Council member ${who}`;
  return who;
}

/**
 * Render messages as a plain transcript. Failed replies are skipped; the
 * oldest turns are dropped first when the transcript is too long.
 */
export function renderTranscript(messages: Message[], maxChars = MAX_TRANSCRIPT_CHARS): string {
  const blocks = messages
    .filter((m) => m.ok && m.content.trim())
    .map((m) => `${speaker(m)}:\n${m.content.trim()}`);
  const kept: string[] = [];
  let size = 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]!;
    if (size + block.length > maxChars && kept.length > 0) {
      kept.unshift(`[${i + 1} earlier message${i === 0 ? '' : 's'} omitted]`);
      break;
    }
    kept.unshift(block);
    size += block.length + 2;
  }
  return kept.join('\n\n');
}

/**
 * The prompt for the next reply in a chat thread.
 *
 * `sinceSeq` is the last message the provider's own CLI session has already
 * seen (when we can resume it): only newer messages are replayed. Without a
 * session the whole history is replayed, which is what lets a chat switch
 * model or provider mid-conversation and keep its context.
 */
export function buildChatPrompt(history: Message[], text: string, sinceSeq?: number): string {
  if (sinceSeq !== undefined) {
    const missed = history.filter((m) => m.seq > sinceSeq);
    if (missed.length === 0) return text;
    return [
      'Other assistants took part in this conversation since your last reply. Here is what you missed:',
      '',
      renderTranscript(missed),
      '',
      'Now reply to the latest user message:',
      '',
      text,
    ].join('\n');
  }
  if (history.length === 0) return text;
  return [
    'You are continuing a conversation. Earlier replies may have come from other AI assistants. Transcript so far:',
    '',
    renderTranscript(history),
    '',
    'Reply to the latest user message:',
    '',
    text,
  ].join('\n');
}
