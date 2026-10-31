import { z } from 'zod';
import { Seat } from './chat.js';
import { ProviderId } from './providers.js';

/** Who may do each job, in order of preference. The governor picks the first with headroom. */
export const Routing = z.object({
  planner: z.array(Seat),
  builder: z.array(Seat),
  reviewer: z.array(Seat),
});
export type Routing = z.infer<typeof Routing>;

export const ProjectStatus = z.enum([
  'draft',
  'idle',
  'running',
  'waiting',
  'needs_you',
  'paused',
  'done',
  'stopped',
]);
export type ProjectStatus = z.infer<typeof ProjectStatus>;

/** What happens after a failed attempt (C6b). */
export const RetryStrategy = z.enum(['same', 'escalate', 'ask']);
export type RetryStrategy = z.infer<typeof RetryStrategy>;

/** What agents do when they hit an open question (C4). */
export const AskPolicy = z.enum(['ask', 'decide', 'council']);
export type AskPolicy = z.infer<typeof AskPolicy>;

/** How much builders may do (C6c). Planners and reviewers always read only. */
export const PermissionLevel = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
]);
export type PermissionLevel = z.infer<typeof PermissionLevel>;

export const Permissions = z.object({
  level: PermissionLevel,
  network: z.enum(['never', 'ask', 'allow']),
  installs: z.enum(['ask', 'allow', 'never']),
  /** Level 5 turns itself off at this time. */
  expiresAt: z.number().nullable(),
});
export type Permissions = z.infer<typeof Permissions>;

export const DEFAULT_PERMISSIONS: Permissions = {
  level: 2,
  network: 'never',
  installs: 'ask',
  expiresAt: null,
};

/** The project's GitHub side (M7). */
export const GitHubLink = z.object({
  /** owner/name */
  repo: z.string(),
  /** The branch pull requests come from, e.g. conclave/calculator. */
  prBranch: z.string().nullable(),
  prUrl: z.string().nullable(),
  prState: z.enum(['open', 'merged', 'closed']).nullable(),
  issue: z.object({ number: z.number(), title: z.string(), url: z.string() }).nullable(),
});
export type GitHubLink = z.infer<typeof GitHubLink>;

