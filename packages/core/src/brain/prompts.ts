import type { Project, Task } from '@conclave/shared';

export interface PlanContext {
  files: string[];
  totalFiles: number;
  history: string;
  merged: Task[];
  failed: Task[];
  queued: Task[];
  maxTasks: number;
}

const list = (tasks: Task[], detail?: (t: Task) => string) =>
  tasks.length
    ? tasks.map((t) => `- ${t.title}${detail ? ` (${detail(t)})` : ''}`).join('\n')
    : '- none';

export function plannerPrompt(project: Project, ctx: PlanContext): string {
  return `You are the planner for an autonomous coding project. Other agents build each task in a separate git worktree; a test command and a reviewer check every task before it is merged.

GOAL
${project.goal}
${project.doneWhen ? `\nDONE WHEN\n${project.doneWhen}\n` : ''}
TEST COMMAND (runs after every task; every task must keep it passing)
${project.testCommand ?? '(none — review only)'}

REPOSITORY (${ctx.totalFiles} tracked files${ctx.totalFiles > ctx.files.length ? `, first ${ctx.files.length} shown` : ''})
${ctx.files.join('\n') || '(empty repository)'}

RECENT HISTORY
${ctx.history || '(no commits yet)'}

ALREADY MERGED
${list(ctx.merged)}

FAILED (do not repeat as-is; split or approach differently)
${list(ctx.failed, (t) => (t.feedback ?? 'failed').split('\n')[0]!.slice(0, 160))}

STILL QUEUED
${list(ctx.queued)}

You can read files in the working directory to understand the code. Then plan the next steps.

Rules for tasks:
- Small and independently verifiable: one focused change each, finishable in one sitting.
- Ordered: earlier tasks must not depend on later ones.
- Each spec says exactly what to change and how the result is checked (tests to add or update).
- Never ask for pushing, deploying, publishing or installing new dependencies.

Reply with ONLY one JSON object and nothing else.
To add work: {"done": false, "tasks": [{"title": "short imperative title", "spec": "what to do and how it's verified"}]} with at most ${ctx.maxTasks} tasks.
If the goal is fully met: {"done": true, "reason": "one sentence on why"}.`;
}

export function builderPrompt(project: Project, task: Task): string {
  return `You are building one task for an autonomous coding project. You are in a git worktree created just for this task.

PROJECT GOAL
${project.goal}

YOUR TASK: ${task.title}
${task.spec}
${
  task.feedback
    ? `\nTHE PREVIOUS ATTEMPT WAS SENT BACK. Fix this:\n${task.feedback.slice(0, 6000)}\n`
    : ''
}
AFTER YOU FINISH the system runs: ${project.testCommand ?? '(no test command; a reviewer checks the diff)'}

Rules:
- Change only what this task needs, inside this folder. Add or update tests for what you change.
- Do not run git commit, push, or change branches; the system commits for you.
- Do not install new dependencies or reach the network.
- Keep the existing code style.

When you are done, reply with a short summary of what you changed.`;
}

export function reviewerPrompt(
  project: Project,
  task: Task,
  diff: { diff: string; stat: string; truncated: boolean },
  tests: string,
): string {
  return `You are reviewing one change for an autonomous coding project, as a careful senior engineer. You can read files in the working directory for context.

PROJECT GOAL
${project.goal}

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

Approve unless there is a real problem: a bug, a missed requirement from the task, broken or missing tests, a security issue, or changes unrelated to the task. Style nits alone are not a reason to reject.

Reply with ONLY one JSON object and nothing else:
{"approve": true or false, "issues": ["specific problem and how to fix it"], "summary": "one sentence"}`;
}
