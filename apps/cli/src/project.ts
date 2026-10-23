import type { BrainEvent, Project, Seat, Task } from '@conclave/shared';
import {
  Brain,
  QUESTION_KINDS,
  createProject,
  decideApproval,
  parseSeat,
  retryTask,
  seatLabel,
  skipTask,
  type Engine,
} from '@conclave/core';
import { taskProgress, type QuestionPayload } from '@conclave/shared';
import { bold, dim, paint, shortId } from './format.js';

export interface ProjectArgs {
  sub: string | undefined;
  rest: string[];
  goal?: string;
  test?: string;
  done?: string;
  planner?: string;
  builder?: string;
  reviewer?: string;
  attempts?: string;
  rounds?: string;
  use?: string;
  effortUp?: boolean;
}

const USAGE = `Usage:
  conclave project new <repo> --goal "..." [--test "npm test"] [--done "..."]
                       [--planner claude:opus] [--builder codex@low,claude] [--reviewer claude]
  conclave project list
  conclave project status <id>
  conclave project run <id> [--rounds N]     work until the goal is met (Ctrl+C stops)
  conclave project stop <id>                 stop a running project after its current step
  conclave project retry <task> [--use claude:opus@high] [--effort-up]
                                             requeue a failed or skipped task with fresh attempts
  conclave project skip <task>               leave a task out of the plan
  conclave project answer <question> "..."   answer an agent's question (or: yes / no for installs)
  conclave project decisions <id>            what's been decided and assumed
  conclave project decide <id> "question" "answer"   add a decision`;

export async function projectCommand(engine: Engine, args: ProjectArgs): Promise<number> {
  switch (args.sub) {
    case 'new':
      return create(engine, args);
    case 'list':
      return list(engine);
    case 'status':
      return status(engine, args.rest[0]);
    case 'run':
      return run(engine, args.rest[0], args.rounds);
    case 'stop':
      return stop(engine, args.rest[0]);
    case 'retry':
      return retry(engine, args);
    case 'skip':
      return skip(engine, args.rest[0]);
    case 'answer':
      return answer(engine, args.rest[0], args.rest.slice(1).join(' '));
    case 'decisions':
      return decisions(engine, args.rest[0]);
    case 'decide':
      return decide(engine, args.rest[0], args.rest[1], args.rest[2]);
    default:
      console.log(USAGE);
      return args.sub ? 1 : 0;
  }
}

const seats = (text: string | undefined): Seat[] | undefined =>
  text ? text.split(',').map((s) => parseSeat(s)) : undefined;

async function create(engine: Engine, args: ProjectArgs): Promise<number> {
  const repo = args.rest[0];
  if (!repo || !args.goal) {
    console.error(USAGE);
    return 1;
  }
  const routing = {
    ...(args.planner && { planner: seats(args.planner)! }),
    ...(args.builder && { builder: seats(args.builder)! }),
    ...(args.reviewer && { reviewer: seats(args.reviewer)! }),
  };
  const project = await createProject(engine.store, await engine.readySeats(), {
    repoPath: repo,
    goal: args.goal,
    ...(args.test && { testCommand: args.test }),
    ...(args.done && { doneWhen: args.done }),
    ...(Object.keys(routing).length && { routing }),
    ...(args.attempts && { maxAttempts: Number(args.attempts) }),
  });
  console.log(`${bold('Project created')} ${dim(shortId(project.id))}  ${project.name}`);
  printRouting(project);
  console.log(
    dim(
      `\nWork happens on ${project.integrationBranch}; your ${project.baseBranch} branch and files are left alone.`,
    ),
  );
  console.log(dim(`Start it with: conclave project run ${shortId(project.id)}`));
  return 0;
}

function list(engine: Engine): number {
  const projects = engine.store.projects.list();
  if (!projects.length) {
    console.log('No projects yet. Create one with: conclave project new <repo> --goal "..."');
    return 0;
  }
  for (const p of projects) {
    console.log(
      `${shortId(p.id)}  ${p.name.padEnd(24).slice(0, 24)}  ${statusText(p).padEnd(22)} ${dim(progressText(engine.store.projects.listTasks(p.id)))}`,
    );
  }
  return 0;
}