export const Project = z.object({
  id: z.string(),
  name: z.string(),
  /** The user's repository. Conclave never changes its checked-out branch or working files. */
  repoPath: z.string(),
  goal: z.string(),
  doneWhen: z.string().nullable(),
  /** Shell command run in each task's worktree; exit code 0 means the task passes. */
  testCommand: z.string().nullable(),
  baseBranch: z.string(),
  integrationBranch: z.string(),
  routing: Routing,
  /** How many attempts a task gets before it's marked failed. */
  maxAttempts: z.number(),
  /** How many tasks may build at once (lanes). 1 is one task at a time. */
  maxParallel: z.number(),
  /** Let the brain reorder the team from measured speed, reliability and quota. */
  adaptiveTeam: z.boolean(),
  /** The dev-server command you allowed for previews, or null (static previews need none). */
  previewCommand: z.string().nullable(),
  /** Pages the screenshots and visual review check, like "/" and "/settings". */
  pages: z.array(z.string()),
  /** An AI with vision reviews the screenshots too (web projects; screenshots themselves are free). */
  visualReview: z.boolean(),
  /** "light": reviewers run at their lightest thinking level or fast model (v0.9.1 F7). */
  reviewEffort: z.enum(['same', 'light']),
  retryStrategy: RetryStrategy,
  askPolicy: AskPolicy,
  permissions: Permissions,
  /** Look and feel the agents follow, from the wizard or a decision. */
  designDirection: z.string().nullable(),
  /** A test command the clarify step suggested, waiting for you to accept it. */
  proposedTestCommand: z.string().nullable(),
  github: GitHubLink.nullable(),
  status: ProjectStatus,
  statusReason: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Project = z.infer<typeof Project>;

export const TaskStatus = z.enum([
  'queued',
  'building',
  'verifying',
  'reviewing',
  /** Approved, in the merge queue: merges go one at a time and are re-tested (lanes). */
  'merging',
  'merged',
  'failed',
  /** Waiting on you: a question or an approval (`blockedBy`). */
  'blocked',
  /** You skipped it; the planner won't redo it unless asked. */
  'skipped',
  /** A later task took over this work (`replacedBy`); hidden from counts. */
  'replaced',
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

/** A task some agent or the merge queue is working on right now. */
export const IN_FLIGHT: readonly TaskStatus[] = ['building', 'verifying', 'reviewing', 'merging'];

/** What kind of problem stopped an attempt, and so whose problem it is. */
export const FailureKind = z.enum([
  'limit',
  'tests',
  'review',
  'no_changes',
  'conflict',
  /** Passed alone, but the tests fail once combined with work merged meanwhile (lanes). */
  'combined_tests',
  /** A reviewer that can see found visual problems in the screenshots. */
  'visual',
  'crash',
  /** The CLI went quiet for longer than it ever does while working; stopped and handed on. */
  'stall',
  'question',
]);
export type FailureKind = z.infer<typeof FailureKind>;

export const TaskFailure = z.object({
  kind: FailureKind,
  /** One plain sentence. */
  summary: z.string(),
  /** Raw output: test log, review issues, CLI error. */
  detail: z.string(),
  provider: ProviderId.nullable(),
  model: z.string().nullable(),
  at: z.number(),
});
export type TaskFailure = z.infer<typeof TaskFailure>;

export const TaskGrants = z.object({
  /** An install command you approved; Conclave runs it before the next build. */
  install: z.string().optional(),
  /** Network for the next build only. */
  network: z.boolean().optional(),
});
export type TaskGrants = z.infer<typeof TaskGrants>;

/** The planner's guess at a task's size, checked by the brain and against the real diff. */
export const TaskEstimate = z.object({
  files: z.array(z.string()),
  /** Changed lines (added + removed). */
  lines: z.number(),
  risk: z.enum(['low', 'medium', 'high']),
});
export type TaskEstimate = z.infer<typeof TaskEstimate>;

/** The last attempt's commit, kept on the task branch so the next step continues from it. */
export const TaskKept = z.object({
  commit: z.string(),
  /** Attempts in a row that continued from kept work; at 2 the next one starts fresh. */
  streak: z.number(),
  /** Built and tested, waiting only for a reviewer with headroom. */
  ready: z.boolean(),
});
export type TaskKept = z.infer<typeof TaskKept>;

export const Task = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  spec: z.string(),
  status: TaskStatus,
  /** Lower runs first. */
  priority: z.number(),
  attempts: z.number(),
  /** Why the last attempt was sent back: failing test output or review issues. */
  feedback: z.string().nullable(),
  builtBy: ProviderId.nullable(),
  reviewedBy: ProviderId.nullable(),
  mergeCommit: z.string().nullable(),
  lastFailure: TaskFailure.nullable(),
  /** Attempts that didn't count (merge conflicts, a first CLI crash). */
  freeRetries: z.number(),
  /** Build this task with exactly this seat instead of the team. */
  pinnedSeat: Seat.nullable(),
  replacedBy: z.string().nullable(),
  blockedBy: z.string().nullable(),
  /** One-time permissions you granted for the next attempt. */
  grants: TaskGrants.nullable(),
  estimate: TaskEstimate.nullable(),
  /** Tasks that must finish (merge, fail or be skipped) before this one starts. */
  after: z.array(z.string()),
  /** Changed lines in the merged diff, to calibrate the planner's estimates. */
  actualLines: z.number().nullable(),
  kept: TaskKept.nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Task = z.infer<typeof Task>;

/** Honest progress: replaced and skipped work leaves the total, failures are counted apart. */
export function taskProgress(tasks: Task[]): {
  merged: number;
  total: number;
  failed: number;
  skipped: number;
  blocked: number;
} {
  const count = (s: TaskStatus) => tasks.filter((t) => t.status === s).length;
  const skipped = count('skipped');
  return {
    merged: count('merged'),
    total: tasks.length - count('replaced') - skipped,
    failed: count('failed'),
    skipped,
    blocked: count('blocked'),
  };
}

export const BrainEventKind = z.enum([
  'start',
  'plan',
  'task',
  'agent',
  'commit',
  'verify',
  'review',
  'merge',
  'retry',
  'fail',
  'wait',
  'done',
  'stop',
  'error',
  'approval',
  'question',
  'decision',
]);
export type BrainEventKind = z.infer<typeof BrainEventKind>;

/** Append-only project log; what the Projects screen and `conclave project status` show. */
export const BrainEvent = z.object({
  id: z.number(),
  projectId: z.string(),
  taskId: z.string().nullable(),
  kind: BrainEventKind,
  message: z.string(),
  provider: ProviderId.nullable(),
  data: z.unknown().nullable(),
  at: z.number(),
});
export type BrainEvent = z.infer<typeof BrainEvent>;

export const ApprovalStatus = z.enum(['pending', 'approved', 'rejected']);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

/** Anything that reaches outside the machine waits here for a person. */
export const Approval = z.object({
  id: z.string(),
  projectId: z.string(),
  taskId: z.string().nullable(),
  // merge_base: a finished project's work, merged into your branch (and optionally pushed or as
  // a pull request). It was called `push` before v0.9, though it never pushed (migration 17).
  kind: z.enum([
    'merge_base',
    'pull_request',
    'create_repo',
    'install',
    'network',
    'question',
    'other',
  ]),
  summary: z.string(),
  payload: z.unknown().nullable(),
  status: ApprovalStatus,
  /** Your reply to a question. */
  answer: z.string().nullable(),
  createdAt: z.number(),
  decidedAt: z.number().nullable(),
});
export type Approval = z.infer<typeof Approval>;

/** What an agent asked when it couldn't go on without you (C4). */
export const AgentQuestion = z.object({
  question: z.string(),
  why: z.string().optional(),
  options: z.array(z.string()),
  recommended: z.string().optional(),
  /** A request to install something or reach the network, instead of a product question. */
  permission: z
    .object({
      kind: z.enum(['install', 'network']),
      command: z.string().optional(),
      alternative: z.string().optional(),
    })
    .optional(),
});
export type AgentQuestion = z.infer<typeof AgentQuestion>;

/** The payload of an inbox item of kind question, install or network. */
export const QuestionPayload = AgentQuestion.extend({
  stage: z.enum(['plan', 'build', 'review', 'clarify']),
  provider: ProviderId.nullable(),
});
export type QuestionPayload = z.infer<typeof QuestionPayload>;

/** Something settled for a project; every agent prompt includes the active ones (C3). */
export const ProjectDecision = z.object({
  id: z.string(),
  projectId: z.string(),
  /** A decision comes from you; an assumption was made without you. */
  kind: z.enum(['decision', 'assumption']),
  question: z.string(),
  answer: z.string(),
  source: z.enum(['you', 'clarify', 'council', 'agent']),
  provider: ProviderId.nullable(),
  taskId: z.string().nullable(),
  status: z.enum(['active', 'overturned']),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type ProjectDecision = z.infer<typeof ProjectDecision>;

/** One change the planner proposes from your message; nothing happens until you apply it. */
export const SteeringAction = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('add_task'),
    title: z.string().min(1).max(200),
    spec: z.string().min(1).max(4000),
    after: z.array(z.string()).default([]),
  }),
  z.object({
    type: z.literal('edit_task'),
    id: z.string(),
    title: z.string().min(1).max(200).optional(),
    spec: z.string().min(1).max(4000).optional(),
  }),
  z.object({ type: z.literal('skip_task'), id: z.string() }),
  z.object({ type: z.literal('move_task'), id: z.string(), before: z.string().nullable() }),
  z.object({
    type: z.literal('decision'),
    question: z.string().min(1).max(1000),
    answer: z.string().min(1).max(2000),
  }),
  z.object({ type: z.literal('pause') }),
]);
export type SteeringAction = z.infer<typeof SteeringAction>;

/** A message in a project's Chat tab: yours, or the planner's reply with its proposal. */
export const SteeringMessage = z.object({
  id: z.string(),
  projectId: z.string(),
  role: z.enum(['you', 'planner']),
  text: z.string(),
  actions: z.array(SteeringAction),
  /** Indexes of the actions you applied; null until you apply or dismiss. */
  applied: z.array(z.number()).nullable(),
  /** What happened to each applied action, in plain words. */
  outcome: z.array(z.string()).nullable(),
  provider: ProviderId.nullable(),
  createdAt: z.number(),
});
export type SteeringMessage = z.infer<typeof SteeringMessage>;
