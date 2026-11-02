import type { AppSettings, SteeringMessage } from '@conclave/shared';
import type { PreviewResult, SnapshotSet, StartCheck, SyncState } from '@conclave/core';
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
  /** What's waiting on you, by kind: a question isn't "ready to merge" (U6). */
  waiting: { questions: number; requests: number; merges: number };
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
  /** How the project can be previewed: Conclave serves it (static), or its own dev server. */
  preview: { kind: 'static' } | { kind: 'command'; command: string; allowed: boolean } | null;
}

/** A task's latest screenshots and the integration shots they were compared with. */
export interface TaskSnapshots {
  after: SnapshotSet | null;
  before: SnapshotSet | null;
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
  /** The file it came from. */
  suggestedTestSource?: string;
}

export interface TryTestResult {
  ok: boolean;
  cancelled?: boolean;
  error?: string;
  passed?: boolean;
  code?: number | null;
  timedOut?: boolean;
  durationMs?: number;
  /** The last lines it printed. */
  tail?: string;
}

export interface NewProjectInput {
  repoPath: string;
  goal: string;
  name?: string;
  doneWhen?: string;
  testCommand?: string;
  routing?: Partial<Routing>;
  maxAttempts?: number;
  /** Tasks that may build at once (lanes), 1 to 4. */
  maxParallel?: number;
  /** Let the brain reorder the team from measured speed, reliability and quota. */
  adaptiveTeam?: boolean;
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
  /** Tasks that may build at once (lanes), 1 to 4. */
  maxParallel?: number;
  /** Let the brain reorder the team from measured speed, reliability and quota. */
  adaptiveTeam?: boolean;
  retryStrategy?: RetryStrategy;
  askPolicy?: AskPolicy;
  permissions?: Permissions;
  /** Web projects: an AI that can see reviews the screenshots too. */
  visualReview?: boolean;
  /** Reviewers at their lightest level ("light") or as set in the team ("same"). */
  reviewEffort?: 'same' | 'light';
  /** Web projects: the pages to screenshot, like "/" and "/settings" (up to 5). */
  pages?: string[];
}

/** Per role: the reasons the brain would change the order (empty when it keeps yours). */
export type TeamInsights = Record<'planner' | 'builder' | 'reviewer', { reasons: string[] }>;

export interface DecideOptions {
  /** A reply to a question, or a note on an install/network request. */
  answer?: string;
  /** For a finished project: merge here, merge here and push, or open (or update) a pull request. */
  via?: 'merge' | 'merge_push' | 'pr';
  draft?: boolean;
}

export interface ApprovalItem {
  approval: Approval;
  project: Project;
}

export interface UsageReport {
  day: ProviderTotals[];
  week: ProviderTotals[];
  /** Screenshots shown to reviewers (visual review), per range. */
  images: { day: ImageUsage; week: ImageUsage };
  daily: DailyActivity[];
  recent: AgentRun[];
  quotas: QuotaInfo[];
}

export interface ImageUsage {
  tokens: number;
  runs: number;
  /** Share of all input tokens, 0 to 1. */
  share: number;
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
    moveTask(taskId: string, direction: 'up' | 'down'): Promise<Task>;
    editTask(taskId: string, patch: { title?: string; spec?: string }): Promise<Task>;
    addTask(
      projectId: string,
      input: { title: string; spec: string; after?: string[] },
    ): Promise<Task>;
    steering(projectId: string): Promise<SteeringMessage[]>;
    /** Your message and the planner's reply with its proposal. */
    steer(
      projectId: string,
      text: string,
    ): Promise<{ you: SteeringMessage; planner: SteeringMessage }>;
    applySteering(messageId: string, indexes: number[]): Promise<SteeringMessage>;
    dismissSteering(messageId: string): Promise<SteeringMessage>;
    /** A live preview of the integration branch, or of one task's worktree. */
    preview(projectId: string, taskId?: string): Promise<PreviewResult>;
    /** Allow the dev-server command a preview showed (that task's, with `taskId`). */
    allowPreview(projectId: string, command: string, taskId?: string): Promise<Project>;
    stopPreview(projectId: string, taskId?: string): Promise<void>;
    previewLogs(projectId: string, taskId?: string): Promise<string>;
    snapshots(projectId: string, taskId: string): Promise<TaskSnapshots>;
    /** One screenshot as a data URL (only files from Conclave's own screenshot folders). */
    shot(path: string): Promise<string>;
    retryFailed(
      projectId: string,
      filter: { provider?: ProviderId; kind?: FailureKind },
      opts?: RetryOptions,
    ): Promise<Task[]>;
    permissionGaps(permissions: Permissions): Promise<PermissionGaps>;
    /** The project's branch here against GitHub, after a fetch (never a push). */
    syncState(id: string): Promise<SyncState>;
    /** Run a test command once in a folder, after the user confirms. */
    tryTest(folder: string, command: string): Promise<TryTestResult>;
    /** Push the project's branch to GitHub, after the user confirms. Never forced. */
    pushBase(id: string): Promise<{ ok: boolean; cancelled?: boolean; error?: string }>;
    /** Why the brain would reorder this team, from measured speed, reliability and quota. */
    teamInsights(routing: Routing): Promise<TeamInsights>;
    /** Start now, or with `at`, wait until then first (the start-up check's "Wait until…"). */
    start(id: string, at?: number): Promise<void>;
    /** Which AIs on the team can't work right now, and what that changes. */
    startCheck(id: string): Promise<StartCheck>;
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
    ): Promise<{ ok: boolean; error?: string; url?: string; pushError?: string }>;
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
  settings: {
    get(): Promise<AppSettings>;
    update(patch: SettingsPatch): Promise<AppSettings>;
  };
  local: {
    /** Download a model into Ollama, after the user confirms (several GB). */
    pull(model: string): Promise<{ ok: boolean; cancelled?: boolean; error?: string }>;
  };
  /** A notification was clicked: open this project. */
  onOpenProject(listener: (projectId: string) => void): () => void;
  onInstallLog(listener: (log: InstallLog) => void): () => void;
  openExternal(url: string): Promise<void>;
  platform: NodeJS.Platform;
}

/** A partial change to each settings section. */
export type SettingsPatch = { [K in keyof AppSettings]?: Partial<AppSettings[K]> };

export const IPC = {
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  openProject: 'app:open-project',
  accountsList: 'accounts:list',
  accountsSignIn: 'accounts:sign-in',
  accountsInstall: 'accounts:install',
  localPull: 'local:pull',
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
  projectsStartCheck: 'projects:start-check',
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
  projectsSyncState: 'projects:sync-state',
  projectsTryTest: 'projects:try-test',
  projectsPushBase: 'projects:push-base',
  projectsTeamInsights: 'projects:team-insights',
  projectsMoveTask: 'projects:move-task',
  projectsEditTask: 'projects:edit-task',
  projectsAddTask: 'projects:add-task',
  projectsSteering: 'projects:steering',
  projectsSteer: 'projects:steer',
  projectsApplySteering: 'projects:apply-steering',
  projectsDismissSteering: 'projects:dismiss-steering',
  projectsPreview: 'projects:preview',
  projectsAllowPreview: 'projects:allow-preview',
  projectsStopPreview: 'projects:stop-preview',
  projectsPreviewLogs: 'projects:preview-logs',
  projectsSnapshots: 'projects:snapshots',
  projectsShot: 'projects:shot',
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
