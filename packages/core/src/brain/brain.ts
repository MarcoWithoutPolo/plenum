import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import type {
  AgentQuestion,
  AgentEvent,
  BrainEvent,
  BrainEventKind,
  FailureKind,
  Project,
  ProviderId,
  Role,
  Seat,
  Task,
  TaskFailure,
} from '@conclave/shared';
import { looksLikeLimit } from '../adapters/cli.js';
import { builderPermissions, checkCommands, type RunPermissions } from '../adapters/permissions.js';
import { decisionsSection } from '../store/decisions.js';
import { collect, type RunResult } from '../collect.js';
import { recordUsage, type EngineContext } from '../chat/service.js';
import { seatLabel } from '../chat/transcript.js';
import { Governor } from '../governor/governor.js';
import { runShell } from '../process.js';
import { Workspace, headCommit } from '../workspace/git.js';
import { detectPreview } from '../preview/preview.js';
import {
  imageTokens,
  pickReviewShots,
  snapshotTask,
  type ReviewShot,
  type TaskShots,
} from '../preview/shots.js';
import type { Snapshotter } from '../preview/snapshot.js';
import { extractJson, parsePlan, parseReview } from './json.js';
import { acquireLock } from './lock.js';
import { builderPrompt, plannerPrompt, reviewerPrompt } from './prompts.js';
import { calibration, changedLines, shapePlan } from './shape.js';
import type { PlannedTask } from './json.js';
import { rankSeats, seatStats, withPriors, type RankRole } from '../governor/rank.js';
import { QUESTION_KINDS } from './answers.js';
import { isRunnableInstall, parseAssumptions, parseQuestion } from './questions.js';
import { builderPlan, countsAsAttempt } from './recovery.js';
import { findReplacement } from './similar.js';

export interface BrainOptions {
  /** Conclave's data folder; worktrees go under <home>/projects/<project id>. */
  home: string;
  governor?: Governor;
  maxTasksPerPlan?: number;
  /** Pause after this many tasks in a row fail with nothing merged in between. */
  maxFailureStreak?: number;
  /** Questions one task may ask before its agent must decide for itself. */
  maxQuestionsPerTask?: number;
  /** Open questions a project may have before agents must decide for themselves. */
  maxOpenQuestions?: number;
  agentTimeoutMs?: number;
  testTimeoutMs?: number;
  /** Lanes: how many tasks each AI may build at once (defaults: LANE_CAPS). */
  laneCaps?: Partial<Record<ProviderId, number>>;
  /** Takes screenshots for web projects (Electron in the app, headless Chrome in the CLI). */
  snapshotter?: Snapshotter;
  onEvent?: (event: BrainEvent) => void;
}

export type RoundOutcome =
  | { kind: 'planned'; tasks: Task[] }
  | { kind: 'merged'; task: Task }
  | { kind: 'retry'; task: Task; reason: string }
  | { kind: 'failed'; task: Task; reason: string }
  | { kind: 'waiting'; until: number | null; reason: string }
  /** An agent asked something: filed for you, or answered by policy (`decided`). */
  | { kind: 'asked'; task: Task | null; approvalId: string | null; decided: boolean }
  /** Nothing can run until you answer the open questions. */
  | { kind: 'needs_you'; reason: string }
  | { kind: 'done'; reason: string }
  | { kind: 'idle'; reason: string }
  | { kind: 'stopped'; reason: string };

export interface RunOptions {
  maxRounds?: number;
  signal?: AbortSignal;
  /** Longest single sleep while waiting for a usage window to reset. */
  maxSleepMs?: number;
  /** Injected for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * The autonomous project worker. Each round does one step:
 * plan when the queue is empty, otherwise build → test → review → merge one task.
 * Every stage is recorded, so a restarted brain picks up where it left off.
 */
/** One governor reading this store: quota readings plus your rules from Settings. */
export function storeGovernor(store: EngineContext['store']): Governor {
  return new Governor(() => store.listQuotas(), {
    policy: {
      limits: () => store.settings.get().limits,
      runsToday: (provider) => {
        const midnight = new Date();
        midnight.setHours(0, 0, 0, 0);
        return store.usage.runsSince(provider, midnight.getTime());
      },
    },
  });
}

/** How many tasks one AI may build at once across projects, by default (lanes). */
export const LANE_CAPS: Partial<Record<ProviderId, number>> = {
  claude: 2,
  codex: 2,
  antigravity: 1,
  gemini: 1,
};

/** The adopted test command, or until then the proposed one. */
function testCommandOf(project: Project): string | null {
  return project.testCommand ?? project.proposedTestCommand;
}

/** Do two path lists touch the same file or folder? */
function overlaps(a: string[], b: string[]): boolean {
  const norm = (p: string) =>
    p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase();
  const bs = b.map(norm);
  return a
    .map(norm)
    .some((x) => bs.some((y) => x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)));
}

export class Brain {
  readonly workspace: Workspace;
  private readonly governor: Governor;
  private readonly maxTasks: number;
  private readonly agentTimeout: number;
  private readonly testTimeout: number;
  private started = false;
  /** The last reorder reason logged per role, so a steady reorder is logged once. */
  private readonly rankNotes = new Map<RankRole, string>();
  /** What the last goal check found missing; the next plan closes these gaps. */
  private gaps: string[] = [];
  /** Set while run() is going; aborting it interrupts the agent or test in flight. */
  private signal: AbortSignal | undefined;

  constructor(
    private readonly ctx: EngineContext,
    readonly projectId: string,
    private readonly opts: BrainOptions,
  ) {
    const project = this.project();
    this.workspace = new Workspace(
      project.repoPath,
      join(opts.home, 'projects', projectId),
      project.integrationBranch,
    );
    this.governor = opts.governor ?? storeGovernor(ctx.store);
    this.maxTasks = opts.maxTasksPerPlan ?? 5;
    this.agentTimeout = opts.agentTimeoutMs ?? 30 * 60_000;
    this.testTimeout = opts.testTimeoutMs ?? 15 * 60_000;
  }

  private get projects() {
    return this.ctx.store.projects;
  }

  project(): Project {
    const p = this.projects.get(this.projectId);
    if (!p) throw new Error(`No such project: ${this.projectId}`);
    return p;
  }

  private log(
    kind: BrainEventKind,
    message: string,
    extra: { task?: Task; provider?: ProviderId; data?: unknown } = {},
  ): void {
    const event = this.projects.log({
      projectId: this.projectId,
      taskId: extra.task?.id ?? null,
      kind,
      message,
      provider: extra.provider ?? null,
      ...(extra.data !== undefined && { data: extra.data }),
    });
    this.opts.onEvent?.(event);
  }

  /** Prepare the worktrees and recover from an interrupted run. Safe to call repeatedly. */
  async start(): Promise<void> {
    if (this.started) return;
    const project = this.project();
    if (project.status === 'draft') {
      throw new Error('Finish setting up this project (answer its questions and start it) first.');
    }
    await this.workspace.prepare(project.baseBranch);
    const recovered = this.projects.requeueInterrupted(this.projectId);
    // Half-finished work is thrown away; the task rebuilds from the latest integration tip.
    for (const t of recovered) await this.workspace.removeTaskTree(t.id);
    this.projects.setStatus(this.projectId, 'running');
    this.log(
      'start',
      recovered.length
        ? `Resumed; ${recovered.length} interrupted task(s) back in the queue`
        : 'Started',
    );
    this.started = true;
  }

  async round(): Promise<RoundOutcome> {
    await this.start();
    const project = this.project();
    if (project.status === 'stopped' || project.status === 'paused') {
      return { kind: 'stopped', reason: project.statusReason ?? `Project is ${project.status}` };
    }
    const task = this.projects.nextQueued(this.projectId);
    if (task) return this.work(project, task);
    // Planning past an open question would build on a guess; wait for the answer instead.
    const open = this.openQuestions();
    const blocked = this.projects.listTasks(this.projectId).some((t) => t.status === 'blocked');
    if (open.length || blocked) {
      const reason = `${open.length || 'A'} question${open.length === 1 ? '' : 's'} waiting for you`;
      this.projects.setStatus(this.projectId, 'needs_you', reason);
      this.log('question', `Waiting for you: ${reason}`);
      return { kind: 'needs_you', reason };
    }
    return this.plan(project);
  }

  private openQuestions() {
    return this.projects
      .approvals(this.projectId, 'pending')
      .filter((a) => QUESTION_KINDS.has(a.kind));
  }

