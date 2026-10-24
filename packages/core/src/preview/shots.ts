import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Project } from '@conclave/shared';
import type { Store } from '../store/store.js';
import type { SnapshotSet } from '../store/snapshots.js';
import { PreviewServer, detectPreview } from './preview.js';
import {
  diffShots,
  shotPlan,
  visualChecks,
  type Shot,
  type ShotDiff,
  type Snapshotter,
} from './snapshot.js';

export type TaskShots =
  | {
      kind: 'taken';
      before: SnapshotSet | null;
      after: SnapshotSet;
      diffs: ShotDiff[];
      checks: { sendBack: string[]; notes: string[] };
    }
  | { kind: 'skipped'; reason: string };

/** Where a project's screenshots live: under Conclave's data folder, never in your repo. */
export const shotsDir = (home: string, projectId: string) =>
  join(home, 'projects', projectId, 'shots');

/**
 * Screenshots of a task's pages, before (the integration branch) and after (the task's worktree),
 * plus the free visual checks. "Before" shots are taken once per integration commit and reused.
 * Never blocks your work: if the shots can't be taken in time, it says why and skips them.
 */
export async function snapshotTask(input: {
  store: Store;
  home: string;
  project: Project;
  taskId: string;
  afterDir: string;
  afterCommit: string;
  beforeDir: string;
  beforeCommit: string;
  snapshotter: Snapshotter;
  deadlineMs?: number;
}): Promise<TaskShots> {
  const { store, project } = input;
  const plan = detectPreview(input.afterDir);
  if (plan.kind === 'none') return { kind: 'skipped', reason: plan.reason };
  if (plan.kind === 'command' && project.previewCommand !== plan.command) {
    return {
      kind: 'skipped',
      reason: `Screenshots need a preview: allow ${plan.command} for this project in its Preview first.`,
    };
  }
  const deadline = Date.now() + (input.deadlineMs ?? 60_000);
  const inTime = <T>(p: Promise<T>) =>
    Promise.race([
      p,
      new Promise<never>((_, fail) =>
        setTimeout(
          () => fail(new Error('they took longer than a minute')),
          Math.max(1, deadline - Date.now()),
        ),
      ),
    ]);

  const shoot = async (dir: string, setId: string): Promise<Shot[]> => {
    const p = detectPreview(dir);
    const server = new PreviewServer(dir, p);
    const folder = join(shotsDir(input.home, project.id), setId);
    mkdirSync(folder, { recursive: true });
    try {
      const { url } = await inTime(server.start());
      const shots: Shot[] = [];
      for (const s of shotPlan(project.pages)) {
        const snap = await inTime(
          input.snapshotter.capture(new URL(s.page.slice(1), url).href, s.view),
        );
        const path = join(folder, `${s.name}.png`);
        writeFileSync(path, snap.png);
        shots.push({
          name: s.name,
          page: s.page,
          size: s.size,
          view: s.view,
          path,
          consoleErrors: snap.consoleErrors,
          failedRequests: snap.failedRequests,
          metrics: snap.metrics,
        });
      }
      return shots;
    } finally {
      await server.stop();
    }
  };

  try {
    let before = store.snapshots.forCommit(project.id, input.beforeCommit) ?? null;
    const beforePlan = detectPreview(input.beforeDir);
    const beforeOk =
      beforePlan.kind === 'static' ||
      (beforePlan.kind === 'command' && project.previewCommand === beforePlan.command);
    if (!before && beforeOk) {
      const id = store.snapshots.newId();
      before = store.snapshots.save({
        id,
        projectId: project.id,
        taskId: null,
        commit: input.beforeCommit,
        shots: await shoot(input.beforeDir, id),
        diff: null,
        checks: null,
      });
    }
    const id = store.snapshots.newId();
    const shots = await shoot(input.afterDir, id);
    const diffs = before ? diffShots(before.shots, shots, (p) => readFileSync(p)) : [];
    const checks = visualChecks(shots, before?.shots);
    const after = store.snapshots.save({
      id,
      projectId: project.id,
      taskId: input.taskId,
      commit: input.afterCommit,
      shots,
      diff: diffs,
      checks,
    });
    return { kind: 'taken', before, after, diffs, checks };
  } catch (err) {
    return {
      kind: 'skipped',
      reason: `Screenshots couldn't be taken: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`,
    };
  }
}
