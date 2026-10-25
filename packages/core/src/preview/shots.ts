import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SHOTS_FILE, parseShotsFile, type Project, type ShotState } from '@conclave/shared';
import type { Store } from '../store/store.js';
import type { SnapshotSet } from '../store/snapshots.js';
import { PreviewServer, detectPreview, previewAllowed } from './preview.js';
import {
  diffShots,
  shotPlan,
  visualChecks,
  shotPlace,
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
  if (plan.kind === 'command' && !previewAllowed(project.previewCommand, plan)) {
    return {
      kind: 'skipped',
      reason: `Screenshots need a preview: allow ${plan.command} (${plan.runs}) for this project in its Preview first.`,
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

  // Sample states from the folder being shot (a task can add or change them).
  const notes: string[] = [];
  const statesOf = (dir: string, report: boolean): ShotState[] => {
    const file = join(dir, SHOTS_FILE);
    if (!existsSync(file)) return [];
    const parsed = parseShotsFile(readFileSync(file, 'utf8'));
    if ('error' in parsed) {
      if (report) notes.push(`${parsed.error}; its sample states were left out`);
      return [];
    }
    return parsed.states;
  };

  const shoot = async (dir: string, setId: string, report = false): Promise<Shot[]> => {
    const p = detectPreview(dir);
    const server = new PreviewServer(dir, p);
    const folder = join(shotsDir(input.home, project.id), setId);
    mkdirSync(folder, { recursive: true });
    try {
      const { url } = await inTime(server.start());
      const shots: Shot[] = [];
      for (const s of shotPlan(project.pages, statesOf(dir, report))) {
        const snap = await inTime(
          input.snapshotter.capture(new URL(s.page.slice(1), url).href, s.view, s.state?.steps),
        );
        const path = join(folder, `${s.name}.png`);
        writeFileSync(path, snap.png);
        shots.push({
          name: s.name,
          page: s.page,
          ...(s.state && { state: s.state.name }),
          ...(snap.stateError && { stateError: snap.stateError }),
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
      beforePlan.kind === 'static' || previewAllowed(project.previewCommand, beforePlan);
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
    const shots = await shoot(input.afterDir, id, true);
    const diffs = before ? diffShots(before.shots, shots, (p) => readFileSync(p)) : [];
    const found = visualChecks(shots, before?.shots);
    const checks = { sendBack: found.sendBack, notes: [...notes, ...found.notes].slice(0, 8) };
    const after = store.snapshots.save({
      id,
      projectId: project.id,
      taskId: input.taskId,
      commit: input.afterCommit,
      shots,
      diff: diffs,
      checks,
      beforeId: before?.id ?? null,
    });
    return { kind: 'taken', before, after, diffs, checks };
  } catch (err) {
    return {
      kind: 'skipped',
      reason: `Screenshots couldn't be taken: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`,
    };
  }
}

/** One screenshot shown to a reviewer, labelled the way the prompt refers to it. */
export interface ReviewShot {
  label: string;
  path: string;
}

const PREFERRED = ['phone-dark', 'desktop-light', 'phone-light', 'desktop-dark'];

/**
 * At most `max` screenshots for a reviewer: the pages that changed most first, phone-dark and
 * desktop-light before the rest, and the "before" of the most changed page when it changed more
 * than 1%, so the reviewer can see what this change did.
 */
export function pickReviewShots(
  after: SnapshotSet,
  before: SnapshotSet | undefined,
  max = 4,
): ReviewShot[] {
  // Under 1% is noise (anti-aliasing, a blinking caret), not a change worth showing first.
  const changed = new Map(
    (after.diff ?? []).map((d) => [d.name, d.changed > 0.01 ? d.changed : 0]),
  );
  const rank = (s: Shot) => PREFERRED.findIndex((p) => s.name.endsWith(p));
  // A sample state shows the page in use, so it goes before the page as it loads.
  const sorted = [...after.shots].sort(
    (a, b) =>
      (changed.get(b.name) ?? 0) - (changed.get(a.name) ?? 0) ||
      Number(Boolean(b.state)) - Number(Boolean(a.state)) ||
      rank(a) - rank(b),
  );
  const top = sorted[0];
  const was =
    top && (changed.get(top.name) ?? 0) > 0.01
      ? before?.shots.find((s) => s.name === top.name)
      : undefined;
  const label = (s: Shot, when: string) => `${when}: ${shotPlace(s)} (${s.size}, ${s.view.scheme})`;
  const picks = sorted
    .slice(0, was ? max - 1 : max)
    .map((s) => ({ label: label(s, 'after'), path: s.path }));
  if (was) picks.push({ label: label(was, 'before'), path: was.path });
  return picks;
}

/**
 * About how many tokens a screenshot costs a vision model: images are scaled to fit about 1568 px
 * on the long side, then cost roughly width × height / 750 tokens, at most about 1,600.
 */
export function imageTokens(png: Buffer): number {
  if (png.length < 24) return 0;
  const w = png.readUInt32BE(16);
  const h = png.readUInt32BE(20);
  const scale = Math.min(1, 1568 / Math.max(w, h, 1));
  return Math.min(1600, Math.round((w * scale * h * scale) / 750));
}
