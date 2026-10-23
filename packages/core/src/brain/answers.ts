import type { Approval, QuestionPayload, Task } from '@conclave/shared';
import type { Store } from '../store/store.js';
import { isRunnableInstall } from './questions.js';

export type AnswerOutcome =
  { ok: true; approval: Approval; task?: Task } | { ok: false; error: string };

export const QUESTION_KINDS: ReadonlySet<Approval['kind']> = new Set([
  'question',
  'install',
  'network',
]);

function pendingQuestion(store: Store, approvalId: string) {
  const approval = store.projects.getApproval(approvalId);
  if (!approval || approval.status !== 'pending') return undefined;
  if (!QUESTION_KINDS.has(approval.kind)) return undefined;
  return { approval, payload: approval.payload as QuestionPayload };
}

/** A blocked task waiting on this inbox item goes back to the queue with `feedback` added. */
function release(store: Store, approval: Approval, feedback: string, grants?: Task['grants']) {
  const task = approval.taskId ? store.projects.getTask(approval.taskId) : undefined;
  if (!task || task.status !== 'blocked' || task.blockedBy !== approval.id) return undefined;
  return store.projects.updateTask(task.id, {
    status: 'queued',
    blockedBy: null,
    feedback: task.feedback ? `${feedback}\n\n${task.feedback}` : feedback,
    ...(grants !== undefined && { grants }),
  });
}

/** A project that stopped for you can go on once nothing is left waiting. */
function reopen(store: Store, projectId: string): void {
  const project = store.projects.get(projectId);
  if (project?.status !== 'needs_you') return;
  const stillOpen = store.projects
    .approvals(projectId, 'pending')
    .some((a) => QUESTION_KINDS.has(a.kind));
  if (!stillOpen) store.projects.setStatus(projectId, 'idle', 'Answered; ready to continue');
}

/** Answer an agent's question: it becomes a decision, and the waiting task is requeued. */
export function answerQuestion(store: Store, approvalId: string, answer: string): AnswerOutcome {
  const found = pendingQuestion(store, approvalId);
  if (!found) return { ok: false, error: 'That question was already answered.' };
  const text = answer.trim();
  if (!text) return { ok: false, error: 'Write an answer first.' };
  const { approval, payload } = found;
  if (approval.kind !== 'question') {
    return decidePermission(store, approvalId, true, text);
  }
  const decided = store.projects.decide(approval.id, 'approved', text)!;
  store.decisions.add({
    projectId: approval.projectId,
    kind: 'decision',
    question: payload.question,
    answer: text,
    source: 'you',
    provider: payload.provider,
    taskId: approval.taskId,
  });
  const task = release(store, approval, `The user answered "${payload.question}": ${text}`);
  store.projects.log({
    projectId: approval.projectId,
    taskId: approval.taskId,
    kind: 'decision',
    message: `You answered: ${payload.question} → ${text}`,
    data: { approvalId: approval.id },
  });
  reopen(store, approval.projectId);
  return { ok: true, approval: decided, ...(task && { task }) };
}

/**
 * Approve or decline an install or network request. An approved install that Conclave can
 * run is run before the next build; one it can't run means you installed it yourself.
 */
export function decidePermission(
  store: Store,
  approvalId: string,
  approve: boolean,
  note?: string,
): AnswerOutcome {
  const found = pendingQuestion(store, approvalId);
  if (!found || found.approval.kind === 'question') {
    return { ok: false, error: 'That request was already decided.' };
  }
  const { approval, payload } = found;
  const task = approval.taskId ? store.projects.getTask(approval.taskId) : undefined;
  const command = payload.permission?.command;
  let feedback: string;
  let grants: Task['grants'] | undefined;
  let answer: string;
  if (!approve) {
    answer = note?.trim() || payload.permission?.alternative || 'No; do it without';
    feedback =
      approval.kind === 'install'
        ? `The user declined installing ${command ?? 'that dependency'}. Do it without: ${answer}`
        : `The user declined network access. Do it offline: ${answer}`;
  } else if (approval.kind === 'install' && isRunnableInstall(command)) {
    answer = `Yes, install with: ${command}`;
    grants = { ...task?.grants, install: command! };
    feedback = `The user approved installing with: ${command}`;
  } else if (approval.kind === 'install') {
    answer = note?.trim() || `Yes; the user installed it: ${command ?? ''}`.trim();
    feedback = `The user installed it themselves: ${command ?? note ?? ''}`.trim();
  } else {
    answer = 'Yes, for one attempt';
    grants = { ...task?.grants, network: true };
    feedback = 'The user allowed network access for this attempt.';
  }
  const decided = store.projects.decide(approval.id, approve ? 'approved' : 'rejected', answer)!;
  store.decisions.add({
    projectId: approval.projectId,
    kind: 'decision',
    question: payload.question,
    answer,
    source: 'you',
    provider: payload.provider,
    taskId: approval.taskId,
  });
  const released = release(store, approval, feedback, grants);
  store.projects.log({
    projectId: approval.projectId,
    taskId: approval.taskId,
    kind: 'decision',
    message: `You ${approve ? 'allowed' : 'declined'}: ${payload.question}`,
    data: { approvalId: approval.id, ...(command && { command }) },
  });
  reopen(store, approval.projectId);
  return { ok: true, approval: decided, ...(released && { task: released }) };
}