function find(engine: Engine, id: string | undefined): Project | undefined {
  const project = id ? engine.store.projects.find(id) : undefined;
  if (!project)
    console.error(id ? `No project found for "${id}". See: conclave project list` : USAGE);
  return project;
}

function status(engine: Engine, id: string | undefined): number {
  const project = find(engine, id);
  if (!project) return 1;
  const projects = engine.store.projects;
  console.log(`${bold(project.name)} ${dim(shortId(project.id))}  ${statusText(project)}`);
  console.log(`${dim('Goal')}   ${project.goal}`);
  if (project.testCommand) console.log(`${dim('Tests')}  ${project.testCommand}`);
  console.log(
    `${dim('Repo')}   ${project.repoPath} ${dim(`(${project.integrationBranch} ← work, ${project.baseBranch} untouched)`)}`,
  );
  printRouting(project);

  const tasks = projects.listTasks(project.id);
  console.log(`\n${bold('Tasks')} ${tasks.length ? dim(progressText(tasks)) : ''}`);
  if (!tasks.length) console.log(dim('  none yet — the planner adds them on the first run'));
  for (const t of tasks) {
    if (t.status === 'replaced') continue;
    console.log(`  ${taskMark(t)} ${t.title}${dim(taskMeta(t))} ${dim(shortId(t.id))}`);
    if (t.status === 'failed' && t.lastFailure) {
      console.log(`      ${paint('red', t.lastFailure.summary)}`);
    }
    for (const earlier of tasks.filter((e) => e.replacedBy === t.id)) {
      console.log(dim(`      earlier attempt: ${earlier.title}`));
    }
  }

  const pending = projects.approvals(project.id, 'pending');
  if (pending.length) {
    console.log(`\n${bold('Waiting for you')}`);
    for (const a of pending) {
      console.log(`  ${paint('yellow', '●')} ${a.summary} ${dim(shortId(a.id))}`);
      if (QUESTION_KINDS.has(a.kind)) {
        const q = a.payload as QuestionPayload;
        if (q.options?.length) console.log(dim(`      options: ${q.options.join(' | ')}`));
        if (q.permission?.command) console.log(dim(`      command: ${q.permission.command}`));
      }
    }
    if (pending.some((a) => QUESTION_KINDS.has(a.kind))) {
      console.log(dim('  Answer with: conclave project answer <id> "your answer"'));
    }
    console.log(
      dim(
        `  To take the work into ${project.baseBranch}: cd "${project.repoPath}" && git merge ${project.integrationBranch}`,
      ),
    );
  }

  const events = projects.events(project.id).slice(-15);
  if (events.length) {
    console.log(`\n${bold('Recent activity')}`);
    for (const e of events) console.log(formatEvent(e));
  }
  return 0;
}

async function run(
  engine: Engine,
  id: string | undefined,
  rounds: string | undefined,
): Promise<number> {
  const project = find(engine, id);
  if (!project) return 1;
  const controller = new AbortController();
  let interrupts = 0;
  const onSigint = () => {
    interrupts++;
    if (interrupts === 1) {
      console.log(dim('\nStopping after the current step… (Ctrl+C again to quit now)'));
      engine.store.projects.setStatus(project.id, 'stopped', 'Stopped by you');
      controller.abort();
    } else {
      process.exit(130);
    }
  };
  process.on('SIGINT', onSigint);

  console.log(`${bold(project.name)} ${dim(`· ${project.goal}`)}`);
  const brain = new Brain(engine, project.id, {
    home: engine.home,
    onEvent: (e) => console.log(formatEvent(e)),
  });
  try {
    const outcome = await brain.run({
      signal: controller.signal,
      ...(rounds && { maxRounds: Number(rounds) }),
    });
    const after = engine.store.projects.get(project.id)!;
    console.log(
      `\n${bold('Finished:')} ${outcome.kind === 'done' ? paint('green', 'goal met') : outcome.kind} ${dim('reason' in outcome ? `· ${outcome.reason}` : '')}`,
    );
    console.log(
      dim(`Status: ${statusText(after)} · conclave project status ${shortId(project.id)}`),
    );
    return outcome.kind === 'done' || outcome.kind === 'stopped' ? 0 : 1;
  } finally {
    process.off('SIGINT', onSigint);
  }
}

