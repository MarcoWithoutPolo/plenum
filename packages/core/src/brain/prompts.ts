import { SHOTS_FILE, type Project, type Task } from '@plenum/shared';
import {
  DECIDE_AND_TELL,
  DECIDE_YOURSELF,
  PLANNER_QUESTION_RULE,
  QUESTION_RULE,
} from './questions.js';
import { SIZE } from './shape.js';

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
  /** Tasks from the previous reply that were too big to review well. */
  resize?: { title: string; lines: number }[];
  /** What the last review found still missing from the goal. */
  gaps?: string[];
}

/** What builders are told about running commands, by permission level (C6c). */
const DELETE_RULE =
  '- To delete a file, end your reply with one line per file: DELETE: path/relative/to/this/folder. The system deletes it for you.';

function commandRule(project: Project, allowed: string[], network: boolean): string {
  switch (project.permissions.level) {
    case 1:
    case 2:
      return `- Do not run commands; the system runs the tests for you. Do not install dependencies or reach the network yourself: ask instead (see below).\n${DELETE_RULE}`;
    case 3:
      return `- You may run only these commands: ${allowed.join(', ') || project.testCommand || '(none)'}. Do not install dependencies or reach the network yourself: ask instead (see below).\n${DELETE_RULE}`;
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
${ctx.gaps?.length ? `\nTHE LAST REVIEW FOUND THE GOAL NOT YET MET. Plan what closes these gaps:\n${ctx.gaps.map((g) => `- ${g}`).join('\n')}\n` : ''}${ctx.resize?.length ? `\nYOUR LAST PLAN HAD TASKS TOO BIG TO REVIEW WELL. Split each into parts under ~${SIZE.reviewable} changed lines:\n${ctx.resize.map((r) => `- ${r.title} (~${r.lines} lines)`).join('\n')}\n` : ''}
You can read files in the working directory to understand the code. Then plan the next steps.

Rules for tasks:
- As few as the work allows. Every task costs a full build, test run and review, so never split work that one engineer would do in one sitting: a small goal (a module or two, a focused fix or refactor) is ONE task.
- Split only where a task would otherwise be too big to review well (roughly ${SIZE.reviewable}+ changed lines) or where parts are truly independent.
- Estimate each task honestly: the files it touches, the changed lines (added + removed, tests included), and the risk (high: security, data loss, migrations, public APIs).${
    project.maxParallel > 1
      ? `
- Up to ${project.maxParallel} tasks build at the same time. Give each task "after": the positions (1 = the first task in your reply) of the tasks it needs finished first, or [] if it can start right away. Split truly independent parts into tasks that touch different files, so they can run at once; never split just to fill the lanes.`
      : ''
  }
- Ordered: earlier tasks must not depend on later ones.
- Each spec says exactly what to change and how the result is checked (tests to add or update).
- Never plan pushing, deploying or publishing. Plan new dependencies only when the goal needs them; the builder asks the user first.${project.testCommand ? '' : '\n- There are no tests yet. The first task sets them up along with its own change (not as a separate task), and you include the command in "test_command".'}

${extras.decideYourself ? DECIDE_YOURSELF : PLANNER_QUESTION_RULE}

Otherwise reply with ONLY one JSON object and nothing else.
To add work: {"done": false, "tasks": [{"title": "short imperative title", "spec": "what to do and how it's verified", "replaces": "id of the failed task this takes over, or omit", "estimate": {"files": ["paths it changes"], "lines": 120, "risk": "low|medium|high"}${project.maxParallel > 1 ? ', "after": [1]' : ''}}]${project.testCommand ? '' : ', "test_command": "the command that runs the tests"'}} with at most ${ctx.maxTasks} tasks.
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
  /** Decide-and-tell: make choices and list them instead of stopping to ask. */
  decideAndTell?: boolean;
  /** A web project whose pages are screenshotted: explain sample states. */
  web?: boolean;
  /** The previous attempt's commit is already in the worktree; fix it instead of starting over. */
  kept?: string;
  /** Files where newer work conflicts with the kept attempt; the merge is in progress. */
  conflicts?: string[];
}

/** For web projects: how to show the screenshots the page in use, not just as it loads. */
const SAMPLE_STATES = `- The system screenshots the page (desktop and phone, light and dark) and checks contrast, tap sizes and errors. It shoots the page as it loads, so if your page shows little until it's used (an empty list, a board with no cards), keep a file named ${SHOTS_FILE} at the top of the project with one to three typical states, each a few steps the system replays first:
  {"states": [{"name": "with cards", "page": "/", "steps": [{"fill": {"label": "New card", "text": "Plan the release"}}, {"click": "Add card"}]}]}
  Steps are {"fill": {"label": "<the field's label>", "text": "..."}}, {"click": "<the button's name>"} and {"wait": <ms, up to 2000>}. Fields and buttons are found by their visible label, aria-label or text, as a person would. Update it when you change those labels.`;

export function builderPrompt(project: Project, task: Task, extras: BuilderExtras = {}): string {
  return `You are building one task for an autonomous coding project. You are in a git worktree created just for this task.

PROJECT GOAL
${project.goal}
${project.designDirection ? `\nDESIGN DIRECTION\n${project.designDirection}\n` : ''}${section(extras.decisions)}
YOUR TASK: ${task.title}
${task.spec}
${
  task.feedback
    ? `\nTHE PREVIOUS ATTEMPT WAS SENT BACK. ${
        extras.kept
          ? `It is already in this folder (commit ${extras.kept.slice(0, 8)}): change what the feedback asks, keep what works, and don't start over unless the feedback says the approach is wrong. `
          : ''
      }Fix this:\n${task.feedback.slice(0, 6000)}\n`
    : ''
}
${extras.installed ? `\nTHE SYSTEM ALREADY RAN: ${extras.installed}\n` : ''}${extras.conflicts ? conflictSection(extras.conflicts) : ''}
AFTER YOU FINISH the system runs: ${project.testCommand ?? project.proposedTestCommand ?? '(no test command; a reviewer checks the diff)'}

Rules:
- Change only what this task needs, inside this folder. Add or update tests for what you change.
- Do not run git commit, push, or change branches; the system commits for you.
- If you start a server or anything else in the background to check your work, stop it and everything it started before you finish.
${commandRule(project, extras.allowedCommands ?? [], extras.network ?? false)}
- Keep the existing code style.
${extras.web ? SAMPLE_STATES : ''}
${extras.decideYourself ? DECIDE_YOURSELF : extras.decideAndTell ? DECIDE_AND_TELL : QUESTION_RULE}

When you are done, reply with a short summary of what you changed.`;
}

export interface ReviewExtras extends PromptExtras {
  /** This is the last queued task: also judge whether the whole goal is met. */
  goalCheck?: { merged: string[]; doneWhen: string | null };
  /** Screenshots to judge, and the free checks' notes; attached (native) or as files to open. */
  shots?: { files: { label: string; path: string }[]; attached: boolean; notes: string[] };
  /** The last review asked for changes and the builder made none: what it said instead. */
  dispute?: { asked: string; reply: string };
}

export function reviewerPrompt(
  project: Project,
  task: Task,
  diff: { diff: string; stat: string; truncated: boolean },
  tests: string,
  extras: ReviewExtras = {},
): string {
  return `You are reviewing one change for an autonomous coding project, as a careful senior engineer. Review from the diff below: it is the whole change. Open a file in the working directory only to check something specific the diff depends on (a function it calls, a test it changes); don't read the rest of the project.

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
${extras.dispute ? disputeSection(extras.dispute) : ''}
Approve unless there is a real problem: a bug, a missed requirement from the task, broken or missing tests, a security issue, changes unrelated to the task, or a change that contradicts a decision above (cite the decision). Style nits alone are not a reason to reject.

${extras.shots ? shotsSection(extras.shots, project.designDirection) : ''}${extras.goalCheck ? goalCheckSection(extras.goalCheck) : ''}Reply with ONLY one JSON object and nothing else:
{"approve": true or false, "issues": ["specific problem and how to fix it"], "summary": "one sentence"${extras.shots ? ', "visual": [{"shot": "the screenshot label", "issue": "what looks wrong and how to fix it", "box": [x1, y1, x2, y2]}]' : ''}${extras.goalCheck ? ', "goal_met": true or false, "goal_gaps": ["what is still missing from the goal"]' : ''}}
If the change hinges on a product decision only the user can make, add "question": "...", "options": ["...", "..."], "recommended": "..." and set "approve": false.
The builder's next attempt starts from this change and fixes what you list. Only if the whole approach is wrong, so that fixing parts of it won't do, add "restart": true.`;
}

function conflictSection(files: string[]): string {
  return `
NEWER WORK CONFLICTS WITH THIS TASK
Work merged since this task's last attempt changed the same lines. A merge of it into this folder is in progress, and these files have conflict markers (<<<<<<< and >>>>>>>):
${files.map((f) => `- ${f}`).join('\n')}
Resolve each conflict so both sides' intent survives, remove every marker, then finish the task. Don't undo the newer work.
`;
}

function disputeSection(dispute: { asked: string; reply: string }): string {
  return `
THE LAST REVIEW AND THE BUILDER'S ANSWER
A review of this change asked:
${dispute.asked.slice(0, 2000)}

The builder changed nothing and replied:
${dispute.reply.slice(0, 2000)}

Judge whether that request still stands. If the builder can't do it (for example its permissions don't allow it) and the change is otherwise sound, approve and say so in the summary.
`;
}

function goalCheckSection(check: { merged: string[]; doneWhen: string | null }): string {
  return `THIS IS THE LAST PLANNED TASK. Your working directory holds the whole project with this change applied. Also judge the PROJECT GOAL${check.doneWhen ? ' and DONE WHEN' : ''} as a whole: read what you need of the project to check each requirement, and set "goal_met" to true only if every requirement is implemented and tested. Otherwise list each gap in "goal_gaps".
${check.doneWhen ? `\nDONE WHEN\n${check.doneWhen}\n` : ''}
ALREADY MERGED
${check.merged.length ? check.merged.map((t) => `- ${t}`).join('\n') : '- none'}

`;
}

function shotsSection(
  shots: { files: { label: string; path: string }[]; attached: boolean; notes: string[] },
  design: string | null,
): string {
  const list = shots.files
    .map((f, i) => `- ${f.label}${shots.attached ? ` (image ${i + 1})` : `: ${f.path}`}`)
    .join('\n');
  return `SCREENSHOTS of this change (taken by the system after the tests passed${shots.files.some((f) => f.label.startsWith('before')) ? '; "before" is the same page without this change' : ''}):
${list}
${shots.attached ? 'They are attached to this message, in this order.' : 'Open each file with your Read tool and look at it.'} Check that the pages look right for the goal${design ? ' and the design direction' : ''}: the layout at each width, readable text and contrast in both themes, nothing cut off, overlapping, broken or missing. Report real visual problems in "visual", each with the screenshot label and, if you can, the region [x1, y1, x2, y2] in that image's pixels. A visual problem is a reason to reject, like a bug; taste alone is not.
${shots.notes.length ? `\nTHE AUTOMATIC CHECKS NOTED\n${shots.notes.map((n) => `- ${n}`).join('\n')}\n` : ''}
`;
}
