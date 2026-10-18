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

export const ProjectStatus = z.enum(['idle', 'running', 'waiting', 'paused', 'done', 'stopped']);
export type ProjectStatus = z.infer<typeof ProjectStatus>;

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
  /** How many times a task is retried with feedback before it's marked failed. */
  maxAttempts: z.number(),
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
  'merged',
  'failed',
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

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
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Task = z.infer<typeof Task>;

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
  kind: z.enum(['push', 'pull_request', 'install', 'network', 'other']),
  summary: z.string(),
  payload: z.unknown().nullable(),
  status: ApprovalStatus,
  createdAt: z.number(),
  decidedAt: z.number().nullable(),
});
export type Approval = z.infer<typeof Approval>;
