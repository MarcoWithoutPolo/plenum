import type { AgentEvent, Usage } from '@conclave/shared';

export interface RunResult {
  ok: boolean;
  text: string;
  sessionId?: string;
  model?: string;
  /** What ran it, when the adapter says (local models: "ollama" or "opencode"). */
  engine?: string;
  usage: Usage;
  rateLimited?: { message: string; resetsAt?: number };
  /** Stopped by the brain's watchdog: no event for longer than the CLI's quiet window. */
  stalled?: boolean;
  quotas: { window: string; utilization?: number; resetsAt?: number }[];
  errors: string[];
  durationMs: number;
  events: AgentEvent[];
}

/** Drain an adapter run into a single result, optionally observing each event as it arrives. */
/** Word-by-word events a run keeps in its result (the text itself is always whole). */
const MAX_DELTAS = 2_000;

export async function collect(
  stream: AsyncIterable<AgentEvent>,
  onEvent?: (event: AgentEvent) => void,
): Promise<RunResult> {
  const result: RunResult = {
    ok: false,
    text: '',
    usage: {},
    quotas: [],
    errors: [],
    durationMs: 0,
    events: [],
  };
  let deltas = '';
  let kept = 0;
  for await (const event of stream) {
    // Every event, but at most the first 2,000 word-by-word pieces: a long run streams them by
    // the ten thousand, and the text is assembled below anyway (E15).
    if (event.type !== 'message.delta' || ++kept <= MAX_DELTAS) result.events.push(event);
    onEvent?.(event);
    switch (event.type) {
      case 'session':
        result.sessionId = event.sessionId;
        if (event.model) result.model = event.model;
        if (event.engine) result.engine = event.engine;
        break;
      case 'message.delta':
        deltas += event.text;
        break;
      case 'message.done':
        result.text = event.text;
        break;
      case 'usage':
        result.usage = mergeUsage(result.usage, event.usage);
        break;
      case 'quota': {
        const { window, utilization, resetsAt } = event;
        result.quotas.push({
          window,
          ...(utilization !== undefined && { utilization }),
          ...(resetsAt !== undefined && { resetsAt }),
        });
        break;
      }
      case 'rate_limit':
        result.rateLimited = {
          message: event.message,
          ...(event.resetsAt !== undefined && { resetsAt: event.resetsAt }),
        };
        break;
      case 'error':
        result.errors.push(event.message);
        break;
      case 'done':
        result.ok = event.ok;
        result.durationMs = event.durationMs;
        break;
    }
  }
  if (!result.text) result.text = deltas;
  return result;
}

function mergeUsage(a: Usage, b: Usage): Usage {
  const sum = (x?: number, y?: number) =>
    x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0);
  const out: Usage = {};
  for (const key of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'costUsd'] as const) {
    const v = sum(a[key], b[key]);
    if (v !== undefined) out[key] = v;
  }
  return out;
}
