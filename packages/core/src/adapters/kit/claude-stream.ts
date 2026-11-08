import type { Usage } from '@plenum/shared';
import { looksLikeLimit } from './limits.js';
import type { EventBody, LineParser } from './run.js';
import { isRecord, str } from './values.js';

/**
 * Base for CLIs that speak Claude Code's stream-json (Claude Code itself, Cursor's agent):
 * a `system`/`init` line with the session, `assistant` messages, and one `result` line with
 * the answer, the usage and whether it failed. Subclasses read their own message and usage
 * shapes; the session and the result's success or failure are the same for all.
 */
export abstract class ClaudeStreamParser implements LineParser {
  failed = false;
  /** How the CLI is named in "<name> stopped: <reason>". */
  protected abstract readonly cliName: string;

  parse(message: unknown): EventBody[] {
    if (!isRecord(message)) return [];
    // Ignore subagent traffic; only the main conversation is the answer.
    if (message.parent_tool_use_id) return [];
    if (message.type === 'system') {
      if (message.subtype !== 'init' || !str(message.session_id)) return [];
      const model = str(message.model);
      return [{ type: 'session', sessionId: str(message.session_id)!, ...(model && { model }) }];
    }
    if (message.type === 'result') return this.result(message);
    return this.event(message);
  }

  /** Every line other than init and result. */
  protected abstract event(message: Record<string, unknown>): EventBody[];

  /** The result line's token counts, in Plenum's convention (see tokenUsage). */
  protected abstract usage(result: Record<string, unknown>): Usage;

  private result(message: Record<string, unknown>): EventBody[] {
    const out: EventBody[] = [{ type: 'usage', usage: this.usage(message) }];
    const text = str(message.result) ?? '';
    if (
      message.is_error === true ||
      (message.subtype !== undefined && message.subtype !== 'success')
    ) {
      this.failed = true;
      const reason = text || `${this.cliName} stopped: ${String(message.subtype)}`;
      out.push({ type: looksLikeLimit(reason) ? 'rate_limit' : 'error', message: reason });
    } else {
      out.push({ type: 'message.done', text });
    }
    return out;
  }
}