  private decisions(): string {
    return decisionsSection(this.ctx.store.decisions.list(this.projectId, { status: 'active' }));
  }

  /** Questions this task has raised so far, answered or not. */
  private questionCount(task: Task): number {
    const asked = this.projects
      .approvals(this.projectId)
      .filter((a) => a.taskId === task.id && QUESTION_KINDS.has(a.kind)).length;
    const assumed = this.ctx.store.decisions
      .list(this.projectId)
      .filter((d) => d.taskId === task.id && d.kind === 'assumption').length;
    return asked + assumed;
  }

  private mustDecide(task: Task | null): boolean {
    if (this.openQuestions().length >= (this.opts.maxOpenQuestions ?? 10)) return true;
    const limit = this.opts.maxQuestionsPerTask ?? 3;
    if (task) return this.questionCount(task) >= limit;
    // The planner gets the same limit, counted over the assumptions it caused.
    const planner = this.ctx.store.decisions
      .list(this.projectId)
      .filter((d) => d.taskId === null && d.source === 'agent').length;
    return planner >= limit;
  }

  /** Keep doing rounds until the goal is met, the project is stopped, or `maxRounds` runs out. */
  async run(options: RunOptions = {}): Promise<RoundOutcome> {
    const lock = acquireLock(join(this.workspace.root, 'run.lock'));
    this.signal = options.signal;
    try {
      const lanes = this.project().maxParallel;
      return await (lanes > 1 ? this.lanes(options, lanes) : this.loop(options));
    } finally {
      this.signal = undefined;
      lock.release();
    }
  }

  private async loop(options: RunOptions): Promise<RoundOutcome> {
    const sleep = options.sleep ?? interruptibleSleep;
    const maxSleep = options.maxSleepMs ?? 30 * 60_000;
    let last: RoundOutcome = { kind: 'idle', reason: 'No rounds run' };
    for (let i = 0; i < (options.maxRounds ?? Infinity); i++) {
      if (options.signal?.aborted) {
        if (this.project().status !== 'stopped') this.stop('Stopped by you');
        return { kind: 'stopped', reason: this.project().statusReason ?? 'Stopped by you' };
      }
      last = await this.round();
      if (
        last.kind === 'done' ||
        last.kind === 'stopped' ||
        last.kind === 'idle' ||
        last.kind === 'needs_you'
      )
        return last;
      if (last.kind === 'failed') {
        const streak = this.failureStreak();
        if (streak >= (this.opts.maxFailureStreak ?? 3)) {
          const reason = `${streak} tasks in a row failed with nothing merged. Paused so it doesn't use up your plan; check the activity, adjust the goal or tests, then resume.`;
          this.projects.setStatus(this.projectId, 'paused', reason);
          this.log('stop', reason);
          return { kind: 'idle', reason };
        }
      }
      if (last.kind === 'waiting') {
        const ms = last.until
          ? Math.min(maxSleep, Math.max(30_000, last.until - Date.now()))
          : 5 * 60_000;
        this.projects.setStatus(this.projectId, 'waiting', last.reason);
        await sleep(ms, options.signal);
        if (this.project().status === 'waiting') this.projects.setStatus(this.projectId, 'running');
      }
    }
    return last;
  }

  /**
   * Lanes: up to `max` tasks build → test → review at once, each in its own worktree.
   * A free lane takes the next ready task (everything in its `after` has finished) whose
   * planned files don't overlap a running lane, with a builder that has a free lane.
   * Merges still happen one at a time (Workspace.mergeTask), re-tested when others landed first.
   * Planning, questions and waiting run through the same round() as one lane, when no lane runs.
   */
  private async lanes(options: RunOptions, max: number): Promise<RoundOutcome> {
    const sleep = options.sleep ?? interruptibleSleep;
    const maxSleep = options.maxSleepMs ?? 30 * 60_000;
    const running = new Map<string, Promise<{ id: string; outcome: RoundOutcome }>>();
    let last: RoundOutcome = { kind: 'idle', reason: 'No rounds run' };
    let waitUntil: number | null | undefined;
    let waitReason = '';
    // Tasks that just couldn't start (a limit, no free builder): left alone until something changes.
    const parked = new Set<string>();
    const drain = async () => {
      for (const r of await Promise.all(running.values()))
        if (r.outcome.kind === 'stopped') last = r.outcome;
      running.clear();
    };
    await this.start();
    for (let i = 0; i < (options.maxRounds ?? Infinity); i++) {
      if (options.signal?.aborted) {
        await drain();
        if (this.project().status !== 'stopped') this.stop('Stopped by you');
        return { kind: 'stopped', reason: this.project().statusReason ?? 'Stopped by you' };
      }
      const project = this.project();
      if (
        project.status === 'stopped' ||
        project.status === 'paused' ||
        project.status === 'done'
      ) {
        await drain();
        const now = this.project();
        if (now.status === 'done')
          return last.kind === 'done'
            ? last
            : { kind: 'done', reason: now.statusReason ?? 'Goal met' };
        return now.status === 'stopped'
          ? { kind: 'stopped', reason: now.statusReason ?? 'Stopped' }
          : { kind: 'idle', reason: now.statusReason ?? 'Paused' };
      }
      // Fill the free lanes.
      for (
        let task = this.nextLaneTask(project, parked);
        task && running.size < max;
        task = this.nextLaneTask(project, parked)
      ) {
        const id = task.id;
        running.set(
          id,
          this.work(project, task).then((outcome) => ({ id, outcome })),
        );
        if (this.projects.getTask(id)?.status === 'queued') break; // it didn't start (no builder)
      }
      if (running.size === 0) {
        if (waitUntil !== undefined) {
          const ms = waitUntil
            ? Math.min(maxSleep, Math.max(30_000, waitUntil - Date.now()))
            : 5 * 60_000;
          this.projects.setStatus(this.projectId, 'waiting', waitReason);
          await sleep(ms, options.signal);
          if (this.project().status === 'waiting')
            this.projects.setStatus(this.projectId, 'running');
          waitUntil = undefined;
          parked.clear();
          continue;
        }
        // Nothing can start in parallel: plan, ask, wait or finish exactly as one lane does.
        last = await this.round();
        if (['done', 'stopped', 'idle', 'needs_you'].includes(last.kind)) return last;
        if (last.kind === 'waiting') {
          waitUntil = last.until ?? null;
          waitReason = last.reason;
        }
        if (last.kind === 'failed' && this.pausedAfterStreak())
          return { kind: 'idle', reason: this.project().statusReason ?? 'Paused' };
        continue;
      }
      const { id, outcome } = await Promise.race(running.values());
      running.delete(id);
      last = outcome;
      // A task that couldn't start waits for something to change. One turned away by a
      // usage limit goes again at once: the governor already steers it to another AI.
      const limited = outcome.kind === 'retry' && /usage limit/i.test(outcome.reason);
      if (
        (outcome.kind === 'waiting' || outcome.kind === 'retry') &&
        !limited &&
        this.projects.getTask(id)?.status === 'queued'
      ) {
        parked.add(id);
      } else {
        parked.clear();
      }
      if (outcome.kind === 'waiting') {
        waitUntil =
          waitUntil == null
            ? (outcome.until ?? null)
            : Math.min(waitUntil, outcome.until ?? waitUntil);
        waitReason = outcome.reason;
      }
      if (outcome.kind === 'failed' && this.pausedAfterStreak()) {
        await drain();
        return { kind: 'idle', reason: this.project().statusReason ?? 'Paused' };
      }
    }
    await drain();
    return last;
  }

  /** Pause after several failures in a row with nothing merged (same rule as one lane). */
  private pausedAfterStreak(): boolean {
    const streak = this.failureStreak();
    if (streak < (this.opts.maxFailureStreak ?? 3)) return false;
    const reason = `${streak} tasks in a row failed with nothing merged. Paused so it doesn't use up your plan; check the activity, adjust the goal or tests, then resume.`;
    this.projects.setStatus(this.projectId, 'paused', reason);
    this.log('stop', reason);
    return true;
  }

  /** Whether `provider` has a free builder lane in this project. */
  /** Whether `provider` has a free builder lane, counting every project (Settings or LANE_CAPS). */
  private builderRoom(provider: ProviderId): boolean {
    const cap =
      this.opts.laneCaps?.[provider] ??
      this.ctx.store.settings.get().limits.providers[provider]?.lanes ??
      LANE_CAPS[provider] ??
      1;
    return this.projects.countBuilding(provider) < cap;
  }