function findTask(engine: Engine, id: string | undefined) {
  const task = id ? engine.store.projects.findTask(id) : undefined;
  if (!task)
    console.error(id ? `No task found for "${id}". See: conclave project status <id>` : USAGE);
  return task;
}

function retry(engine: Engine, args: ProjectArgs): number {
  const task = findTask(engine, args.rest[0]);
  if (!task) return 1;
  const next = retryTask(
    engine.store.projects,
    task.id,
    {
      ...(args.use && { seat: parseSeat(args.use) }),
      ...(args.effortUp && { effortUp: true }),
    },
    engine.adapters,
  );
  const project = engine.store.projects.get(task.projectId)!;
  if (project.status === 'done' || project.status === 'paused') {
    engine.store.projects.setStatus(project.id, 'idle', 'Ready to resume');
  }
  console.log(
    `Queued ${bold(next.title)}${next.pinnedSeat ? ` for ${seatLabel(next.pinnedSeat)}` : ''}. Run it with: conclave project run ${shortId(project.id)}`,
  );
  return 0;
}

function skip(engine: Engine, id: string | undefined): number {
  const task = findTask(engine, id);
  if (!task) return 1;
  skipTask(engine.store.projects, task.id);
  console.log(`Skipped ${bold(task.title)}.`);
  return 0;
}

async function answer(engine: Engine, id: string | undefined, text: string): Promise<number> {
  const approval = id ? engine.store.projects.findApproval(id) : undefined;
  if (!approval || !QUESTION_KINDS.has(approval.kind) || !text.trim()) {
    console.error(USAGE);
    return 1;
  }
  // Install and network requests take yes or no; words after it are a note (or the alternative).
  const word = /^(yes|y|ok|allow|approve|no|n|decline)\b[\s,:]*/i.exec(text.trim());
  const no = word ? /^(no|n|decline)$/i.test(word[1]!) : false;
  const note = word ? text.trim().slice(word[0].length) : text.trim();
  const isQuestion = approval.kind === 'question';
  const outcome = await decideApproval(
    engine,
    engine.home,
    approval.id,
    !isQuestion && no ? 'rejected' : 'approved',
    isQuestion ? text : note || undefined,
  );
  if (!outcome.ok) {
    console.error(outcome.error);
    return 1;
  }
  console.log(`Recorded. ${dim('The waiting task is back in the queue.')}`);
  return 0;
}

function decisions(engine: Engine, id: string | undefined): number {
  const project = find(engine, id);
  if (!project) return 1;
  const all = engine.store.decisions.list(project.id);
  if (!all.length) {
    console.log('Nothing decided yet.');
    return 0;
  }
  for (const kind of ['decision', 'assumption'] as const) {
    const items = all.filter((d) => d.kind === kind && d.status === 'active');
    if (!items.length) continue;
    console.log(bold(kind === 'decision' ? 'Decisions' : 'Assumptions'));
    for (const d of items) console.log(`  ${d.question}: ${d.answer} ${dim(`· ${d.source}`)}`);
  }
  return 0;
}

function decide(
  engine: Engine,
  id: string | undefined,
  question: string | undefined,
  text: string | undefined,
): number {
  const project = find(engine, id);
  if (!project || !question?.trim() || !text?.trim()) {
    if (project) console.error(USAGE);
    return 1;
  }
  engine.store.decisions.add({
    projectId: project.id,
    kind: 'decision',
    question,
    answer: text,
    source: 'you',
  });
  console.log(`Decided: ${question} → ${text}`);
  return 0;
}

