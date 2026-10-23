import type {
  AgentRun,
  ClarifyResult,
  DailyActivity,
  DraftStart,
  FolderState,
  GhCheck,
  GhIssue,
  GhRepo,
  GitHubStatus,
  GitSetup,
  ModelOption,
  ProviderTotals,
  PullRequestStatus,
  RetryOptions,
} from '@conclave/core';
import type {
  AgentEvent,
  Approval,
  AskPolicy,
  BrainEvent,
  FailureKind,
  GitHubLink,
  Permissions,
  Project,
  ProjectDecision,
  RetryStrategy,
  Routing,
  Task,
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
  models: ModelOption[];
  /** Effort levels when the model has no list of its own. */
  efforts?: string[];
  /** What "Default" resolves to: the model the CLI is configured with, when known. */
  defaultModel?: string;
  defaultEffort?: string;
  /** Set while the provider is out of usage: its last limit message and when. */
  limit?: { message: string; at: number };
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

export interface ProjectCounts {
  queued: number;
  active: number;
  merged: number;
  failed: number;
  total: number;
}

export interface ProjectSummary {
  project: Project;
  /** A brain is working on it right now (in this app or a terminal). */
  running: boolean;
  counts: ProjectCounts;
  pendingApprovals: number;
  lastEvent: BrainEvent | null;
}

export interface ProjectDetail {
  project: Project;
  running: boolean;
  tasks: Task[];
  events: BrainEvent[];
  approvals: Approval[];
  decisions: ProjectDecision[];
  /** One AI causing repeated failures: drives the "Retry all with…" banner. */
  problems: ProviderProblem[];
  /** AIs on this team that are out of usage right now (limits never fail tasks). */
  limits: LimitNotice[];
}

export interface LimitNotice {
  provider: ProviderId;
  message: string;
  at: number;
}

export interface ProviderProblem {
  provider: ProviderId;
  kind: FailureKind;
  summary: string;
  taskIds: string[];
}

/** Why each provider can't work at a permission level (absent when it can). */
export type PermissionGaps = Partial<Record<ProviderId, string>>;

export interface RepoInfo {
  path: string;
  ok: boolean;
  error?: string;
  root?: string;
  name?: string;
  branch?: string;
  /** A test command guessed from the repo (package.json, Cargo.toml, ...). */
  suggestedTest?: string;
}

export interface NewProjectInput {
  repoPath: string;
  goal: string;
  name?: string;
  doneWhen?: string;
  testCommand?: string;
  routing?: Partial<Routing>;
  maxAttempts?: number;
  retryStrategy?: RetryStrategy;
  askPolicy?: AskPolicy;
  permissions?: Permissions;
  designDirection?: string;
  /** Saved as a draft for the clarify step. */
  draft?: boolean;
  github?: GitHubLink;
}

/** What can change on an existing project. Applies from the next step. */
export interface ProjectSettings {
  name?: string;
  goal?: string;
  doneWhen?: string | null;
  testCommand?: string | null;
  designDirection?: string | null;
  routing?: Routing;
  maxAttempts?: number;
  retryStrategy?: RetryStrategy;
  askPolicy?: AskPolicy;
  permissions?: Permissions;
}

export interface DecideOptions {
  /** A reply to a question, or a note on an install/network request. */
  answer?: string;
  /** For a finished project: merge here, or open (or update) a pull request. */
  via?: 'merge' | 'pr';
  draft?: boolean;
}

export interface ApprovalItem {
  approval: Approval;
  project: Project;
}

export interface UsageReport {
  day: ProviderTotals[];
  week: ProviderTotals[];
  daily: DailyActivity[];
  recent: AgentRun[];
  quotas: QuotaInfo[];
}

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
  projects: {
    list(): Promise<ProjectSummary[]>;
    get(id: string): Promise<ProjectDetail | null>;
    /** Native folder picker; resolves to null when cancelled. */
    pickRepo(): Promise<string | null>;
    inspectRepo(path: string): Promise<RepoInfo>;
    inspectFolder(path: string): Promise<FolderState>;
    setUpGit(path: string, confirmLarge?: boolean): Promise<GitSetup>;
    /** Make a new empty folder under `parent` (default: Documents/Conclave Projects). */
    createFolder(name: string, parent?: string): Promise<string>;
    defaultFolder(): Promise<string>;
    create(input: NewProjectInput): Promise<Project>;
    update(id: string, settings: ProjectSettings): Promise<Project>;
    /** One read-only planner pass: questions, a draft plan, a test command. */
    /** With answers: "Re-plan with my answers", the draft plan redone around them. */
    clarify(id: string, answers?: { question: string; answer: string }[]): Promise<ClarifyResult>;
    startDraft(id: string, input: DraftStart): Promise<Project>;
    retry(taskId: string, opts?: RetryOptions): Promise<Task>;
    skip(taskId: string): Promise<Task>;
    retryFailed(
      projectId: string,
      filter: { provider?: ProviderId; kind?: FailureKind },
      opts?: RetryOptions,
    ): Promise<Task[]>;
    permissionGaps(permissions: Permissions): Promise<PermissionGaps>;
    start(id: string): Promise<void>;
    stop(id: string): Promise<void>;
    remove(id: string): Promise<void>;
    taskChanges(taskId: string): Promise<string>;
    /** Every brain event, as it happens, for every project. */
    onEvent(listener: (event: BrainEvent) => void): () => void;
  };
  decisions: {
    add(projectId: string, question: string, answer: string): Promise<ProjectDecision>;
    /** Promote an assumption to a decision. */
    keep(id: string): Promise<ProjectDecision | null>;
    /** New answer; the old one stays as overturned history. Optionally queue a task to apply it. */
    change(id: string, answer: string, addTask?: boolean): Promise<ProjectDecision | null>;
  };
  /** Questions, permission requests and approvals: the Inbox. */
  approvals: {
    list(): Promise<ApprovalItem[]>;
    decide(
      id: string,
      decision: 'approved' | 'rejected',
      opts?: DecideOptions,
    ): Promise<{ ok: boolean; error?: string; url?: string }>;
  };
  github: {
    status(): Promise<GitHubStatus>;
    signIn(): Promise<{ opened: boolean; error?: string }>;
    repos(owner?: string): Promise<GhRepo[]>;
    /** Clone into the projects folder; resolves to the new folder. */
    clone(repo: string, parent?: string): Promise<string>;
    issues(repoPath: string): Promise<GhIssue[]>;
    prStatus(projectId: string): Promise<PullRequestStatus | null>;
    fixCheck(projectId: string, check: GhCheck): Promise<Task>;
    publish(projectId: string, input: { name: string; private: boolean }): Promise<Approval>;
  };
  usage: {
    report(): Promise<UsageReport>;
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
  projectsList: 'projects:list',
  projectsGet: 'projects:get',
  projectsPickRepo: 'projects:pick-repo',
  projectsInspectRepo: 'projects:inspect-repo',
  projectsCreate: 'projects:create',
  projectsStart: 'projects:start',
  projectsStop: 'projects:stop',
  projectsRemove: 'projects:remove',
  projectsTaskChanges: 'projects:task-changes',
  projectsEvent: 'projects:event',
  projectsInspectFolder: 'projects:inspect-folder',
  projectsSetUpGit: 'projects:set-up-git',
  projectsCreateFolder: 'projects:create-folder',
  projectsDefaultFolder: 'projects:default-folder',
  projectsUpdate: 'projects:update',
  projectsClarify: 'projects:clarify',
  projectsStartDraft: 'projects:start-draft',
  projectsRetry: 'projects:retry',
  projectsSkip: 'projects:skip',
  projectsRetryFailed: 'projects:retry-failed',
  projectsPermissionGaps: 'projects:permission-gaps',
  decisionsAdd: 'decisions:add',
  decisionsKeep: 'decisions:keep',
  decisionsChange: 'decisions:change',
  githubStatus: 'github:status',
  githubSignIn: 'github:sign-in',
  githubRepos: 'github:repos',
  githubClone: 'github:clone',
  githubIssues: 'github:issues',
  githubPrStatus: 'github:pr-status',
  githubFixCheck: 'github:fix-check',
  githubPublish: 'github:publish',
  approvalsList: 'approvals:list',
  approvalsDecide: 'approvals:decide',
  usageReport: 'usage:report',
} as const;