  /**
   * The next queued task a free lane can take: its `after` tasks have all finished, its
   * planned files don't overlap a running task's, and one of its builders has a free lane.
   */
  private nextLaneTask(project: Project, skip: ReadonlySet<string>): Task | undefined {
    const tasks = this.projects.listTasks(this.projectId);
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const finished = (id: string): boolean => {
      let t = byId.get(id);
      for (let hops = 0; t?.status === 'replaced' && t.replacedBy && hops < 20; hops++)
        t = byId.get(t.replacedBy);
      return !t || ['merged', 'failed', 'skipped'].includes(t.status);
    };
    const active = tasks.filter((t) => ['building', 'verifying', 'reviewing'].includes(t.status));
    const busy = active.flatMap((t) => t.estimate?.files ?? []);
    return tasks.find(
      (t) =>
        t.status === 'queued' &&
        !skip.has(t.id) &&
        t.after.every(finished) &&
        !(active.length && overlaps(t.estimate?.files ?? [], busy)) &&
        builderPlan(project, t, this.ctx.adapters).seats.some((s) => this.builderRoom(s.provider)),
    );
  }

  stop(reason = 'Stopped'): void {
    this.projects.setStatus(this.projectId, 'stopped', reason);
    this.log('stop', reason);
  }

  private get interrupted(): boolean {
    return this.signal?.aborted === true;
  }

  /** Stopped mid-step: the task goes back to the queue untouched, as if the step never ran. */
  private async halt(task?: Task): Promise<RoundOutcome> {
    if (task) {
      this.projects.updateTask(task.id, { status: 'queued' });
      await this.workspace.removeTaskTree(task.id);
    }
    const reason = this.project().statusReason ?? 'Stopped';
    return { kind: 'stopped', reason };
  }

  /** Tasks that failed since the last merge, newest first. */
  private failureStreak(): number {
    const finished = this.projects
      .listTasks(this.projectId)
      .filter((t) => t.status === 'merged' || t.status === 'failed')
      .sort((a, b) => b.updatedAt - a.updatedAt);
    let n = 0;
    for (const t of finished) {
      if (t.status !== 'failed') break;
      n++;
    }
    return n;
  }

  /* ── Planning ──────────────────────────────────────────────────────── */

  private async plan(
    project: Project,
    resize?: { title: string; lines: number }[],
  ): Promise<RoundOutcome> {
    const pick = this.governor.pick(this.ranked('planner', project.routing.planner));
    if (!pick.seat) return this.waiting('planner', pick);

    const tasks = this.projects.listTasks(this.projectId);
    const { files, total } = await this.workspace.listFiles();
    const prompt = plannerPrompt(
      project,
      {
        files,
        totalFiles: total,
        history: await this.workspace.log(),
        merged: tasks.filter((t) => t.status === 'merged'),
        failed: tasks.filter((t) => t.status === 'failed'),
        skipped: tasks.filter((t) => t.status === 'skipped'),
        queued: tasks.filter((t) => t.status === 'queued' || t.status === 'blocked'),
        maxTasks: this.maxTasks,
        ...(resize && { resize }),
        ...(this.gaps.length && { gaps: this.gaps }),
      },
      { decisions: this.decisions(), decideYourself: this.mustDecide(null) },
    );
    this.log('plan', `Planning with ${seatLabel(pick.seat)}`, { provider: pick.seat.provider });
    const result = await this.agent(
      'planner',
      pick.seat,
      prompt,
      this.workspace.integrationPath,
      true,
    );
    if (this.interrupted) return this.halt();
    if (result.rateLimited)
      return this.waiting('planner', this.governor.pick(project.routing.planner));
    if (!result.ok) {
      this.log('error', `Planner failed: ${failure(result)}`, { provider: pick.seat.provider });
      return { kind: 'idle', reason: `Planner failed: ${failure(result)}` };
    }

    const plan = parsePlan(result.text, this.maxTasks);
    if (!plan) {
      const question = parseQuestion(result.text);
      if (question) return this.ask(project, null, question, pick.seat, 'plan');
      this.log('error', 'The planner reply had no task list', {
        provider: pick.seat.provider,
        data: { reply: result.text.slice(0, 2000) },
      });
      return { kind: 'idle', reason: 'The planner reply had no task list' };
    }
    if (plan.done) {
      // "Done" while the project's own test command fails isn't done.
      const blocker = await this.testsBlockDone(project, tasks);
      if (blocker) return blocker;
      const reason = this.project().proposedTestCommand
        ? `${plan.reason} Note: the proposed test command ${this.project().proposedTestCommand} still fails.`
        : plan.reason;
      this.finish(reason);
      return { kind: 'done', reason };
    }
    if (plan.testCommand && !project.testCommand && !project.proposedTestCommand) {
      this.projects.update(this.projectId, { proposedTestCommand: plan.testCommand });
      this.log('plan', `Proposed test command: ${plan.testCommand}`, {
        provider: pick.seat.provider,
      });
    }
    if (plan.tasks.length === 0) {
      this.projects.setStatus(this.projectId, 'paused', 'The planner found nothing left to do');
      this.log('plan', 'The planner found nothing left to do');
      return { kind: 'idle', reason: 'The planner found nothing left to do' };
    }
    // Never take on the same failed work again: that's how an unattended run burns a plan.
    const failedTitles = new Set(
      tasks.filter((t) => t.status === 'failed').map((t) => normalizeTitle(t.title)),
    );
    const fresh = plan.tasks.filter((t) => !failedTitles.has(normalizeTitle(t.title)));
    const repeats = plan.tasks.length - fresh.length;
    if (fresh.length === 0) {
      const reason =
        'The planner only proposed tasks that already failed. Adjust the goal or tests, then resume.';
      this.projects.setStatus(this.projectId, 'paused', reason);
      this.log('stop', reason, {
        provider: pick.seat.provider,
        data: { tasks: plan.tasks.map((t) => t.title) },
      });
      return { kind: 'idle', reason };
    }
    if (repeats)
      this.log('plan', `Skipped ${repeats} task(s) that already failed`, {
        provider: pick.seat.provider,
      });
    // The planner proposes; the brain checks the sizes before anything is queued.
    const shaped = shapePlan(fresh, calibration(tasks));
    if (shaped.oversized.length && !resize) {
      this.log(
        'plan',
        `Asking the planner to split ${shaped.oversized.length} task(s) too big to review well`,
        { provider: pick.seat.provider, data: { oversized: shaped.oversized } },
      );
      return this.plan(project, shaped.oversized);
    }
    if (shaped.folded)
      this.log('plan', `Folded ${shaped.folded} small task(s) into their neighbours`, {
        provider: pick.seat.provider,
      });
    this.gaps = [];
    const added = this.projects.addTasks(
      this.projectId,
      shaped.tasks.map(({ after: _links, ...t }) => t),
    );
    this.linkOrder(added, shaped.tasks, tasks);
    this.linkReplacements(
      tasks,
      added,
      shaped.tasks.map((t) => t.replaces),
      pick.seat.provider,
    );
    this.log('plan', `Planned ${added.length} task(s)`, {
      provider: pick.seat.provider,
      data: { tasks: added.map((t) => t.title) },
    });
    return { kind: 'planned', tasks: added };
  }

  /**
   * Which tasks must finish before each new one starts. Positions in the reply become ids;
   * only earlier tasks count (no cycles). A task the planner gave no `after` waits for the
   * one before it, so work runs in order unless the planner says it is independent.
   */
  private linkOrder(added: Task[], planned: PlannedTask[], existing: Task[]): void {
    const known = new Set(existing.map((t) => t.id));
    added.forEach((task, i) => {
      const links = planned[i]!.after;
      const after = links
        ? links
            .map((a) => (typeof a === 'number' ? (a >= 1 && a <= i ? added[a - 1]!.id : '') : a))
            .filter((id) => id && (known.has(id) || added.some((t) => t.id === id)))
        : i > 0
          ? [added[i - 1]!.id]
          : [];
      this.projects.updateTask(task.id, { after: [...new Set(after)] });
    });
  }

