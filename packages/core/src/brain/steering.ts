import { existsSync } from 'node:fs';
import { SteeringAction, type Project, type SteeringMessage, type Task } from '@conclave/shared';
import { collect } from '../collect.js';
import { recordUsage, type EngineContext } from '../chat/service.js';
import { seatLabel } from '../chat/transcript.js';
import { decisionsSection } from '../store/decisions.js';
import type { ProjectStore } from '../store/projects.js';
import { extractJson } from './json.js';
import { skipTask } from './recovery.js';

/* ── Board actions: instant, no AI ─────────────────────────────────── */

const WAITING: Task['status'][] = ['queued', 'blocked'];

/** Move a waiting task one place up or down among the waiting tasks. */
export function moveTask(projects: ProjectStore, taskId: string, direction: 'up' | 'down'): Task {
  const task = must(projects, taskId);
  const waiting = projects.listTasks(task.projectId).filter((t) => WAITING.includes(t.status));
  const i = waiting.findIndex((t) => t.id === task.id);
  if (i < 0) throw new Error('Only tasks that haven’t started can be moved.');
  const other = waiting[direction === 'up' ? i - 1 : i + 1];
  if (!other) return task;
  projects.updateTask(other.id, { priority: task.priority });
  const moved = projects.updateTask(task.id, { priority: other.priority });
  // Keep the order a task is moved into: it no longer waits for the one it jumped.
  if (moved.after.includes(other.id))
    projects.updateTask(moved.id, { after: moved.after.filter((a) => a !== other.id) });
  projects.log({
    projectId: task.projectId,
    taskId: task.id,
    kind: 'task',
    message: `You moved ${task.title} ${direction === 'up' ? 'above' : 'below'} ${other.title}`,
  });
  return projects.getTask(task.id)!;
}

/** Put a waiting task right before another waiting task (or last, with null). */
export function placeTask(projects: ProjectStore, taskId: string, before: string | null): Task {
  const task = must(projects, taskId);
  if (!WAITING.includes(task.status))
    throw new Error('Only tasks that haven’t started can be moved.');
  const waiting = projects
    .listTasks(task.projectId)
    .filter((t) => WAITING.includes(t.status) && t.id !== task.id);
  const at = before ? waiting.findIndex((t) => t.id === before) : waiting.length;
  if (at < 0) throw new Error('That task has already started or doesn’t exist.');
  const order = [...waiting.slice(0, at), task, ...waiting.slice(at)];
  const slots = [...order.map((t) => t.priority)].sort((a, b) => a - b);
  order.forEach((t, i) => {
    if (t.priority !== slots[i]) projects.updateTask(t.id, { priority: slots[i]! });
  });
  const ahead = new Set(order.slice(at + 1).map((t) => t.id));
  if (task.after.some((a) => ahead.has(a)))
    projects.updateTask(task.id, { after: task.after.filter((a) => !ahead.has(a)) });
  projects.log({
    projectId: task.projectId,
    taskId: task.id,
    kind: 'task',
    message: before
      ? `You moved ${task.title} before ${waiting[at]!.title}`
      : `You moved ${task.title} to the end`,
  });
  return projects.getTask(task.id)!;
}

/** Change a task's title or spec. A task in flight picks the change up on its next attempt. */
export function editTask(
  projects: ProjectStore,
  taskId: string,
  patch: { title?: string; spec?: string },
): Task {
  const task = must(projects, taskId);
  if (['merged', 'skipped', 'replaced'].includes(task.status))
    throw new Error(`A ${task.status} task can’t be edited.`);
  const next = projects.updateTask(task.id, {
    ...(patch.title?.trim() && { title: patch.title.trim().slice(0, 200) }),
    ...(patch.spec?.trim() && { spec: patch.spec.trim() }),
  });
  const live = ['building', 'verifying', 'reviewing'].includes(task.status);
  projects.log({
    projectId: task.projectId,
    taskId: task.id,
    kind: 'task',
    message: `You edited ${next.title}${live ? ' (applies from its next attempt)' : ''}`,
  });
  return next;
}

