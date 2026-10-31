import type { AgentEvent, ProviderId, ProviderStatus } from '@conclave/shared';
import type { Adapter, Capabilities, LoginCommand, ModelList, RunRequest } from './types.js';

export interface FakeScript {
  /** Text the fake model answers with; split into deltas word by word. */
  reply: string | ((request: RunRequest) => string);
  /** Pretend the provider hit its usage limit instead of answering. */
  rateLimited?: { message: string; resetsAt?: number };
  /** Fail with this error instead of answering. */
  fail?: string;
  /** Decide per request whether to fail, and with what error. */
  failWhen?: (request: RunRequest) => string | undefined;
  /** Side effects before replying, like a builder editing files in request.cwd. */
  act?: (request: RunRequest) => void | Promise<void>;
  /** Decide per request whether to hit a usage limit. */
  limitWhen?: (request: RunRequest) => { message: string; resetsAt?: number } | undefined;
  delayMs?: number;
}

export interface FakeOptions {
  /** Impersonate a real provider id, so tests can build multi-provider councils. */
  id?: ProviderId;
  displayName?: string;
  /** Advertise session resume (sessions are only remembered, not replayed). */
  resume?: boolean;
  /** Reasoning effort levels to advertise. */
  efforts?: string[];
  /** Report these from models(), like a CLI that knows the plan's models. */
  models?: ModelList;
  /** Report these from limits(), like a CLI that logs plan usage. */
  limits?: { window: string; utilization: number; resetsAt?: number }[];
  /** What it can see (default: image files). */
  vision?: 'native' | 'files' | 'none';
  /** Advertise a stall window (the brain's watchdog). */
  quietMs?: number;
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
  readonly models?: () => Promise<ModelList>;
  readonly limits?: () => Promise<{ window: string; utilization: number; resetsAt?: number }[]>;

  private readonly status: Partial<Omit<ProviderStatus, 'provider'>>;

  constructor(
    private readonly script: FakeScript,
    opts: FakeOptions = {},
  ) {
    this.status = opts.status ?? {};
    const { models, limits } = opts;
    if (models) this.models = async () => models;
    if (limits) this.limits = async () => limits;
    this.id = opts.id ?? 'fake';
    this.displayName = opts.displayName ?? 'Fake';
    this.capabilities = {
      models: ['fake-1'],
      defaultModel: 'fake-1',
      readOnly: true,
      resume: opts.resume ?? false,
      streaming: true,
      vision: opts.vision ?? 'files',
      ...(opts.efforts && { efforts: opts.efforts }),
      ...(opts.quietMs && { quietMs: opts.quietMs }),
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

    const limited = this.script.rateLimited ?? this.script.limitWhen?.(request);
    if (limited) {
      yield { ...ev, at: Date.now(), type: 'rate_limit', ...limited };
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

    const failure = this.script.fail ?? this.script.failWhen?.(request);
    if (failure) {
      yield { ...ev, at: Date.now(), type: 'error', message: failure };
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

    await this.script.act?.(request);
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
