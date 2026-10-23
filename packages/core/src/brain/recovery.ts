import type { Adapter } from '../adapters/types.js';
import type {
  FailureKind,
  Project,
  ProviderId,
  Seat,
  Task,
  TaskFailure,
  TaskStatus,
} from '@conclave/shared';
import type { RunResult } from '../collect.js';
import { seatLabel } from '../chat/transcript.js';
import type { ProjectStore } from '../store/projects.js';

/** Attempts that don't count against a task, per kind (C6b). */
export const FREE_RETRIES: Partial<Record<FailureKind, number>> = {
  conflict: 2,
  // Shares the conflict budget: both mean other work landed first, not that this work is wrong.
  combined_tests: 2,
  crash: 1,
};

/** Kinds that are never the task's fault: the work moves on and no attempt is used. */
export const UNCOUNTED: ReadonlySet<FailureKind> = new Set(['limit', 'question']);

/** A failed agent run is either a usage limit (the account's problem) or a crash (the tool's). */
export function classifyRun(result: RunResult): 'limit' | 'crash' {
  return result.rateLimited ? 'limit' : 'crash';
}

/** Does this failure use up one of the task's attempts? */
export function countsAsAttempt(kind: FailureKind, freeRetriesUsed: number): boolean {
  if (UNCOUNTED.has(kind)) return false;
  return freeRetriesUsed >= (FREE_RETRIES[kind] ?? 0);
}

const LADDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * One reasoning level up from `current` (the CLI default counts as medium), among the
 * levels the provider supports. `cap` stops automatic escalation short of the priciest level.
 */
export function effortUp(
  current: string | undefined,
  supported: readonly string[] | undefined,
  cap = 'max',
): string | undefined {
  const levels = LADDER.filter((l) => !supported?.length || supported.includes(l));
  const at = LADDER.indexOf(current ?? 'medium');
  const limit = LADDER.indexOf(cap);
  return levels.find((l) => LADDER.indexOf(l) > at && LADDER.indexOf(l) <= limit) ?? current;
}

export function raiseSeat(seat: Seat, adapter: Adapter | undefined, cap?: string): Seat {
  const effort = effortUp(seat.effort, adapter?.capabilities.efforts, cap);
  return effort ? { ...seat, effort } : seat;
}

export interface BuilderPlan {
  /** In order of preference; the governor takes the first with headroom. */
  seats: Seat[];
  /** Why this attempt differs from the team's first choice, for the activity log. */
  note?: string;
}

/**
 * Who builds this attempt. A pinned seat goes first; otherwise the Escalate strategy
 * raises the effort on attempt 2 and hands the task to another builder from attempt 3.
 */
export function builderPlan(
  project: Project,
  task: Task,
  adapters: ReadonlyMap<ProviderId, Adapter>,
): BuilderPlan {
  const team = project.routing.builder;
  if (task.pinnedSeat) {
    const rest = team.filter((s) => !sameSeat(s, task.pinnedSeat!));
    return { seats: [task.pinnedSeat, ...rest], note: `pinned to ${seatLabel(task.pinnedSeat)}` };
  }
  if (project.retryStrategy !== 'escalate' || task.attempts === 0 || team.length === 0) {
    return { seats: team };
  }
  const last = team.find((s) => s.provider === task.builtBy) ?? team[0]!;
  const raise = (s: Seat) => raiseSeat(s, adapters.get(s.provider), 'xhigh');
  const tries = `${task.attempts} failed attempt${task.attempts === 1 ? '' : 's'}`;
  if (task.attempts === 1) {
    const raised = raise(last);
    return {
      seats: [raised, ...team.filter((s) => s !== last)],
      note: `raising effort to ${seatLabel(raised)} after ${tries}`,
    };
  }
  const others = team.filter((s) => s.provider !== last.provider).map(raise);
  if (others.length === 0) {
    const raised = raise(last);
    return { seats: [raised], note: `staying on ${seatLabel(raised)} after ${tries}` };
  }
  return {
    seats: [...others, raise(last)],
    note: `switching to ${seatLabel(others[0]!)} after ${tries} with ${seatLabel(last)}`,
  };
}

const sameSeat = (a: Seat, b: Seat) =>
  a.provider === b.provider &&
  (a.model ?? '') === (b.model ?? '') &&
  (a.effort ?? '') === (b.effort ?? '');

/* ── Your actions on failed tasks ──────────────────────────────────── */

export interface RetryOptions {
  /** Build with exactly this seat, for this task only. */
  seat?: Seat;
  /** One effort level up from the seat that built the last attempt. */
  effortUp?: boolean;
  /** Replace the task's spec before retrying. */
  spec?: string;
  /** Replace the feedback the next attempt sees (null clears it). */
  feedback?: string | null;
}

const RETRYABLE: TaskStatus[] = ['failed', 'skipped', 'blocked', 'queued'];

