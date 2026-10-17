import type { AgentEvent, ProviderId, ProviderStatus } from '@conclave/shared';
import type { Adapter, Capabilities, LoginCommand, RunRequest } from './types.js';

export interface FakeScript {
  /** Text the fake model answers with; split into deltas word by word. */
  reply: string | ((request: RunRequest) => string);
  /** Pretend the provider hit its usage limit instead of answering. */
  rateLimited?: { message: string; resetsAt?: number };
  /** Fail with this error instead of answering. */
  fail?: string;
  delayMs?: number;
}

export interface FakeOptions {
  /** Impersonate a real provider id, so tests can build multi-provider councils. */
  id?: ProviderId;
  displayName?: string;
  /** Advertise session resume (sessions are only remembered, not replayed). */
  resume?: boolean;
  /** Override what detect() reports, e.g. to show a signed-out provider. */
  status?: Partial<Omit<ProviderStatus, 'provider'>>;
}

let runCounter = 0;

/** A deterministic adapter for tests and demos: costs nothing, needs no CLI. */
export class FakeAdapter implements Adapter {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly capabilities: Capabilities;
  /** Every request this adapter received, for assertions. */
  readonly requests: RunRequest[] = [];

  private readonly status: Partial<Omit<ProviderStatus, 'provider'>>;

  constructor(
    private readonly script: FakeScript,
    opts: FakeOptions = {},
  ) {
    this.status = opts.status ?? {};
    this.id = opts.id ?? 'fake';
    this.displayName = opts.displayName ?? 'Fake';
    this.capabilities = {
      models: ['fake-1'],
      defaultModel: 'fake-1',
      readOnly: true,
      resume: opts.resume ?? false,
      streaming: true,
    };
  }

  async detect(): Promise<ProviderStatus> {
    return {
      provider: this.id,
      installed: true,
      version: '1.0.0',
      auth: 'signed_in',
      ...this.status,
    };
  }

  login(): LoginCommand {
    return { command: 'echo', args: ['fake provider needs no login'], hint: 'Nothing to do.' };
  }

  async *run(request: RunRequest): AsyncIterable<AgentEvent> {
    this.requests.push(request);
    const runId = `fake-${++runCounter}`;
    const started = Date.now();
    const ev = { provider: this.id, runId };

    yield {
      ...ev,
      at: Date.now(),
      type: 'session',
      sessionId: request.sessionId ?? runId,
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

    if (this.script.fail) {
      yield { ...ev, at: Date.now(), type: 'error', message: this.script.fail };
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