  /**
   * One piece of work, one task: a new task that redoes failed work takes its place,
   * whether the planner said so (`replaces`) or the titles clearly describe the same work.
   */
  private linkReplacements(
    before: Task[],
    added: Task[],
    replaces: (string | undefined)[],
    provider: ProviderId,
  ): void {
    const open = new Map(before.filter((t) => t.status === 'failed').map((t) => [t.id, t]));
    added.forEach((task, i) => {
      const id = replaces[i];
      const named = id ? open.get(id) : undefined;
      const original = named ?? findReplacement(task.title, [...open.values()]);
      if (!original) return;
      open.delete(original.id);
      this.projects.updateTask(original.id, { status: 'replaced', replacedBy: task.id });
      this.log('plan', `${task.title} takes over from the failed task ${original.title}`, {
        task,
        provider,
        data: { replaced: original.id, how: named ? 'planner' : 'similar title' },
      });
    });
  }

  private finish(reason: string): void {
    const project = this.project();
    const merged = this.projects.listTasks(this.projectId).filter((t) => t.status === 'merged');
    this.projects.setStatus(this.projectId, 'done', reason);
    this.log('done', `Goal met: ${reason}`);
    if (merged.length) {
      const prOpen = project.github?.prState === 'open';
      const approval = this.projects.requestApproval({
        projectId: this.projectId,
        kind: 'push',
        summary: prOpen
          ? `Push the new work to the pull request (${merged.length} task(s))`
          : `Merge ${project.integrationBranch} into ${project.baseBranch} (${merged.length} task(s))`,
        payload: {
          branch: project.integrationBranch,
          base: project.baseBranch,
          tasks: merged.map((t) => t.title),
        },
      });
      this.log('approval', `Waiting for you: ${approval.summary}`, {
        data: { approvalId: approval.id },
      });
    }
  }

  /* ── One task: build → test → review → merge ───────────────────────── */

  private async work(project: Project, task: Task): Promise<RoundOutcome> {
    project = this.expirePermissions(project);
    const permissions = builderPermissions(project.permissions, {
      ...(task.grants?.network && { grantNetwork: true }),
      ...(project.permissions.level === 3 && { commands: this.checkCommands(project) }),
    });
    const plan = builderPlan(project, task, this.ctx.adapters);
    // A seat whose CLI can't enforce these permissions never gets the task.
    const gaps: string[] = [];
    const seats = plan.seats.filter((s) => {
      const gap = this.ctx.adapters.get(s.provider)?.permissionGap?.(permissions);
      if (gap) gaps.push(gap);
      return !gap;
    });
    if (seats.length === 0) {
      const reason = `No builder on the team can work at these permissions. ${[...new Set(gaps)].join(' ')}`;
      this.projects.setStatus(this.projectId, 'paused', reason);
      this.log('stop', reason, { task });
      return { kind: 'idle', reason };
    }
    // Retries keep their escalation order; only a first, unpinned attempt is re-ranked.
    plan.seats = task.attempts === 0 && !task.pinnedSeat ? this.ranked('builder', seats) : seats;
    // Never more builders on one AI than its lane cap, counting every project.
    const free = plan.seats.filter((s) => this.builderRoom(s.provider));
    if (free.length === 0) {
      const reason = 'Every builder on the team is busy in other lanes';
      // Lanes park the task; one lane waits a little and looks again.
      return project.maxParallel > 1
        ? { kind: 'retry', task, reason }
        : { kind: 'waiting', until: Date.now() + 30_000, reason };
    }
    plan.seats = free;
    const pick = this.governor.pick(plan.seats);
    if (!pick.seat) return this.waiting('builder', pick);
    const builder = pick.seat;
    const note = plan.note && pick.seat === plan.seats[0] ? ` (${plan.note})` : '';

    task = this.projects.updateTask(task.id, { status: 'building', builtBy: builder.provider });
    this.log(
      'task',
      `${task.attempts ? `Attempt ${task.attempts + 1}` : 'Building'}: ${task.title} with ${seatLabel(builder)}${note}${levelNote(permissions)}`,
      {
        task,
        provider: builder.provider,
        data: { attempt: task.attempts + 1, seat: builder, permissions },
      },
    );

    const cwd = await this.workspace.createTaskTree(task.id);
    const install = task.grants?.install;
    if (install && isRunnableInstall(install)) {
      // You approved this exact command; Conclave runs it, not the agent.
      const ran = await runShell(install, {
        cwd,
        timeoutMs: this.testTimeout,
        ...(this.signal && { signal: this.signal }),
      });
      if (this.interrupted) return this.halt(task);
      const tail = ran.output.trim().slice(-3000);
      this.log('agent', `Ran ${install} (approved by you)`, { task, data: { output: tail } });
      // Never commit what a package manager downloads.
      const ignored = ensureIgnored(cwd, install);
      if (ignored) this.log('agent', `Added ${ignored} to .gitignore`, { task });
      if (ran.code !== 0) {
        return this.sendBack(project, task, {
          failure: this.failureOf('crash', `The approved install failed: ${install}`, tail, null),
          feedback: `The approved install command failed: ${install}\n\n${tail}`,
        });
      }
    }
    const built = await this.agent(
      'builder',
      builder,
      builderPrompt(project, task, {
        decisions: this.decisions(),
        decideYourself: this.mustDecide(task),
        ...(permissions.commands && { allowedCommands: permissions.commands }),
        network: permissions.network,
        ...(install && { installed: install }),
        ...(project.askPolicy === 'decide' && { decideAndTell: true }),
      }),
      cwd,
      false,
      task,
      permissions,
    );
    // A network grant is for one attempt only.
    if (task.grants?.network) {
      const { network: _used, ...rest } = task.grants;
      task = this.projects.updateTask(task.id, {
        grants: Object.keys(rest).length ? rest : null,
      });
    }
    if (this.interrupted) return this.halt(task);
    if (built.rateLimited) {
      // Not the task's fault: back to the queue for whoever has headroom.
      this.projects.updateTask(task.id, {
        status: 'queued',
        lastFailure: this.failureOf(
          'limit',
          `${seatLabel(builder)} hit a usage limit`,
          failure(built),
          builder,
        ),
      });
      await this.workspace.removeTaskTree(task.id);
      this.log('wait', `${seatLabel(builder)} hit a usage limit; the task goes back in the queue`, {
        task,
        provider: builder.provider,
      });
      return { kind: 'retry', task, reason: 'Builder hit a usage limit' };
    }
    if (!built.ok) {
      return this.sendBack(project, task, {
        failure: this.failureOf(
          'crash',
          `${seatLabel(builder)} stopped with an error`,
          failure(built),
          builder,
        ),
        feedback: `The builder failed: ${failure(built)}`,
      });
    }

    const asked = parseQuestion(built.text);
    if (asked) return this.ask(project, task, asked, builder, 'build');
    // Decide-and-tell: the choices the builder made become assumptions you can review.
    for (const a of parseAssumptions(built.text)) {
      this.ctx.store.decisions.add({
        projectId: this.projectId,
        kind: 'assumption',
        question: a.question,
        answer: a.answer,
        source: 'agent',
        provider: builder.provider,
        taskId: task.id,
      });
      this.log('decision', `Assumed: ${a.question} → ${a.answer}`, {
        task,
        provider: builder.provider,
      });
    }
    const commit = await this.workspace.commitTask(task.id, commitMessage(task, builder));
    if (!commit) {
      const prose = parseQuestion(built.text, { allowProse: true });
      if (prose) return this.ask(project, task, prose, builder, 'build');
      return this.sendBack(project, task, {
        failure: this.failureOf(
          'no_changes',
          `${seatLabel(builder)} finished without changing any files`,
          built.text.slice(0, 4000),
          builder,
        ),
        feedback: 'No files were changed. Make the change the task asks for.',
      });
    }
    this.log('commit', `Committed ${commit.slice(0, 8)}`, {
      task,
      provider: builder.provider,
      data: { commit, summary: built.text.slice(0, 1500) },
    });

    // Verify. Before a test command is adopted, the proposed one is checked here too,
    // so a first task never ships tests it couldn't run.
    let tests = '(no test command; review only)';
    const testCommand = testCommandOf(project);
    if (testCommand) {
      this.projects.updateTask(task.id, { status: 'verifying' });
      const run = await runShell(testCommand, {
        cwd,
        timeoutMs: this.testTimeout,
        ...(this.signal && { signal: this.signal }),
      });
      if (this.interrupted) return this.halt(task);
      const tail = run.output.trim().slice(-4000);
      if (run.code !== 0) {
        this.log('verify', run.timedOut ? 'Tests timed out' : `Tests failed (exit ${run.code})`, {
          task,
          data: { output: tail },
        });
        return this.sendBack(project, task, {
          failure: this.failureOf(
            'tests',
            run.timedOut ? 'The tests timed out' : `The tests failed (exit ${run.code})`,
            tail,
            builder,
          ),
          feedback: `${run.timedOut ? 'The test command timed out' : `The test command failed (exit ${run.code})`}: ${testCommand}\n\n${tail}`,
        });
      }
      tests = `${testCommand} passed in ${(run.durationMs / 1000).toFixed(1)}s.\n${tail.slice(-1500)}`;
      this.log('verify', `Tests passed in ${(run.durationMs / 1000).toFixed(1)}s`, { task });
    }

    // Web projects: screenshots and the free visual checks, before any AI reviews.
    if (this.opts.snapshotter) {
      const shots = await this.screenshots(project, task, cwd, commit);
      if (this.interrupted) return this.halt(task);
      if (shots?.kind === 'taken' && shots.checks.sendBack.length) {
        const found = shots.checks.sendBack;
        return this.sendBack(project, task, {
          failure: this.failureOf(
            'tests',
            `The visual checks found ${found.length} problem${found.length === 1 ? '' : 's'}`,
            found.join('\n'),
            builder,
          ),
          feedback: `The page has problems this change introduced, found by the visual checks (screenshots at desktop and phone width, light and dark). Fix them:\n${found.map((f) => `- ${f}`).join('\n')}`,
        });
      }
    }

    return this.review(project, this.projects.updateTask(task.id, { status: 'reviewing' }), tests);
  }

