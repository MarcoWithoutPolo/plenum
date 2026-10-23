import type { Task, TaskEstimate } from '@conclave/shared';
import type { PlannedTask } from './json.js';

/**
 * The planner proposes; these rules check its sizes before anything is queued.
 * Every task costs a build, a test run and a review, so tiny neighbours are merged.
 * A task too big to review well goes back to the planner once to be split.
 */
export const SIZE = {
  /** A task this small is cheaper merged with its neighbour than built on its own. */
  small: 120,
  /** The largest diff a reviewer checks well in one go. */
  reviewable: 400,
  /** Past this, the planner is asked to split the task. */
  tooBig: 800,
} as const;

export interface ShapedPlan {
  tasks: PlannedTask[];
  /** How many planned tasks were folded into a neighbour. */
  folded: number;
  /** Tasks the planner should split (estimate, after calibration, over SIZE.tooBig). */
  oversized: { title: string; lines: number }[];
}

/**
 * How far off the planner's estimates have been on this project: the median of
 * real / estimated changed lines over recent merged tasks (1 until there are 3 samples).
 */
export function calibration(tasks: Task[]): number {
  const ratios = tasks
    .filter(
      (t) => t.status === 'merged' && t.estimate && t.estimate.lines > 0 && t.actualLines !== null,
    )
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 20)
    .map((t) => t.actualLines! / t.estimate!.lines)
    .sort((a, b) => a - b);
  if (ratios.length < 3) return 1;
  const mid = Math.floor(ratios.length / 2);
  const median = ratios.length % 2 ? ratios[mid]! : (ratios[mid - 1]! + ratios[mid]!) / 2;
  return Math.min(3, Math.max(0.5, median));
}

const size = (t: PlannedTask, scale: number) => Math.round((t.estimate?.lines ?? 0) * scale);

/** Small, low-stakes work that can share a build and a review with its neighbours. */
function foldable(t: PlannedTask, scale: number): boolean {
  return (
    Boolean(t.estimate) &&
    !t.replaces &&
    t.estimate!.risk !== 'high' &&
    size(t, scale) <= SIZE.small
  );
}

export function shapePlan(planned: PlannedTask[], scale = 1): ShapedPlan {
  const groups: PlannedTask[][] = [];
  for (const task of planned) {
    const group = groups.at(-1);
    const total = group?.reduce((n, t) => n + size(t, scale), 0) ?? 0;
    if (
      group &&
      foldable(task, scale) &&
      group.every((t) => foldable(t, scale)) &&
      total + size(task, scale) <= SIZE.reviewable
    ) {
      group.push(task);
    } else {
      groups.push([task]);
    }
  }
  const tasks = groups.map((g) => (g.length === 1 ? g[0]! : fold(g)));
  return {
    tasks,
    folded: planned.length - tasks.length,
    oversized: tasks
      .filter((t) => size(t, scale) > SIZE.tooBig)
      .map((t) => ({ title: t.title, lines: size(t, scale) })),
  };
}

/** One task that does a few small ones in order. */
function fold(group: PlannedTask[]): PlannedTask {
  const estimates = group.map((t) => t.estimate!);
  const estimate: TaskEstimate = {
    files: [...new Set(estimates.flatMap((e) => e.files))],
    lines: estimates.reduce((n, e) => n + e.lines, 0),
    risk: estimates.some((e) => e.risk === 'medium') ? 'medium' : 'low',
  };
  return {
    title: group.map((t) => t.title).join('; '),
    spec: group.map((t, i) => `${i + 1}. ${t.title}\n${t.spec}`).join('\n\n'),
    estimate,
  };
}

/** Changed lines from a `git diff --stat` summary line. */
export function changedLines(stat: string): number {
  const last = stat.trim().split('\n').at(-1) ?? '';
  const added = Number(/(\d+) insertions?\(\+\)/.exec(last)?.[1] ?? 0);
  const removed = Number(/(\d+) deletions?\(-\)/.exec(last)?.[1] ?? 0);
  return added + removed;
}
