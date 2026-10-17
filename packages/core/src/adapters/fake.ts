import type { AgentEvent, ProviderStatus } from '@conclave/shared';
import type { Adapter, Capabilities, LoginCommand, RunRequest } from './types.js';

export interface FakeScript {
  /** Text the fake model answers with; split into deltas word by word. */
  reply: string | ((request: RunRequest) => string);
  /** Pretend the provider hit its usage limit instead of answering. */
  rateLimited?: { message: string; resetsAt?: number };
  delayMs?: number;
}

let runCounter = 0;

/** A deterministic adapter for tests and demos: costs nothing, needs no CLI. */
export class FakeAdapter implements Adapter {
  readonly id = 'fake' as const;
  readonly displayName: string;
  readonly capabilities: Capabilities = {
    models: ['fake-1'],
    defaultModel: 'fake-1',
    readOnly: true,
    resume: false,
    streaming: true,
  };

  constructor(
    private readonly script: FakeScript,
    displayName = 'Fake',
  ) {
    this.displayName = displayName;
  }

  async detect(): Promise<ProviderStatus> {
    return { provider: 'fake', installed: true, version: '1.0.0', auth: 'signed_in' };
  }

  login(): LoginCommand {
    return { command: 'echo', args: ['fake provider needs no login'], hint: 'Nothing to do.' };
  }

  async *run(request: RunRequest): AsyncIterable<AgentEvent> {
    const runId = `fake-${++runCounter}`;
    const started = Date.now();
    const ev = { provider: 'fake' as const, runId };

    yield {
      ...ev,
      at: Date.now(),
      type: 'session',
      sessionId: runId,
      model: request.model ?? 'fake-1',
    };

    if (this.script.rateLimited) {
      yield { ...ev, at: Date.now(), type: 'rate_limit', ...this.script.rateLimited };
      yield {
        ...ev,
        at: Date.now(),
        type: 'done',
        ok: false,
        exitCode: 1,
        durationMs: Date.now() - started,
      };
      return;
    }

    const reply =
      typeof this.script.reply === 'function' ? this.script.reply(request) : this.script.reply;
    const words = reply.split(/(?<=\s)/);
    for (const word of words) {
      if (request.signal?.aborted) {
        yield { ...ev, at: Date.now(), type: 'error', message: 'Cancelled' };
        yield {
          ...ev,
          at: Date.now(),
          type: 'done',
          ok: false,
          exitCode: null,
          durationMs: Date.now() - started,
        };
        return;
      }
      if (this.script.delayMs) await new Promise((r) => setTimeout(r, this.script.delayMs));
      yield { ...ev, at: Date.now(), type: 'message.delta', text: word };
    }
    yield { ...ev, at: Date.now(), type: 'message.done', text: reply };
    yield {
      ...ev,
      at: Date.now(),
      type: 'usage',
      usage: { inputTokens: request.prompt.length, outputTokens: reply.length },
    };
    yield {
      ...ev,
      at: Date.now(),
      type: 'done',
      ok: true,
      exitCode: 0,
      durationMs: Date.now() - started,
    };
  }
}
