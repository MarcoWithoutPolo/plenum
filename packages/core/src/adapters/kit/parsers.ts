import type { Usage } from '@conclave/shared';
import { limitResetsAt, looksLikeLimit } from './limits.js';
import type { EventBody, LineParser } from './run.js';
import { isRecord, str } from './values.js';

/** An error event, or a usage-limit event when the message reads like one. */
export function failure(message: string): EventBody {
  if (!looksLikeLimit(message)) return { type: 'error', message };
  const resetsAt = limitResetsAt(message);
  return { type: 'rate_limit', message, ...(resetsAt && { resetsAt }) };
}

/**
 * Base for CLIs that print one JSON object per line with a type field (Grok Build, Copilot,
 * OpenCode). Subclasses handle the types they care about in on(); everything else is ignored,
 * so new event types in a CLI update never break a run.
 */
export abstract class TypedEventParser implements LineParser {
  failed = false;
  /** The answer so far, from delta(). */
  protected answer = '';

  constructor(private readonly key = 'type') {}

  parse(message: unknown): EventBody[] {
    if (!isRecord(message)) return [];
    const type = str(message[this.key]);
    return type ? this.on(type, message) : [];
  }

  protected abstract on(type: string, message: Record<string, unknown>): EventBody[];

  protected delta(text: string | undefined): EventBody[] {
    if (!text) return [];
    this.answer += text;
    return [{ type: 'message.delta', text }];
  }

  protected done(text = this.answer): EventBody {
    return { type: 'message.done', text: text.trim() };
  }

  protected usage(usage: Usage): EventBody {
    return { type: 'usage', usage };
  }

  protected fail(message: string): EventBody[] {
    this.failed = true;
    return [failure(message)];
  }
}

/**
 * For a CLI with no JSON output: every stdout line is part of the answer, and the answer is
 * done when the process exits cleanly.
 */
export class WholeTextParser implements LineParser {
  failed = false;
  readonly plainText = true;
  private readonly lines: string[] = [];

  parse(message: unknown): EventBody[] {
    const line = typeof message === 'string' ? message : JSON.stringify(message);
    const delta = this.lines.length ? `\n${line}` : line;
    this.lines.push(line);
    return [{ type: 'message.delta', text: delta }];
  }

  finish(ok: boolean): EventBody[] {
    return ok ? [{ type: 'message.done', text: this.lines.join('\n').trim() }] : [];
  }
}