function progressText(tasks: Task[]): string {
  const p = taskProgress(tasks);
  return [
    `${p.merged} of ${p.total} merged`,
    p.failed && `${p.failed} failed`,
    p.blocked && `${p.blocked} waiting for you`,
    p.skipped && `${p.skipped} skipped`,
  ]
    .filter(Boolean)
    .join(' · ');
}

function stop(engine: Engine, id: string | undefined): number {
  const project = find(engine, id);
  if (!project) return 1;
  engine.store.projects.setStatus(project.id, 'stopped', 'Stopped by you');
  engine.store.projects.log({ projectId: project.id, kind: 'stop', message: 'Stopped by you' });
  console.log(`Stopped ${project.name}. A running brain halts after its current step.`);
  return 0;
}

/* ── Formatting ──────────────────────────────────────────────────────── */

function printRouting(project: Project) {
  const show = (seats: Seat[]) => seats.map(seatLabel).join(' → ') || 'none';
  console.log(`${dim('Plans')}  ${show(project.routing.planner)}`);
  console.log(`${dim('Builds')} ${show(project.routing.builder)}`);
  console.log(`${dim('Reviews')} ${show(project.routing.reviewer)}`);
}

function statusText(p: Project): string {
  const colors = {
    draft: 'gray',
    needs_you: 'yellow',
    running: 'green',
    waiting: 'yellow',
    done: 'green',
    stopped: 'red',
    paused: 'yellow',
    idle: 'gray',
  } as const;
  return (
    paint(colors[p.status], p.status) +
    (p.statusReason && p.status !== 'running' ? dim(` · ${p.statusReason.slice(0, 80)}`) : '')
  );
}

function taskMark(t: Task): string {
  switch (t.status) {
    case 'merged':
      return paint('green', '✓');
    case 'failed':
      return paint('red', '✗');
    case 'queued':
      return dim('○');
    case 'skipped':
      return dim('–');
    case 'blocked':
      return paint('yellow', '?');
    default:
      return paint('cyan', '◐');
  }
}

function taskMeta(t: Task): string {
  const parts: string[] = [];
  if (t.status !== 'merged' && t.status !== 'queued') parts.push(t.status);
  if (t.pinnedSeat) parts.push(`pinned to ${seatLabel(t.pinnedSeat)}`);
  if (t.builtBy) parts.push(`built by ${t.builtBy}`);
  if (t.reviewedBy) parts.push(`reviewed by ${t.reviewedBy}`);
  if (t.attempts) parts.push(`${t.attempts} attempt${t.attempts === 1 ? '' : 's'} used`);
  return parts.length ? `  ${parts.join(' · ')}` : '';
}

const KIND_STYLE: Record<string, [string, Parameters<typeof paint>[0]]> = {
  start: ['▶', 'cyan'],
  plan: ['◆', 'magenta'],
  task: ['▸', 'cyan'],
  agent: ['·', 'gray'],
  commit: ['●', 'blue'],
  verify: ['✓', 'green'],
  review: ['◎', 'magenta'],
  merge: ['⇢', 'green'],
  retry: ['↺', 'yellow'],
  fail: ['✗', 'red'],
  wait: ['⏸', 'yellow'],
  done: ['★', 'green'],
  stop: ['■', 'red'],
  error: ['!', 'red'],
  approval: ['?', 'yellow'],
};

export function formatEvent(e: BrainEvent): string {
  const [mark, color] = KIND_STYLE[e.kind] ?? ['·', 'gray'];
  const time = new Date(e.at).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const failedVerify = e.kind === 'verify' && /failed|timed out/i.test(e.message);
  const who = e.provider ? dim(` [${e.provider}]`) : '';
  return `${dim(time)} ${paint(failedVerify ? 'red' : color, failedVerify ? '✗' : mark)} ${e.kind === 'agent' ? dim(e.message) : e.message}${who}`;
}