/** A task you add yourself, last in the queue, optionally after others. */
export function addTask(
  projects: ProjectStore,
  projectId: string,
  input: { title: string; spec: string; after?: string[] },
): Task {
  const known = new Set(projects.listTasks(projectId).map((t) => t.id));
  const [task] = projects.addTasks(projectId, [
    {
      title: input.title,
      spec: input.spec || input.title,
      after: (input.after ?? []).filter((id) => known.has(id)),
    },
  ]);
  projects.log({ projectId, taskId: task!.id, kind: 'task', message: `You added ${task!.title}` });
  return task!;
}

function must(projects: ProjectStore, taskId: string): Task {
  const task = projects.getTask(taskId);
  if (!task) throw new Error(`No such task: ${taskId}`);
  return task;
}

/* ── Tell the project: the planner proposes, you apply ─────────────── */

export function steeringPrompt(
  project: Project,
  tasks: Task[],
  activity: string[],
  decisions: string,
  history: SteeringMessage[],
  text: string,
): string {
  const row = (t: Task) =>
    `- ${t.id} [${t.status}] ${t.title}${t.after.length ? ` (after ${t.after.join(', ')})` : ''}`;
  return `You help steer an autonomous coding project that is already underway. The user just wrote to you. Answer them, and propose board changes only if their message asks for changes.

GOAL
${project.goal}
${decisions ? `\n${decisions}\n` : ''}
TASKS (id [status] title)
${tasks.map(row).join('\n') || '- none yet'}

RECENT ACTIVITY (newest last)
${activity.join('\n') || '(none)'}
${history.length ? `\nEARLIER IN THIS CHAT\n${history.map((m) => `${m.role === 'you' ? 'User' : 'You'}: ${m.text}`).join('\n')}\n` : ''}
THE USER SAYS
${text}

You can read files in the working directory to answer. Don't change any files.

Reply with ONLY one JSON object:
{"reply": "one or two plain sentences to the user", "actions": [ ... ]}
Actions (only what the user asked for; [] when they only asked a question):
- {"type": "add_task", "title": "short imperative", "spec": "what to do and how it's checked", "after": ["task ids it waits for"]}
- {"type": "edit_task", "id": "k_…", "title": "…", "spec": "…"}  (only queued or failed tasks, or a running one for its next attempt)
- {"type": "skip_task", "id": "k_…"}  (queued, waiting or failed tasks)
- {"type": "move_task", "id": "k_…", "before": "k_… or null for last"}  (queued tasks)
- {"type": "decision", "question": "…", "answer": "…"}  (something the user decided, for every agent to follow)
- {"type": "pause"}  (stop starting new steps; running ones finish)
Use ids exactly as listed.`;
}

/** The planner's reply and the actions that are valid; anything malformed is left out. */
export function parseSteering(text: string): { reply: string; actions: SteeringAction[] } {
  const json = extractJson(text) as { reply?: unknown; actions?: unknown } | undefined;
  if (!json || typeof json !== 'object') return { reply: text.trim().slice(0, 2000), actions: [] };
  const actions = Array.isArray(json.actions)
    ? json.actions.flatMap((a) => {
        const parsed = SteeringAction.safeParse(a);
        return parsed.success ? [parsed.data] : [];
      })
    : [];
  return {
    reply:
      typeof json.reply === 'string' && json.reply.trim()
        ? json.reply.trim()
        : 'Here’s what I’d change.',
    actions: actions.slice(0, 12),
  };
}

/**
 * You write to the project; the first signed-in planner on its team answers, read-only,
 * with a proposal. Nothing on the board changes until you apply it.
 */