  /** Before and after screenshots of a task's pages, with the free visual checks (v0.8 C2, C4). */
  private async screenshots(
    project: Project,
    task: Task,
    cwd: string,
    commit: string,
  ): Promise<TaskShots | undefined> {
    if (detectPreview(cwd).kind === 'none') return undefined;
    const shots = await snapshotTask({
      store: this.ctx.store,
      home: this.opts.home,
      project,
      taskId: task.id,
      afterDir: cwd,
      afterCommit: commit,
      beforeDir: this.workspace.integrationPath,
      beforeCommit: await headCommit(this.workspace.integrationPath),
      snapshotter: this.opts.snapshotter!,
    });
    if (shots.kind === 'skipped') {
      this.log('verify', shots.reason, { task });
      return shots;
    }
    const n = shots.after.shots.length;
    const pages = new Set(shots.after.shots.map((s) => s.page)).size;
    const changed = shots.diffs.filter((d) => d.changed > 0.01).length;
    const problems = shots.checks.sendBack.length;
    this.log(
      'verify',
      `Screenshots: ${n} of ${pages} page${pages === 1 ? '' : 's'}${shots.before ? `, ${changed} changed` : ''}; ${
        problems ? `${problems} problem${problems === 1 ? '' : 's'} found` : 'no problems found'
      }`,
      {
        task,
        data: { snapshotSet: shots.after.id, before: shots.before?.id ?? null, ...shots.checks },
      },
    );
    return shots;
  }

  private async review(project: Project, task: Task, tests: string): Promise<RoundOutcome> {
    const avoid = task.builtBy ? [task.builtBy] : [];
    // Never the builder's own AI, unless the team has no other reviewer at all: when no other
    // AI is free, the task waits for one instead of being waved through by its author.
    let team = project.routing.reviewer.some((s) => s.provider !== task.builtBy)
      ? project.routing.reviewer.filter((s) => s.provider !== task.builtBy)
      : project.routing.reviewer;
    // Visual review: screenshots go to a reviewer that can see; others still review the code.
    let shots = project.visualReview ? this.reviewShots(project, task) : undefined;
    if (shots) {
      const seeing = team.filter((s) => this.vision(s.provider) !== 'none');
      if (seeing.length) team = seeing;
      else {
        this.log(
          'review',
          'No reviewer on the team can see images, so the screenshots are skipped',
          { task },
        );
        shots = undefined;
      }
    }
    // A reviewer that crashes or gives no verdict isn't the task's fault: ask the next one.
    const tried: ProviderId[] = [];
    let problem: { seat: Seat; detail: string } | undefined;
    let reviewer: Seat;
    let result: RunResult;
    let verdict: ReturnType<typeof parseReview>;
    let lines = 0;
    const goalCheck = this.goalCheck(project, task);
    for (;;) {
      const seats = this.ranked(
        'reviewer',
        team.filter((s) => !tried.includes(s.provider)),
      );
      const pick = this.governor.pick(seats, avoid);
      if (!pick.seat) {
        if (problem) {
          return this.sendBack(project, task, {
            failure: this.failureOf(
              'crash',
              `No reviewer gave a verdict (last: ${seatLabel(problem.seat)})`,
              problem.detail,
              problem.seat,
            ),
            feedback: task.feedback ?? '',
          });
        }
        this.projects.updateTask(task.id, { status: 'queued' });
        await this.workspace.removeTaskTree(task.id);
        return this.waiting('reviewer', tried.length ? this.governor.pick(team, avoid) : pick);
      }
      reviewer = pick.seat;
      const sameProvider = task.builtBy === reviewer.provider;
      this.log(
        'review',
        `Reviewing with ${seatLabel(reviewer)}${sameProvider ? ' (the only reviewer on this team)' : ''}`,
        { task, provider: reviewer.provider },
      );
      const diff = await this.workspace.taskDiff(task.id);
      lines = changedLines(diff.stat);
      const seen = shots && this.vision(reviewer.provider) !== 'none' ? shots : undefined;
      result = await this.agent(
        'reviewer',
        reviewer,
        reviewerPrompt(project, task, diff, tests, {
          decisions: this.decisions(),
          ...(goalCheck && { goalCheck }),
          ...(seen && {
            shots: {
              files: seen.files,
              attached: this.vision(reviewer.provider) === 'native',
              notes: seen.notes,
            },
          }),
        }),
        this.workspace.taskPath(task.id),
        true,
        task,
        undefined,
        seen && { images: seen.files.map((f) => f.path) },
      );
      if (this.interrupted) return this.halt(task);
      verdict = result.ok ? parseReview(result.text) : undefined;
      if (verdict) break;
      tried.push(reviewer.provider);
      const detail = result.rateLimited
        ? `${seatLabel(reviewer)} hit a usage limit`
        : result.ok
          ? `${seatLabel(reviewer)} replied without a verdict: ${result.text.slice(0, 1500) || '(empty reply)'}`
          : `${seatLabel(reviewer)} stopped with an error: ${failure(result)}`;
      if (!result.rateLimited) problem = { seat: reviewer, detail };
      this.log('review', `${detail.split('\n')[0]!.slice(0, 240)}; asking another reviewer`, {
        task,
        provider: reviewer.provider,
      });
    }

    this.projects.updateTask(task.id, { reviewedBy: reviewer.provider });
    if (!verdict.approve) {
      const asked = parseQuestion(result.text);
      if (asked) return this.ask(project, task, asked, reviewer, 'review');
    }
    if (!verdict.approve && verdict.visual?.length) {
      // What the reviewer saw: each problem with its screenshot, so the builder can open it.
      const byLabel = new Map(shots?.files.map((f) => [f.label, f.path]));
      const visual = verdict.visual.map((v) => {
        const path = byLabel.get(v.shot);
        const where = v.box ? ` (region ${v.box.join(', ')})` : '';
        return `- ${v.issue}${v.shot ? ` [${v.shot}${where}${path ? `: ${path}` : ''}]` : ''}`;
      });
      const code = verdict.issues.map((i) => `- ${i}`);
      this.log(
        'review',
        `${seatLabel(reviewer)} found visual problems${verdict.summary ? `: ${verdict.summary}` : ''}`,
        {
          task,
          provider: reviewer.provider,
          data: { issues: verdict.issues, visual: verdict.visual },
        },
      );
      return this.sendBack(project, task, {
        failure: this.failureOf(
          'visual',
          `${seatLabel(reviewer)} found ${verdict.visual.length} visual problem${verdict.visual.length === 1 ? '' : 's'}`,
          [...visual, ...code].join('\n'),
          reviewer,
        ),
        feedback: `Review by ${seatLabel(reviewer)}, who looked at the screenshots, asked for changes:\n${[...visual, ...code].join('\n')}`,
      });
    }
    if (!verdict.approve) {
      const issues = verdict.issues.length
        ? verdict.issues.map((i) => `- ${i}`).join('\n')
        : `The reviewer did not approve:\n${verdict.summary || result.text.slice(0, 3000)}`;
      this.log('review', `Changes requested${verdict.summary ? `: ${verdict.summary}` : ''}`, {
        task,
        provider: reviewer.provider,
        data: { issues: verdict.issues },
      });
      return this.sendBack(project, task, {
        failure: this.failureOf(
          'review',
          `${seatLabel(reviewer)} asked for changes${verdict?.summary ? `: ${verdict.summary}` : ''}`,
          issues,
          reviewer,
        ),
        feedback: `Review by ${seatLabel(reviewer)} asked for changes:\n${issues}`,
      });
    }
    this.log('review', `Approved${verdict.summary ? `: ${verdict.summary}` : ''}`, {
      task,
      provider: reviewer.provider,
    });

    const merged = await this.workspace.mergeTask(
      task.id,
      `conclave: merge "${task.title}"`,
      testCommandOf(project) ? (cwd) => this.runTests(project, cwd) : undefined,
    );
    if (this.interrupted) return this.halt(task);
    if (!merged.ok && merged.kind === 'conflict') {
      this.log('merge', 'Merge conflict with newer work; rebuilding on the latest code', {
        task,
        data: { conflict: merged.detail },
      });
      return this.sendBack(project, task, {
        failure: this.failureOf(
          'conflict',
          'The change conflicted with work merged meanwhile',
          merged.detail,
          null,
        ),
        feedback: `Merging conflicted with work merged meanwhile. Rebuild the change on the latest code.\n${merged.detail}`,
      });
    }
    if (!merged.ok) {
      this.log('merge', 'Tests fail once combined with work merged meanwhile; rebuilding', {
        task,
        data: { output: merged.detail },
      });
      return this.sendBack(project, task, {
        failure: this.failureOf(
          'combined_tests',
          'The tests fail once combined with work merged meanwhile',
          merged.detail,
          null,
        ),
        feedback: `Your change passed on its own but the tests fail once combined with work merged meanwhile. Rebuild it on the latest code so both work.\n\n${merged.detail}`,
      });
    }
    if (merged.retested)
      this.log('merge', 'Re-tested on top of work merged meanwhile: passed', { task });
    const done = this.projects.updateTask(task.id, {
      status: 'merged',
      mergeCommit: merged.commit,
      feedback: null,
      grants: null,
      actualLines: lines,
    });
    await this.workspace.removeTaskTree(task.id);
    this.log('merge', `Merged into ${project.integrationBranch} (${merged.commit.slice(0, 8)})`, {
      task: done,
      data: { commit: merged.commit },
    });
    await this.adoptProposedTests();
    if (goalCheck && verdict.goalMet === true) {
      // The reviewer read the whole result against the goal: no separate planner check needed.
      const blocker = await this.testsBlockDone(
        this.project(),
        this.projects.listTasks(this.projectId),
      );
      if (blocker) return blocker;
      const reason = `${seatLabel(reviewer)} checked the whole result against the goal: ${verdict.summary || 'every requirement is met'}`;
      this.finish(reason);
      return { kind: 'done', reason };
    }
    if (goalCheck && verdict.goalMet === false && verdict.goalGaps?.length) {
      this.gaps = verdict.goalGaps.slice(0, 10);
      this.log('review', `The goal isn't met yet: ${this.gaps.length} gap(s) for the next plan`, {
        task: done,
        provider: reviewer.provider,
        data: { gaps: this.gaps },
      });
    }
    return { kind: 'merged', task: done };
  }

