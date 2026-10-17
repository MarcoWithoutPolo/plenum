import { styleText } from 'node:util';
import type { Message, Seat, Thread, Usage } from '@conclave/shared';
import { seatLabel } from '@conclave/core';

const color = process.stdout.isTTY && !process.env.NO_COLOR;
type Style = Parameters<typeof styleText>[0];
export const paint = (style: Style, text: string) => (color ? styleText(style, text) : text);
export const dim = (t: string) => paint('dim', t);
export const bold = (t: string) => paint('bold', t);

export function seatName(seat: Seat): string {
  return seatLabel(seat);
}

export function stats(durationMs: number | null, usage: Usage | null): string {
  const parts: string[] = [];
  if (durationMs !== null) parts.push(`${(durationMs / 1000).toFixed(1)}s`);
  const tokens = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
  if (tokens) parts.push(`${tokens.toLocaleString()} tokens`);
  if (usage?.costUsd) parts.push(`$${usage.costUsd.toFixed(4)} list price`);
  return parts.join(' · ');
}

export function heading(text: string): string {
  return bold(`── ${text} ${'─'.repeat(Math.max(2, 60 - text.length))}`);
}

export function shortId(id: string): string {
  return id.slice(0, 12);
}

export function age(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function threadLine(t: Thread): string {
  const who =
    t.mode === 'council'
      ? 'council'
      : seatName({ provider: t.provider, ...(t.model && { model: t.model }) });
  return `${shortId(t.id)}  ${t.title.padEnd(44).slice(0, 44)}  ${who.padEnd(18)} ${dim(age(t.updatedAt))}`;
}

export function messageBlock(m: Message): string {
  const who =
    m.role === 'user'
      ? 'You'
      : `${m.kind === 'council_merged' ? 'Merged · ' : m.kind === 'council_answer' ? 'Member · ' : ''}${
          m.provider
            ? seatName({ provider: m.provider, ...(m.model && { model: m.model }) })
            : 'Council'
        }`;
  const body = m.ok ? m.content : paint('red', `Failed: ${m.error ?? 'no reply'}`);
  const meta = m.role === 'assistant' ? dim(`  ${stats(m.durationMs, m.usage)}`) : '';
  return `${bold(who)}${meta}\n${body}`;
}
