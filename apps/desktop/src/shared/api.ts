import type {
  AgentEvent,
  Message,
  ProviderId,
  ProviderStatus,
  Seat,
  Thread,
} from '@conclave/shared';

/** What the Accounts screen and model pickers need to know about each provider. */
export interface ProviderInfo extends ProviderStatus {
  displayName: string;
  /** Models to offer, best first. Codex reads these from its own cache of what your plan allows. */
  models: { id: string; label?: string; efforts?: string[]; defaultEffort?: string }[];
  /** Effort levels when the model has no list of its own. */
  efforts?: string[];
  /** What "Default" resolves to: the model the CLI is configured with, when known. */
  defaultModel?: string;
  defaultEffort?: string;
  /** npm package of the official CLI, for one-click install. */
  installPackage?: string;
  loginHint: string;
}

export interface QuotaInfo {
  provider: ProviderId;
  window: string;
  utilization: number | null;
  resetsAt: number | null;
  at: number;
}

export interface ThreadDetail {
  thread: Thread;
  messages: Message[];
}

export interface CouncilAnswerInfo {
  seat: Seat;
  label: string;
  message: Message;
}

export interface CouncilRoundResult {
  thread: Thread;
  groupId: string;
  answers: CouncilAnswerInfo[];
  merged: Message;
  mergedBy: 'synthesizer' | 'single-answer' | 'none';
}

/** Streamed to the renderer while a chat reply or council round runs. */
export type RunUpdate =
  | { requestId: string; kind: 'chat'; event: AgentEvent }
  | {
      requestId: string;
      kind: 'member';
      index: number;
      label: string;
      seat: Seat;
      event: AgentEvent;
    }
  | { requestId: string; kind: 'synthesis'; seat: Seat; event: AgentEvent };

export interface InstallLog {
  provider: ProviderId;
  text: string;
}

/** The whole surface the renderer may call. Exposed as window.conclave by the preload. */
export interface ConclaveApi {
  accounts: {
    list(): Promise<ProviderInfo[]>;
    /** Opens the provider's official sign-in in a terminal window. */
    signIn(provider: ProviderId): Promise<{ opened: boolean; error?: string }>;
    /** Installs the official CLI with npm after the user confirms in a native dialog. */
    install(provider: ProviderId): Promise<{ ok: boolean; cancelled?: boolean; error?: string }>;
    quotas(): Promise<QuotaInfo[]>;
  };
  threads: {
    list(): Promise<Thread[]>;
    get(id: string): Promise<ThreadDetail | null>;
    rename(id: string, title: string): Promise<Thread | null>;
    remove(id: string): Promise<boolean>;
  };
  chat: {
    create(seat: Seat): Promise<Thread>;
    send(input: {
      requestId: string;
      threadId: string;
      text: string;
      seat: Seat;
    }): Promise<{ thread: Thread; user: Message; reply: Message }>;
  };
  council: {
    ask(input: {
      requestId: string;
      question: string;
      members: Seat[];
      synthesizer: Seat;
      threadId?: string;
    }): Promise<CouncilRoundResult>;
  };
  runs: {
    cancel(requestId: string): Promise<void>;
    onUpdate(listener: (update: RunUpdate) => void): () => void;
  };
  onInstallLog(listener: (log: InstallLog) => void): () => void;
  openExternal(url: string): Promise<void>;
  platform: NodeJS.Platform;
}

export const IPC = {
  accountsList: 'accounts:list',
  accountsSignIn: 'accounts:sign-in',
  accountsInstall: 'accounts:install',
  accountsQuotas: 'accounts:quotas',
  threadsList: 'threads:list',
  threadsGet: 'threads:get',
  threadsRename: 'threads:rename',
  threadsRemove: 'threads:remove',
  chatCreate: 'chat:create',
  chatSend: 'chat:send',
  councilAsk: 'council:ask',
  runsCancel: 'runs:cancel',
  runUpdate: 'runs:update',
  installLog: 'accounts:install-log',
  openExternal: 'app:open-external',
} as const;
