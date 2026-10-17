import type { AgentEvent, ProviderId, ProviderStatus, Role } from '@conclave/shared';

export interface RunRequest {
  /** The prompt, already including any replayed history the caller wants the model to see. */
  prompt: string;
  /** Working directory the CLI runs in. Agents may only write inside it. */
  cwd: string;
  model?: string;
  role?: Role;
  /** When true the adapter asks its CLI for a no-write, no-shell mode. */
  readOnly?: boolean;
  /** Resume an earlier CLI session, when the provider supports it. */
  sessionId?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface Capabilities {
  models: string[];
  defaultModel?: string;
  readOnly: boolean;
  resume: boolean;
  streaming: boolean;
}

/** How to start the provider's own sign-in flow (run in a real terminal so the CLI can open a browser). */
export interface LoginCommand {
  command: string;
  args: string[];
  hint: string;
}

/**
 * One AI tool behind a fixed boundary. Conclave never handles credentials:
 * each adapter drives the official CLI the user has installed and signed in to.
 */
export interface Adapter {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly capabilities: Capabilities;
  detect(): Promise<ProviderStatus>;
  login(): LoginCommand;
  run(request: RunRequest): AsyncIterable<AgentEvent>;
  /** Models available to the signed-in account, when the CLI can tell. Falls back to capabilities. */
  models?(): Promise<ModelList>;
  /** Current plan usage without spending a request, when the CLI records it. */
  limits?(): Promise<{ window: string; utilization: number; resetsAt?: number }[]>;
}

export interface ModelList {
  models: { id: string; label?: string }[];
  /** What "Default" means right now (the CLI's configured model). */
  defaultModel?: string;
  defaultEffort?: string;
}