  /** The team order for a role, adjusted by measured reliability, quota and (for reviews) speed. */
  private ranked(role: RankRole, seats: Seat[]): Seat[] {
    if (!this.project().adaptiveTeam) return seats;
    const ranked = rankSeats(
      seats,
      role,
      withPriors(role, seatStats(this.ctx.store.usage.roleRuns(role))),
      (p) => this.governor.utilization(p),
    );
    const note = ranked.reasons.join('; ');
    if (note && this.rankNotes.get(role) !== note) {
      this.log('plan', `${role[0]!.toUpperCase()}${role.slice(1)} order adjusted: ${note}`, {
        data: { role, order: ranked.seats.map((s) => s.provider) },
      });
    }
    this.rankNotes.set(role, note);
    return ranked.seats;
  }

  /** How a provider can look at images (from its adapter). */
  private vision(provider: ProviderId): 'native' | 'files' | 'none' {
    return this.ctx.adapters.get(provider)?.capabilities.vision ?? 'none';
  }

  /** The screenshots this task's reviewer should see, and the free checks' notes. */
  private reviewShots(
    project: Project,
    task: Task,
  ): { files: ReviewShot[]; notes: string[] } | undefined {
    const after = this.ctx.store.snapshots.forTask(project.id, task.id);
    if (!after?.shots.length) return undefined;
    const before = after.beforeId ? this.ctx.store.snapshots.get(after.beforeId) : undefined;
    return { files: pickReviewShots(after, before), notes: after.checks?.notes ?? [] };
  }

  /** The project's test command in `cwd`, for the merge queue's combined re-test. */
  private async runTests(project: Project, cwd: string): Promise<{ ok: boolean; output: string }> {
    const command = testCommandOf(project)!;
    const run = await runShell(command, {
      cwd,
      timeoutMs: this.testTimeout,
      ...(this.signal && { signal: this.signal }),
    });
    const tail = run.output.trim().slice(-4000);
    return {
      ok: run.code === 0,
      output: `${run.timedOut ? 'The test command timed out' : `${command} failed (exit ${run.code})`}:\n${tail}`,
    };
  }

  /**
   * The last queued task's reviewer also checks the whole goal, which saves a planner round.
   * Not when anything else is open: failed work, questions or other queued tasks.
   */
  private goalCheck(
    project: Project,
    task: Task,
  ): { merged: string[]; doneWhen: string | null } | undefined {
    const tasks = this.projects.listTasks(this.projectId).filter((t) => t.id !== task.id);
    const open = tasks.some((t) =>
      ['queued', 'blocked', 'failed', 'building', 'verifying', 'reviewing'].includes(t.status),
    );
    if (open || this.openQuestions().length) return undefined;
    return {
      merged: tasks.filter((t) => t.status === 'merged').map((t) => t.title),
      doneWhen: project.doneWhen,
    };
  }

  /**
   * Before a project without a test command is called done, its proposed command must pass.
   * If it fails, one task to make it pass is queued (only once; after that, done carries a note).
   */
  private async testsBlockDone(project: Project, tasks: Task[]): Promise<RoundOutcome | undefined> {
    const command = project.proposedTestCommand;
    if (project.testCommand || !command) return undefined;
    await this.adoptProposedTests();
    const after = this.project();
    if (after.testCommand) return undefined;
    const title = `Make the test command pass: ${command}`.slice(0, 200);
    if (tasks.some((t) => t.title === title)) return undefined;
    const run = await runShell(command, {
      cwd: this.workspace.integrationPath,
      timeoutMs: this.testTimeout,
      ...(this.signal && { signal: this.signal }),
    });
    const tail = run.output.trim().slice(-3000);
    const [task] = this.projects.addTasks(this.projectId, [
      {
        title,
        spec: `The planner considers the goal met, but the project's test command \`${command}\` fails on the merged code, so the tests have never run. Make \`${command}\` run every test and pass (fix the test script or the tests; don't delete tests). Its current output:\n\n${tail}`,
      },
    ]);
    this.log(
      'plan',
      `Not done yet: ${command} fails on the merged code, so a task to fix it is queued`,
      {
        task: task!,
        data: { output: tail },
      },
    );
    return { kind: 'planned', tasks: [task!] };
  }

  /** A project without tests adopts the planner's proposed command once it passes (C5). */
  private async adoptProposedTests(): Promise<void> {
    const project = this.project();
    const command = project.proposedTestCommand;
    if (project.testCommand || !command) return;
    const run = await runShell(command, {
      cwd: this.workspace.integrationPath,
      timeoutMs: this.testTimeout,
      ...(this.signal && { signal: this.signal }),
    });
    if (run.code !== 0) {
      this.log('verify', `The proposed test command doesn't pass yet: ${command}`);
      return;
    }
    this.projects.update(this.projectId, { testCommand: command, proposedTestCommand: null });
    this.ctx.store.decisions.add({
      projectId: this.projectId,
      kind: 'assumption',
      question: 'Test command',
      answer: `${command} (adopted once it passed)`,
      source: 'agent',
    });
    this.log('verify', `Adopted the test command: ${command}`);
  }

