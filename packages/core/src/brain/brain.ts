import { isAbsolute, join, relative } from 'node:path';
import type {
  AgentEvent,
  BrainEvent,
  BrainEventKind,
  Project,
  ProviderId,
  Role,
  Seat,
  Task,
} from '@conclave/shared';
import { looksLikeLimit } from '../adapters/cli.js';
import { collect, type RunResult } from '../collect.js';
import { recordUsage, type EngineContext } from '../chat/service.js';
import { seatLabel } from '../chat/transcript.js';
import { Governor } from '../governor/governor.js';
import { runShell } from '../process.js';
import { Workspace } from '../workspace/git.js';
import { parsePlan, parseReview } from './json.js';
import { acquireLock } from './lock.js';
import { builderPrompt, plannerPrompt, reviewerPrompt } from './prompts.js';

export interface BrainOptions {
  /** Conclave's data folder; worktrees go under <home>/projects/<project id>. */
  home: string;
  governor?: Governor;
  maxTasksPerPlan?: number;
  /** Pause after this many tasks in a row fail with nothing merged in between. */
  maxFailureStreak?: number;
  agentTimeoutMs?: number;
  testTimeoutMs?: number;
  onEvent?: (event: BrainEvent) => void;
}

export type RoundOutcome =
  | { kind: 'planned'; tasks: Task[] }
  | { kind: 'merged'; task: Task }
  | { kind: 'retry'; task: Task; reason: string }
  | { kind: 'failed'; task: Task; reason: string }
  | { kind: 'waiting'; until: number | null; reason: string }
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
export class Brain {
  readonly workspace: Workspace;
  private readonly governor: Governor;
  private readonly maxTasks: number;
  private readonly agentTimeout: number;
  private readonly testTimeout: number;
  private started = false;
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
    this.governor = opts.governor ?? new Governor(() => ctx.store.listQuotas());
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
    return task ? this.work(project, task) : this.plan(project);
  }

  /** Keep doing rounds until the goal is met, the project is stopped, or `maxRounds` runs out. */
  async run(options: RunOptions = {}): Promise<RoundOutcome> {
    const lock = acquireLock(join(this.workspace.root, 'run.lock'));
    this.signal = options.signal;
    try {
      return await this.loop(options);
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
      if (last.kind === 'done' || last.kind === 'stopped' || last.kind === 'idle') return last;
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

  private async plan(project: Project): Promise<RoundOutcome> {
    const pick = this.governor.pick(project.routing.planner);
    if (!pick.seat) return this.waiting('planner', pick);

    const tasks = this.projects.listTasks(this.projectId);
    const { files, total } = await this.workspace.listFiles();
    const prompt = plannerPrompt(project, {
      files,
      totalFiles: total,
      history: await this.workspace.log(),
      merged: tasks.filter((t) => t.status === 'merged'),
      failed: tasks.filter((t) => t.status === 'failed'),
      queued: tasks.filter((t) => t.status === 'queued'),
      maxTasks: this.maxTasks,
    });
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
      this.log('error', 'The planner reply had no task list', {
        provider: pick.seat.provider,
        data: { reply: result.text.slice(0, 2000) },
      });
      return { kind: 'idle', reason: 'The planner reply had no task list' };
    }
    if (plan.done) {
      this.finish(plan.reason);
      return { kind: 'done', reason: plan.reason };
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
    const added = this.projects.addTasks(this.projectId, fresh);
    this.log('plan', `Planned ${added.length} task(s)`, {
      provider: pick.seat.provider,
      data: { tasks: added.map((t) => t.title) },
    });
    return { kind: 'planned', tasks: added };
  }

  private finish(reason: string): void {
    const project = this.project();
    const merged = this.projects.listTasks(this.projectId).filter((t) => t.status === 'merged');
    this.projects.setStatus(this.projectId, 'done', reason);
    this.log('done', `Goal met: ${reason}`);
    if (merged.length) {
      const approval = this.projects.requestApproval({
        projectId: this.projectId,
        kind: 'push',
        summary: `Merge ${project.integrationBranch} into ${project.baseBranch} (${merged.length} task(s))`,
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
    const pick = this.governor.pick(project.routing.builder);
    if (!pick.seat) return this.waiting('builder', pick);
    const builder = pick.seat;

    task = this.projects.updateTask(task.id, { status: 'building', builtBy: builder.provider });
    this.log(
      'task',
      `${task.attempts ? `Retrying (attempt ${task.attempts + 1})` : 'Building'}: ${task.title} with ${seatLabel(builder)}`,
      {
        task,
        provider: builder.provider,
      },
    );

    const cwd = await this.workspace.createTaskTree(task.id);
    const built = await this.agent(
      'builder',
      builder,
      builderPrompt(project, task),
      cwd,
      false,
      task,
    );
    if (this.interrupted) return this.halt(task);
    if (built.rateLimited) {
      // Not the task's fault: back to the queue for whoever has headroom.
      this.projects.updateTask(task.id, { status: 'queued' });
      await this.workspace.removeTaskTree(task.id);
      this.log('wait', `${seatLabel(builder)} hit a usage limit; the task goes back in the queue`, {
        task,
        provider: builder.provider,
      });
      return { kind: 'retry', task, reason: 'Builder hit a usage limit' };
    }
    if (!built.ok) return this.sendBack(project, task, `The builder failed: ${failure(built)}`);

    const commit = await this.workspace.commitTask(task.id, commitMessage(task, builder));
    if (!commit)
      return this.sendBack(
        project,
        task,
        'No files were changed. Make the change the task asks for.',
      );
    this.log('commit', `Committed ${commit.slice(0, 8)}`, {
      task,
      provider: builder.provider,
      data: { commit, summary: built.text.slice(0, 1500) },
    });

    // Verify.
    let tests = '(no test command; review only)';
    if (project.testCommand) {
      this.projects.updateTask(task.id, { status: 'verifying' });
      const run = await runShell(project.testCommand, {
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
        return this.sendBack(
          project,
          task,
          `${run.timedOut ? 'The test command timed out' : `The test command failed (exit ${run.code})`}: ${project.testCommand}\n\n${tail}`,
        );
      }
      tests = `${project.testCommand} passed in ${(run.durationMs / 1000).toFixed(1)}s.\n${tail.slice(-1500)}`;
      this.log('verify', `Tests passed in ${(run.durationMs / 1000).toFixed(1)}s`, { task });
    }

    return this.review(project, this.projects.updateTask(task.id, { status: 'reviewing' }), tests);
  }

  private async review(project: Project, task: Task, tests: string): Promise<RoundOutcome> {
    const avoid = task.builtBy ? [task.builtBy] : [];
    const pick = this.governor.pick(project.routing.reviewer, avoid);
    if (!pick.seat) {
      this.projects.updateTask(task.id, { status: 'queued' });
      await this.workspace.removeTaskTree(task.id);
      return this.waiting('reviewer', pick);
    }
    const reviewer = pick.seat;
    const sameProvider = task.builtBy === reviewer.provider;
    this.log(
      'review',
      `Reviewing with ${seatLabel(reviewer)}${sameProvider ? ' (no other provider free)' : ''}`,
      {
        task,
        provider: reviewer.provider,
      },
    );

    const diff = await this.workspace.taskDiff(task.id);
    const result = await this.agent(
      'reviewer',
      reviewer,
      reviewerPrompt(project, task, diff, tests),
      this.workspace.taskPath(task.id),
      true,
      task,
    );
    if (this.interrupted) return this.halt(task);
    if (result.rateLimited || !result.ok) {
      this.projects.updateTask(task.id, { status: 'queued' });
      await this.workspace.removeTaskTree(task.id);
      return result.rateLimited
        ? this.waiting('reviewer', this.governor.pick(project.routing.reviewer, avoid))
        : { kind: 'retry', task, reason: `Reviewer failed: ${failure(result)}` };
    }

    const verdict = parseReview(result.text);
    this.projects.updateTask(task.id, { reviewedBy: reviewer.provider });
    if (!verdict || !verdict.approve) {
      const issues = verdict?.issues.length
        ? verdict.issues.map((i) => `- ${i}`).join('\n')
        : `The reviewer did not approve:\n${result.text.slice(0, 3000)}`;
      this.log('review', `Changes requested${verdict?.summary ? `: ${verdict.summary}` : ''}`, {
        task,
        provider: reviewer.provider,
        data: { issues: verdict?.issues ?? [] },
      });
      return this.sendBack(
        project,
        task,
        `Review by ${seatLabel(reviewer)} asked for changes:\n${issues}`,
      );
    }
    this.log('review', `Approved${verdict.summary ? `: ${verdict.summary}` : ''}`, {
      task,
      provider: reviewer.provider,
    });

    const merged = await this.workspace.mergeTask(task.id, `conclave: merge "${task.title}"`);
    if (!merged.ok) {
      this.log('merge', 'Merge conflict with newer work; rebuilding on the latest code', {
        task,
        data: { conflict: merged.conflict },
      });
      return this.sendBack(
        project,
        task,
        `Merging conflicted with work merged meanwhile. Rebuild the change on the latest code.\n${merged.conflict}`,
      );
    }
    const done = this.projects.updateTask(task.id, {
      status: 'merged',
      mergeCommit: merged.commit,
      feedback: null,
    });
    await this.workspace.removeTaskTree(task.id);
    this.log('merge', `Merged into ${project.integrationBranch} (${merged.commit.slice(0, 8)})`, {
      task: done,
      data: { commit: merged.commit },
    });
    return { kind: 'merged', task: done };
  }

  /** Record why an attempt didn't make it; requeue with that feedback or give up after maxAttempts. */
  private async sendBack(project: Project, task: Task, feedback: string): Promise<RoundOutcome> {
    const attempts = task.attempts + 1;
    await this.workspace.removeTaskTree(task.id);
    if (attempts >= project.maxAttempts) {
      const failed = this.projects.updateTask(task.id, { status: 'failed', attempts, feedback });
      this.log('fail', `Gave up after ${attempts} attempt(s): ${task.title}`, {
        task: failed,
        data: { feedback: feedback.slice(0, 4000) },
      });
      return { kind: 'failed', task: failed, reason: firstLine(feedback) };
    }
    const queued = this.projects.updateTask(task.id, { status: 'queued', attempts, feedback });
    this.log('retry', `Sent back (${attempts}/${project.maxAttempts}): ${firstLine(feedback)}`, {
      task: queued,
      data: { feedback: feedback.slice(0, 4000) },
    });
    return { kind: 'retry', task: queued, reason: firstLine(feedback) };
  }

  private waiting(
    role: string,
    pick: { until: number | null; reasons: string[] } | { seat: Seat },
  ): RoundOutcome {
    const info = 'reasons' in pick ? pick : { until: null, reasons: [] };
    const reason = `No ${role} has headroom (${info.reasons.join('; ') || 'none configured'})`;
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
        timeoutMs: this.agentTimeout,
        ...(this.signal && { signal: this.signal }),
        ...(seat.model && { model: seat.model }),
        ...(seat.effort && { effort: seat.effort }),
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
    recordUsage(
      this.ctx.store,
      { seat, role, source: 'project', refId: this.projectId, taskId: task?.id ?? null },
      result,
    );
    this.governor.observe(seat.provider, result);
    return result;
  }
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

function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .find((l) => l.trim())
      ?.slice(0, 200) ?? text.slice(0, 200)
  );
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
