import type { Project, Task } from '@conclave/shared';
import { DECIDE_YOURSELF, QUESTION_RULE } from './questions.js';

/** Optional context every agent prompt can carry. */
export interface PromptExtras {
  /** The DECISIONS / ASSUMPTIONS section (see decisionsSection). */
  decisions?: string;
  /** The agent may not ask more questions; it decides and notes assumptions. */
  decideYourself?: boolean;
}

const section = (text: string | undefined) => (text ? `\n${text}\n` : '');

export interface PlanContext {
  files: string[];
  totalFiles: number;
  history: string;
  merged: Task[];
  failed: Task[];
  skipped: Task[];
  queued: Task[];
  maxTasks: number;
}

/** What builders are told about running commands, by permission level (C6c). */
function commandRule(project: Project, allowed: string[], network: boolean): string {
  switch (project.permissions.level) {
    case 1:
    case 2:
      return '- Do not run commands; the system runs the tests for you. Do not install dependencies or reach the network yourself: ask instead (see below).';
    case 3:
      return `- You may run only these commands: ${allowed.join(', ') || project.testCommand || '(none)'}. Do not install dependencies or reach the network yourself: ask instead (see below).`;
    case 4:
      return `- You may run any command inside this folder.${network ? '' : ' There is no network; do not install dependencies yourself: ask instead (see below).'}`;
    case 5:
      return '- You have full access, including commands and the network. Still never push, publish or deploy.';
  }
}

const list = (tasks: Task[], detail?: (t: Task) => string) =>
  tasks.length
    ? tasks.map((t) => `- ${t.title}${detail ? ` (${detail(t)})` : ''}`).join('\n')
    : '- none';

export function plannerPrompt(
  project: Project,
  ctx: PlanContext,
  extras: PromptExtras = {},
): string {
  return `You are the planner for an autonomous coding project. Other agents build each task in a separate git worktree; a test command and a reviewer check every task before it is merged.

GOAL
${project.goal}
${project.doneWhen ? `\nDONE WHEN\n${project.doneWhen}\n` : ''}${project.designDirection ? `\nDESIGN DIRECTION\n${project.designDirection}\n` : ''}
TEST COMMAND (runs after every task; every task must keep it passing)
${testLine(project)}
${section(extras.decisions)}
REPOSITORY (${ctx.totalFiles} tracked files${ctx.totalFiles > ctx.files.length ? `, first ${ctx.files.length} shown` : ''})
${ctx.files.join('\n') || '(empty repository)'}

RECENT HISTORY
${ctx.history || '(no commits yet)'}

ALREADY MERGED
${list(ctx.merged)}

FAILED (id: title, why). Leave these alone, or take one over with a different approach by adding "replaces": "<its id>" to the new task. Never redo one as-is.
${
  ctx.failed.length
    ? ctx.failed
        .map(
          (t) =>
            `- ${t.id}: ${t.title} (${(t.lastFailure?.summary ?? t.feedback ?? 'failed').split('\n')[0]!.slice(0, 160)})`,
        )
        .join('\n')
    : '- none'
}

SKIPPED BY THE USER (do not redo)
${list(ctx.skipped)}

STILL QUEUED
${list(ctx.queued)}

You can read files in the working directory to understand the code. Then plan the next steps.

Rules for tasks:
- Small and independently verifiable: one focused change each, finishable in one sitting.
- Ordered: earlier tasks must not depend on later ones.
- Each spec says exactly what to change and how the result is checked (tests to add or update).
- Never plan pushing, deploying or publishing. Plan new dependencies only when the goal needs them; the builder asks the user first.${project.testCommand ? '' : '\n- There are no tests yet. Make setting them up the first task, and include the command in "test_command".'}

${extras.decideYourself ? DECIDE_YOURSELF : QUESTION_RULE}

Otherwise reply with ONLY one JSON object and nothing else.
To add work: {"done": false, "tasks": [{"title": "short imperative title", "spec": "what to do and how it's verified", "replaces": "id of the failed task this takes over, or omit"}]${project.testCommand ? '' : ', "test_command": "the command that runs the tests"'}} with at most ${ctx.maxTasks} tasks.
If the goal is fully met: {"done": true, "reason": "one sentence on why"}.`;
}

function testLine(project: Project): string {
  if (project.testCommand) return project.testCommand;
  if (project.proposedTestCommand) {
    return `(not set up yet; proposed: ${project.proposedTestCommand}. Keep the task that sets it up first.)`;
  }
  return '(none yet; a reviewer checks every change)';
}

export interface BuilderExtras extends PromptExtras {
  /** Commands allowed at permission level 3. */
  allowedCommands?: string[];
  /** Network granted for this attempt. */
  network?: boolean;
  /** An install command the system ran before this attempt. */
  installed?: string;
}

export function builderPrompt(project: Project, task: Task, extras: BuilderExtras = {}): string {
  return `You are building one task for an autonomous coding project. You are in a git worktree created just for this task.

PROJECT GOAL
${project.goal}
${project.designDirection ? `\nDESIGN DIRECTION\n${project.designDirection}\n` : ''}${section(extras.decisions)}
YOUR TASK: ${task.title}
${task.spec}
${
  task.feedback
    ? `\nTHE PREVIOUS ATTEMPT WAS SENT BACK. Fix this:\n${task.feedback.slice(0, 6000)}\n`
    : ''
}
${extras.installed ? `\nTHE SYSTEM ALREADY RAN: ${extras.installed}\n` : ''}
AFTER YOU FINISH the system runs: ${project.testCommand ?? '(no test command; a reviewer checks the diff)'}

Rules:
- Change only what this task needs, inside this folder. Add or update tests for what you change.
- Do not run git commit, push, or change branches; the system commits for you.
${commandRule(project, extras.allowedCommands ?? [], extras.network ?? false)}
- Keep the existing code style.

${extras.decideYourself ? DECIDE_YOURSELF : QUESTION_RULE}

When you are done, reply with a short summary of what you changed.`;
}

export function reviewerPrompt(
  project: Project,
  task: Task,
  diff: { diff: string; stat: string; truncated: boolean },
  tests: string,
  extras: PromptExtras = {},
): string {
  return `You are reviewing one change for an autonomous coding project, as a careful senior engineer. You can read files in the working directory for context.

PROJECT GOAL
${project.goal}
${section(extras.decisions)}
TASK: ${task.title}
${task.spec}

TESTS
${tests}

CHANGED FILES
${diff.stat || '(none)'}

DIFF${diff.truncated ? ' (truncated)' : ''}
\`\`\`diff
${diff.diff}
\`\`\`

Approve unless there is a real problem: a bug, a missed requirement from the task, broken or missing tests, a security issue, changes unrelated to the task, or a change that contradicts a decision above (cite the decision). Style nits alone are not a reason to reject.

Reply with ONLY one JSON object and nothing else:
{"approve": true or false, "issues": ["specific problem and how to fix it"], "summary": "one sentence"}
If the change hinges on a product decision only the user can make, add "question": "...", "options": ["...", "..."], "recommended": "..." and set "approve": false.`;
}
