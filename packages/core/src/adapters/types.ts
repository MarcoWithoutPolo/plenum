import type { AgentEvent, ProviderId, ProviderStatus, Role } from '@conclave/shared';
import type { RunPermissions } from './permissions.js';

export interface RunRequest {
  /** The prompt, already including any replayed history the caller wants the model to see. */
  prompt: string;
  /** Working directory the CLI runs in. Agents may only write inside it. */
  cwd: string;
  model?: string;
  /** Reasoning effort, one of capabilities.efforts (or the model's own list). */
  effort?: string;
  role?: Role;
  /** When true the adapter asks its CLI for a no-write, no-shell mode. */
  readOnly?: boolean;
  /** For writing roles: how much the agent may do. Omitted means level 2 (edit files, offline). */
  permissions?: RunPermissions;
  /** Resume an earlier CLI session, when the provider supports it. */
  sessionId?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface Capabilities {
  models: string[];
  defaultModel?: string;
  /** Reasoning effort levels the CLI accepts; per-model lists come from models(). */
  efforts?: string[];
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
  /**
   * Can this CLI enforce these permissions? Returns why not, so the team editor can explain
   * and the brain can skip the seat. Omitted means every level is enforceable.
   */
  permissionGap?(permissions: RunPermissions): string | undefined;
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

export interface ModelOption {
  id: string;
  label?: string;
  /** One line on what the model is for, when the CLI provides it. */
  description?: string;
  efforts?: string[];
  defaultEffort?: string;
}

export interface ModelList {
  models: ModelOption[];
  /** What "Default" means right now (the CLI's configured model). */
  defaultModel?: string;
  defaultEffort?: string;
}