  /** Level 5 turns itself off after its time is up. */
  private expirePermissions(project: Project): Project {
    const p = project.permissions;
    if (p.level !== 5 || p.expiresAt === null || p.expiresAt > Date.now()) return project;
    const next = this.projects.update(this.projectId, {
      permissions: { ...p, level: 2, expiresAt: null },
    })!;
    this.log('stop', 'Full access expired; builders are back to editing files only');
    return next;
  }

  private checkCommands(project: Project): string[] {
    let scripts: Record<string, string> | undefined;
    try {
      const pkg = JSON.parse(
        readFileSync(join(this.workspace.integrationPath, 'package.json'), 'utf8'),
      ) as { scripts?: Record<string, string> };
      scripts = pkg.scripts;
    } catch {
      // not a Node project
    }
    return checkCommands(testCommandOf(project), scripts);
  }

  /* ── Questions ─────────────────────────────────────────────────────── */

  /**
   * An agent stopped to ask. Under the "ask" policy it goes to your inbox and the task waits;
   * under "decide" or "council" an assumption is recorded and the work goes on. Never counts
   * as an attempt.
   */
  private async ask(
    project: Project,
    task: Task | null,
    question: AgentQuestion,
    seat: Seat,
    stage: 'plan' | 'build' | 'review',
  ): Promise<RoundOutcome> {
    if (task) await this.workspace.removeTaskTree(task.id);
    if (task && this.questionCount(task) >= (this.opts.maxQuestionsPerTask ?? 3) * 2) {
      // It was told to decide and kept asking: that's the task failing, not a question.
      return this.sendBack(project, task, {
        failure: this.failureOf(
          'no_changes',
          `${seatLabel(seat)} kept asking questions instead of building`,
          question.question,
          seat,
        ),
        feedback:
          'Do not ask more questions. Make reasonable choices, note them, and build the task.',
      });
    }
    const payload = { ...question, stage, provider: seat.provider };
    if (question.permission && !task) {
      // A planner asking for an install has no task to apply your approval to; the builder asks.
      return this.settle(
        null,
        question,
        'Plan a task for it; that task’s builder asks for the install or network when it needs it.',
        'agent',
        seat,
      );
    }
    if (question.permission) {
      const auto = this.permissionPolicy(project, question);
      if (auto) return this.settle(task, question, auto.answer, auto.source, seat, auto.grants);
      return this.file(task, question.permission.kind, payload, seat);
    }
    const policy = this.mustDecide(task) ? 'decide' : project.askPolicy;
    if (policy === 'ask') return this.file(task, 'question', payload, seat);
    const council = policy === 'council' ? await this.councilAnswer(project, question) : undefined;
    const answer =
      council ??
      question.recommended ??
      question.options[0] ??
      'No answer from the user; make the most reasonable choice and note it.';
    return this.settle(task, question, answer, council ? 'council' : 'agent', seat);
  }

  /** What the project's switches say about an install or network request, if they settle it. */
  private permissionPolicy(
    project: Project,
    question: AgentQuestion,
  ): { answer: string; source: 'you'; grants?: Task['grants'] } | undefined {
    const permission = question.permission!;
    const alternative = permission.alternative ? ` Do it this way: ${permission.alternative}` : '';
    if (permission.kind === 'install') {
      if (project.permissions.installs === 'never') {
        return {
          answer: `No: this project doesn't allow installing dependencies.${alternative}`,
          source: 'you',
        };
      }
      if (project.permissions.installs === 'allow' && isRunnableInstall(permission.command)) {
        return {
          answer: `Yes, install with: ${permission.command}`,
          source: 'you',
          grants: { install: permission.command! },
        };
      }
      return undefined;
    }
    if (project.permissions.network === 'never') {
      return { answer: `No: this project works offline.${alternative}`, source: 'you' };
    }
    if (project.permissions.network === 'allow') {
      return { answer: 'Yes, for one attempt', source: 'you', grants: { network: true } };
    }
    return undefined;
  }

  /** File the question in your inbox; its task waits, other work goes on. */
  private file(
    task: Task | null,
    kind: 'question' | 'install' | 'network',
    payload: Record<string, unknown> & { question: string },
    seat: Seat,
  ): RoundOutcome {
    const approval = this.projects.requestApproval({
      projectId: this.projectId,
      taskId: task?.id ?? null,
      kind,
      summary: payload.question.slice(0, 300),
      payload,
    });
    const blocked = task
      ? this.projects.updateTask(task.id, { status: 'blocked', blockedBy: approval.id })
      : null;
    this.log('question', `${seatLabel(seat)} asks: ${payload.question}`, {
      ...(blocked && { task: blocked }),
      provider: seat.provider,
      data: { approvalId: approval.id, kind },
    });
    return { kind: 'asked', task: blocked, approvalId: approval.id, decided: false };
  }

  /** Record the answer as an assumption (or your standing rule) and requeue the task with it. */
  private settle(
    task: Task | null,
    question: AgentQuestion,
    answer: string,
    source: 'agent' | 'council' | 'you',
    seat: Seat,
    grants?: Task['grants'],
  ): RoundOutcome {
    this.ctx.store.decisions.add({
      projectId: this.projectId,
      kind: source === 'you' ? 'decision' : 'assumption',
      question: question.question,
      answer,
      source,
      provider: seat.provider,
      taskId: task?.id ?? null,
    });
    const requeued = task
      ? this.projects.updateTask(task.id, {
          status: 'queued',
          feedback: `${source === 'you' ? 'Settled by the project settings' : 'Assumption made'}: ${question.question} → ${answer}`,
          ...(grants && { grants: { ...task.grants, ...grants } }),
        })
      : null;
    this.log(
      'decision',
      `${source === 'council' ? 'The council decided' : source === 'you' ? 'Your settings decided' : 'Assumed'}: ${question.question} → ${answer}`,
      { ...(requeued && { task: requeued }), provider: seat.provider },
    );
    return { kind: 'asked', task: requeued, approvalId: null, decided: true };
  }

  /** A small vote among the reviewers: each picks one option; the majority wins. */
  private async councilAnswer(
    project: Project,
    question: AgentQuestion,
  ): Promise<string | undefined> {
    const members = project.routing.reviewer.slice(0, 3);
    const votes: string[] = [];
    for (const seat of members) {
      if (!this.governor.pick([seat]).seat) continue;
      const result = await this.agent(
        'reviewer',
        seat,
        councilPrompt(project, question, this.decisions()),
        this.workspace.integrationPath,
        true,
      );
      if (this.interrupted) return undefined;
      if (!result.ok) continue;
      const choice = pickChoice(result.text, question.options);
      if (choice) votes.push(choice);
    }
    if (votes.length === 0) return undefined;
    const tally = new Map<string, number>();
    for (const v of votes) tally.set(v, (tally.get(v) ?? 0) + 1);
    const best = Math.max(...tally.values());
    const winners = [...tally].filter(([, n]) => n === best).map(([v]) => v);
    return winners.find((w) => w === question.recommended) ?? winners[0];
  }

  /**
   * Record why an attempt didn't make it, then requeue with that feedback or give up
   * after maxAttempts. Some kinds are free: a merge conflict or a first CLI crash.
   */
  private async sendBack(
    project: Project,
    task: Task,
    { failure, feedback }: { failure: TaskFailure; feedback: string },
  ): Promise<RoundOutcome> {
    await this.workspace.removeTaskTree(task.id);
    const counted = countsAsAttempt(failure.kind, task.freeRetries);
    const attempts = task.attempts + (counted ? 1 : 0);
    const freeRetries = task.freeRetries + (counted ? 0 : 1);
    const data = { kind: failure.kind, counted, feedback: feedback.slice(0, 4000) };
    const provider = failure.provider ? { provider: failure.provider } : {};
    if (attempts >= project.maxAttempts) {
      const failed = this.projects.updateTask(task.id, {
        status: 'failed',
        attempts,
        feedback,
        lastFailure: failure,
      });
      this.log('fail', `Gave up after ${attempts} attempt(s): ${task.title}. ${failure.summary}`, {
        task: failed,
        ...provider,
        data,
      });
      return { kind: 'failed', task: failed, reason: failure.summary };
    }
    const queued = this.projects.updateTask(task.id, {
      status: 'queued',
      attempts,
      freeRetries,
      feedback,
      lastFailure: failure,
    });
    this.log(
      'retry',
      counted
        ? `Sent back (${attempts}/${project.maxAttempts}): ${failure.summary}`
        : `Trying again, not counted as an attempt: ${failure.summary}`,
      { task: queued, ...provider, data },
    );
    return { kind: 'retry', task: queued, reason: failure.summary };
  }