/** Requeue a task with a fresh attempt counter. Your call, so the brain's guard doesn't apply. */
export function retryTask(
  projects: ProjectStore,
  taskId: string,
  opts: RetryOptions = {},
  adapters?: ReadonlyMap<ProviderId, Adapter>,
): Task {
  const task = projects.getTask(taskId);
  if (!task) throw new Error(`No such task: ${taskId}`);
  if (!RETRYABLE.includes(task.status)) {
    throw new Error(
      `Only failed, skipped or waiting tasks can be retried (this one is ${task.status}).`,
    );
  }
  const project = projects.get(task.projectId)!;
  let seat = opts.seat ?? task.pinnedSeat ?? undefined;
  if (opts.effortUp) {
    // The builder, never the reviewer: a review failure's provider is whoever reviewed it.
    const base =
      seat ??
      project.routing.builder.find((s) => s.provider === task.builtBy) ??
      project.routing.builder[0];
    if (base) seat = raiseSeat(base, adapters?.get(base.provider));
  }
  const next = projects.updateTask(task.id, {
    status: 'queued',
    attempts: 0,
    freeRetries: 0,
    blockedBy: null,
    pinnedSeat: seat ?? null,
    ...(opts.spec !== undefined && { spec: opts.spec.trim() || task.spec }),
    ...(opts.feedback !== undefined && { feedback: opts.feedback }),
  });
  projects.log({
    projectId: task.projectId,
    taskId: task.id,
    kind: 'retry',
    message: `You retried ${task.title}${seat ? ` with ${seatLabel(seat)}` : ''}`,
    data: { by: 'you', ...(seat && { seat }) },
  });
  return next;
}

/** Leave a task out: it no longer counts toward progress and the planner won't redo it. */
export function skipTask(projects: ProjectStore, taskId: string): Task {
  const task = projects.getTask(taskId);
  if (!task) throw new Error(`No such task: ${taskId}`);
  if (!['failed', 'queued', 'blocked'].includes(task.status)) {
    throw new Error(
      `Only failed, queued or waiting tasks can be skipped (this one is ${task.status}).`,
    );
  }
  const next = projects.updateTask(task.id, { status: 'skipped', blockedBy: null });
  projects.log({
    projectId: task.projectId,
    taskId: task.id,
    kind: 'task',
    message: `You skipped ${task.title}`,
  });
  return next;
}

/** Retry every failed task matching the filter, e.g. all that failed on one provider's limit. */
export function retryFailed(
  projects: ProjectStore,
  projectId: string,
  filter: { provider?: ProviderId; kind?: FailureKind } = {},
  opts: RetryOptions = {},
  adapters?: ReadonlyMap<ProviderId, Adapter>,
): Task[] {
  return failedTasks(projects, projectId, filter).map((t) =>
    retryTask(projects, t.id, opts, adapters),
  );
}

export function failedTasks(
  projects: ProjectStore,
  projectId: string,
  filter: { provider?: ProviderId; kind?: FailureKind } = {},
): Task[] {
  return projects
    .listTasks(projectId)
    .filter(
      (t) =>
        t.status === 'failed' &&
        (!filter.provider || t.lastFailure?.provider === filter.provider) &&
        (!filter.kind || t.lastFailure?.kind === filter.kind),
    );
}

export interface ActiveLimit {
  provider: ProviderId;
  /** The CLI's own words, e.g. "You hit your spend cap set by the owner of your workspace." */
  message: string;
  at: number;
}

/**
 * Providers that hit a usage limit and haven't answered successfully since. Limits never fail
 * tasks (the work moves on), so this is what tells you one of your AIs is out.
 */
export function activeLimits(
  store: { projects: ProjectStore; usage: { lastOk(provider: ProviderId): number | null } },
  projectId?: string,
): ActiveLimit[] {
  return store.projects
    .latestLimits(projectId)
    .filter((f) => f.at > (store.usage.lastOk(f.provider!) ?? 0))
    .map((f) => ({
      provider: f.provider!,
      message: f.detail.split('\n')[0]!.slice(0, 300) || f.summary,
      at: f.at,
    }));
}

/**
 * A provider causing repeated trouble on a project: 2+ failed tasks that share
 * the provider and kind. Drives the "Retry all with…" banner.
 */
export function providerProblems(
  tasks: Task[],
): { provider: ProviderId; kind: FailureKind; tasks: Task[]; summary: string }[] {
  const groups = new Map<string, Task[]>();
  for (const t of tasks) {
    if (t.status !== 'failed' || !t.lastFailure?.provider) continue;
    const key = `${t.lastFailure.provider}:${t.lastFailure.kind}`;
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  return [...groups.values()]
    .filter((g) => g.length >= 2)
    .map((g) => {
      const f = g[0]!.lastFailure as TaskFailure;
      return { provider: f.provider!, kind: f.kind, tasks: g, summary: f.summary };
    });
}
