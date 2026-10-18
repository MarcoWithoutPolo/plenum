import type { BrainEvent, Project, Seat, Task } from '@conclave/shared';
import { Brain, createProject, parseSeat, seatLabel, type Engine } from '@conclave/core';
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
}

const USAGE = `Usage:
  conclave project new <repo> --goal "..." [--test "npm test"] [--done "..."]
                       [--planner claude:opus] [--builder codex@low,claude] [--reviewer claude]
  conclave project list
  conclave project status <id>
  conclave project run <id> [--rounds N]     work until the goal is met (Ctrl+C stops)
  conclave project stop <id>                 stop a running project after its current step`;

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
    const tasks = engine.store.projects.listTasks(p.id);
    const merged = tasks.filter((t) => t.status === 'merged').length;
    console.log(
      `${shortId(p.id)}  ${p.name.padEnd(24).slice(0, 24)}  ${statusText(p).padEnd(22)} ${dim(`${merged}/${tasks.length} tasks merged`)}`,
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
  console.log(`\n${bold('Tasks')}`);
  if (!tasks.length) console.log(dim('  none yet — the planner adds them on the first run'));
  for (const t of tasks) console.log(`  ${taskMark(t)} ${t.title}${dim(taskMeta(t))}`);

  const pending = projects.approvals(project.id, 'pending');
  if (pending.length) {
    console.log(`\n${bold('Waiting for you')}`);
    for (const a of pending) console.log(`  ${paint('yellow', '●')} ${a.summary}`);
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
    default:
      return paint('cyan', '◐');
  }
}

function taskMeta(t: Task): string {
  const parts: string[] = [];
  if (t.status !== 'merged' && t.status !== 'queued') parts.push(t.status);
  if (t.builtBy) parts.push(`built by ${t.builtBy}`);
  if (t.reviewedBy) parts.push(`reviewed by ${t.reviewedBy}`);
  if (t.attempts) parts.push(`${t.attempts} retr${t.attempts === 1 ? 'y' : 'ies'}`);
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