  private failureOf(
    kind: FailureKind,
    summary: string,
    detail: string,
    seat: Seat | null,
  ): TaskFailure {
    return {
      kind,
      summary,
      detail: detail.slice(0, 8000),
      provider: seat?.provider ?? null,
      model: seat?.model ?? null,
      at: Date.now(),
    };
  }

  private waiting(
    role: string,
    pick: { until: number | null; reasons: string[] } | { seat: Seat },
  ): RoundOutcome {
    const info = 'reasons' in pick ? pick : { until: null, reasons: [] };
    const paused =
      info.reasons.length > 0 && info.reasons.every((r) => r.endsWith('you paused everything'));
    const reason = paused
      ? 'Paused: you paused everything in Settings'
      : `No ${role} has headroom (${info.reasons.join('; ') || 'none configured'})`;
    this.log(
      'wait',
      info.until ? `${reason}; next reset ${new Date(info.until).toLocaleString()}` : reason,
      { data: { until: info.until } },
    );
    return { kind: 'waiting', until: info.until, reason };
  }

  /* ── Agents ────────────────────────────────────────────────────────── */

  private async agent(
    role: Role,
    seat: Seat,
    prompt: string,
    cwd: string,
    readOnly: boolean,
    task?: Task,
    permissions?: RunPermissions,
    extra: { images?: string[] } = {},
  ): Promise<RunResult> {
    const adapter = this.ctx.adapters.get(seat.provider);
    if (!adapter) throw new Error(`Provider not available: ${seat.provider}`);
    const seen = new Set<string>();
    const result = await collect(
      adapter.run({
        prompt,
        cwd,
        role,
        readOnly,
        ...(permissions && { permissions }),
        timeoutMs: this.agentTimeout,
        ...(this.signal && { signal: this.signal }),
        ...(seat.model && { model: seat.model }),
        ...(seat.effort && { effort: seat.effort }),
        ...(extra.images?.length && { images: extra.images }),
      }),
      (event: AgentEvent) => {
        // Log what agents touch, once per file or tool, without flooding the log.
        if (event.type === 'file.edit' && !seen.has(`f:${event.path}`)) {
          seen.add(`f:${event.path}`);
          this.log(
            'agent',
            `${event.kind === 'add' ? 'Created' : 'Edited'} ${displayPath(event.path, cwd)}`,
            {
              ...(task && { task }),
              provider: seat.provider,
            },
          );
        } else if (event.type === 'tool.call' && event.tool === 'shell') {
          const cmd = (event.input as { command?: unknown } | undefined)?.command;
          const text = displayCommand(Array.isArray(cmd) ? cmd.join(' ') : String(cmd ?? ''));
          if (text && !seen.has(`s:${text}`)) {
            seen.add(`s:${text}`);
            this.log('agent', `Ran ${text.slice(0, 200)}`, {
              ...(task && { task }),
              provider: seat.provider,
            });
          }
        }
      },
    );
    // Safety net for any provider: a failure that reads like a plan or spend limit is a limit,
    // so the work moves to the next provider and the task keeps its attempts.
    if (!result.ok && !result.rateLimited && looksLikeLimit(result.errors.join(' '))) {
      result.rateLimited = { message: result.errors[0] ?? 'usage limit reached' };
    }
    // Screenshots are counted on their own, so Usage can say what visual review costs.
    const pictures = (extra.images ?? []).reduce((n, path) => {
      try {
        return n + imageTokens(readFileSync(path));
      } catch {
        return n;
      }
    }, 0);
    recordUsage(
      this.ctx.store,
      {
        seat,
        role,
        source: 'project',
        refId: this.projectId,
        taskId: task?.id ?? null,
        ...(pictures && { imageTokens: pictures }),
      },
      result,
    );
    this.governor.observe(seat.provider, result);
    return result;
  }
}

/** Level 2 is the default and goes unsaid; anything else is spelled out in the log. */
function levelNote(p: RunPermissions): string {
  if (p.level === 2 && !p.network) return '';
  const what =
    p.level === 3
      ? `may run ${p.commands?.length ? p.commands.join(', ') : 'no commands'}`
      : p.level === 4
        ? 'may run any command in the worktree'
        : p.level === 5
          ? 'full access'
          : p.level === 1
            ? 'read only'
            : 'edit files';
  return ` · level ${p.level}: ${what}${p.network && p.level < 5 ? ', with network' : ''}`;
}

/** Package folders by installer; added to .gitignore after Conclave runs an install. */
const INSTALL_FOLDERS: [RegExp, string][] = [
  [/^(npm|pnpm|yarn|bun)\b/i, 'node_modules/'],
  [/^(uv|pip|pip3|python -m pip)\b/i, '.venv/'],
];

export function ensureIgnored(cwd: string, install: string): string | undefined {
  const folder = INSTALL_FOLDERS.find(([re]) => re.test(install.trim()))?.[1];
  if (!folder) return undefined;
  const file = join(cwd, '.gitignore');
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const lines = current.split(/\r?\n/).map((l) => l.trim());
  if (lines.includes(folder) || lines.includes(folder.replace(/\/$/, ''))) return undefined;
  writeFileSync(file, `${current}${current && !current.endsWith('\n') ? '\n' : ''}${folder}\n`);
  return folder;
}

function councilPrompt(project: Project, question: AgentQuestion, decisions: string): string {
  const options = question.options.length
    ? question.options.map((o) => `- ${o}`).join('\n')
    : '(free answer)';
  return `An agent on an autonomous coding project needs a product decision and the user isn't available. Choose the best answer.

PROJECT GOAL
${project.goal}
${decisions ? `\n${decisions}\n` : ''}
QUESTION
${question.question}${question.why ? `\n(Why it matters: ${question.why})` : ''}

OPTIONS
${options}

Reply with ONLY one JSON object: {"choice": "${question.options.length ? 'one of the options, exactly as written' : 'your answer in one sentence'}", "why": "one sentence"}`;
}

/** The member's choice, matched to an option when there are options. */
function pickChoice(text: string, options: string[]): string | undefined {
  const json = extractJson(text) as { choice?: unknown } | undefined;
  const choice = typeof json?.choice === 'string' ? json.choice.trim() : '';
  if (!choice) return undefined;
  if (options.length === 0) return choice.slice(0, 500);
  return options.find((o) => o.toLowerCase() === choice.toLowerCase());
}

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function failure(result: RunResult): string {
  return result.rateLimited?.message ?? result.errors[0] ?? 'no reply';
}

function commitMessage(task: Task, builder: Seat): string {
  return `conclave: ${task.title}\n\n${task.spec.slice(0, 1500)}\n\nBuilt by ${seatLabel(builder)} (task ${task.id}, attempt ${task.attempts + 1}).`;
}

function interruptibleSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** Paths inside the task's worktree read better relative to it. */
export function displayPath(path: string, cwd: string): string {
  if (!isAbsolute(path)) return path;
  const rel = relative(cwd, path);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.replace(/\\/g, '/') : path;
}

/** `"C:\\...\\powershell.exe" -Command "npm test"` → `npm test`; same for bash -lc / cmd /c. */
export function displayCommand(command: string): string {
  const wrapped =
    /^\s*"?[^"]*?(?:powershell(?:\.exe)?|pwsh(?:\.exe)?)"?\s+(?:-NoProfile\s+)?-Command\s+([\s\S]+)$/i.exec(
      command,
    ) ??
    /^\s*"?(?:\/usr)?\/bin\/(?:ba|z)?sh"?\s+-l?c\s+([\s\S]+)$/.exec(command) ??
    /^\s*"?[^"]*?cmd(?:\.exe)?"?\s+\/[cC]\s+([\s\S]+)$/.exec(command);
  let inner = (wrapped?.[1] ?? command).trim();
  if (
    (inner.startsWith('"') && inner.endsWith('"')) ||
    (inner.startsWith("'") && inner.endsWith("'"))
  ) {
    inner = inner.slice(1, -1);
  }
  return inner.replace(/\\"/g, '"');
}