export async function steer(
  ctx: EngineContext,
  project: Project,
  cwd: string,
  text: string,
): Promise<{ you: SteeringMessage; planner: SteeringMessage }> {
  const store = ctx.store;
  const history = store.steering.list(project.id, 10);
  const you = store.steering.add({ projectId: project.id, role: 'you', text });
  const seat = project.routing.planner.find((s) => ctx.adapters.has(s.provider));
  if (!seat) throw new Error('No planner on this project’s team is available.');
  const adapter = ctx.adapters.get(seat.provider)!;
  const activity = store.projects
    .events(project.id, { latest: 30 })
    .map((e) => `${new Date(e.at).toLocaleTimeString()} ${e.message.slice(0, 200)}`);
  const prompt = steeringPrompt(
    project,
    store.projects.listTasks(project.id).filter((t) => t.status !== 'replaced'),
    activity,
    decisionsSection(store.decisions.list(project.id, { status: 'active' })),
    history,
    text,
  );
  const result = await collect(
    adapter.run({
      prompt,
      cwd: existsSync(cwd) ? cwd : project.repoPath,
      role: 'planner',
      readOnly: true,
      timeoutMs: 5 * 60_000,
      ...(seat.model && { model: seat.model }),
      ...(seat.effort && { effort: seat.effort }),
    }),
  );
  recordUsage(ctx.store, { seat, role: 'planner', source: 'project', refId: project.id }, result);
  if (!result.ok) {
    const why = result.rateLimited ? 'hit a usage limit' : (result.errors[0] ?? 'failed');
    const planner = store.steering.add({
      projectId: project.id,
      role: 'planner',
      text: `${seatLabel(seat)} couldn’t answer: ${why}. Try again in a moment.`,
      provider: seat.provider,
    });
    return { you, planner };
  }
  const { reply, actions } = parseSteering(result.text);
  const planner = store.steering.add({
    projectId: project.id,
    role: 'planner',
    text: reply,
    actions,
    provider: seat.provider,
  });
  return { you, planner };
}

/** Apply the actions you ticked, in order. Each says what it did, or why it couldn't. */
export function applySteering(
  ctx: EngineContext,
  messageId: string,
  indexes: number[],
): SteeringMessage {
  const store = ctx.store;
  const message = store.steering.get(messageId);
  if (!message) throw new Error('No such message.');
  if (message.applied) throw new Error('This proposal was already applied or dismissed.');
  const projectId = message.projectId;
  const chosen = [...new Set(indexes)].filter((i) => i >= 0 && i < message.actions.length).sort();
  const outcome = chosen.map((i) => {
    const a = message.actions[i]!;
    try {
      switch (a.type) {
        case 'add_task':
          return `Added ${addTask(store.projects, projectId, a).title}`;
        case 'edit_task':
          return `Edited ${editTask(store.projects, a.id, a).title}`;
        case 'skip_task':
          return `Skipped ${skipTask(store.projects, a.id).title}`;
        case 'move_task':
          return `Moved ${placeTask(store.projects, a.id, a.before).title}`;
        case 'decision':
          store.decisions.add({
            projectId,
            kind: 'decision',
            question: a.question,
            answer: a.answer,
            source: 'you',
          });
          store.projects.log({
            projectId,
            kind: 'decision',
            message: `You decided: ${a.question} → ${a.answer}`,
          });
          return `Decision: ${a.answer}`;
        case 'pause':
          store.projects.setStatus(projectId, 'paused', 'Paused by you from the chat');
          store.projects.log({ projectId, kind: 'stop', message: 'Paused by you from the chat' });
          return 'Paused; running steps finish';
      }
    } catch (err) {
      return `Not done: ${err instanceof Error ? err.message : String(err)}`;
    }
  });
  return store.steering.settle(messageId, chosen, outcome);
}

/** Leave a proposal as it is. */
export function dismissSteering(ctx: EngineContext, messageId: string): SteeringMessage {
  const message = ctx.store.steering.get(messageId);
  if (!message) throw new Error('No such message.');
  return message.applied ? message : ctx.store.steering.settle(messageId, [], []);
}
