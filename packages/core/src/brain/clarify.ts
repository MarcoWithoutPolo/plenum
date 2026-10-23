import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Project, Seat } from '@conclave/shared';
import { collect } from '../collect.js';
import { recordUsage, type EngineContext } from '../chat/service.js';
import { seatLabel } from '../chat/transcript.js';
import { Governor } from '../governor/governor.js';
import { extractJson } from './json.js';

const run = promisify(execFile);

export interface ClarifyQuestion {
  id: string;
  question: string;
  why?: string;
  options: string[];
  recommended?: string;
}

export interface ClarifyResult {
  questions: ClarifyQuestion[];
  tasks: { title: string; spec: string }[];
  testCommand?: string;
  seat: Seat;
}

export function clarifyPrompt(project: Project, files: string[], total: number): string {
  return `You are about to plan an autonomous coding project. Before any work starts, find out what only the user can decide, and draft the first tasks.

GOAL
${project.goal}
${project.doneWhen ? `\nDONE WHEN\n${project.doneWhen}\n` : ''}${project.designDirection ? `\nDESIGN DIRECTION\n${project.designDirection}\n` : ''}
TEST COMMAND
${project.testCommand ?? '(none yet)'}

REPOSITORY (${total} tracked files${total > files.length ? `, first ${files.length} shown` : ''})
${files.join('\n') || '(empty repository)'}

You can read files in the working directory. Do not change anything.

Rules for questions:
- Ask only questions whose answer changes what gets built. Never ask what the repository already answers.
- At most 4 questions, each with 2 to 4 short options; "recommended" must be one of them.

Rules for tasks: small, ordered, independently verifiable; each spec says what to change and how it's checked.${project.testCommand ? '' : '\nThere are no tests yet: make setting them up the first task and give the command in "test_command".'}

Reply with ONLY one JSON object:
{"questions": [{"id": "q1", "question": "...", "why": "...", "options": ["...", "..."], "recommended": "..."}], "tasks": [{"title": "...", "spec": "..."}], "test_command": "npm test or null"}`;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** Read a clarify reply; malformed questions are dropped instead of failing the whole step. */
export function parseClarify(text: string): Omit<ClarifyResult, 'seat'> | undefined {
  const json = extractJson(text);
  if (!isObj(json)) return undefined;
  const questions: ClarifyQuestion[] = [];
  for (const q of Array.isArray(json.questions) ? json.questions : []) {
    if (!isObj(q) || !str(q.question)) continue;
    const options = (Array.isArray(q.options) ? q.options : [])
      .map(str)
      .filter(Boolean)
      .slice(0, 4);
    if (options.length < 2) continue;
    const recommended = options.find((o) => o === str(q.recommended));
    questions.push({
      id: str(q.id) || `q${questions.length + 1}`,
      question: str(q.question),
      ...(str(q.why) && { why: str(q.why) }),
      options,
      ...(recommended && { recommended }),
    });
    if (questions.length === 4) break;
  }
  const tasks = (Array.isArray(json.tasks) ? json.tasks : [])
    .filter(isObj)
    .map((t) => ({ title: str(t.title).slice(0, 200), spec: str(t.spec) }))
    .filter((t) => t.title && t.spec)
    .slice(0, 12);
  const test = str(json.test_command);
  if (!questions.length && !tasks.length) return undefined;
  return { questions, tasks, ...(test && test !== 'null' && { testCommand: test }) };
}

/**
 * The clarify-first run (C2): one read-only planner pass over the repo that returns the
 * questions worth asking, a draft plan and a test command. Nothing is changed or stored
 * beyond the usage record; the wizard shows the result and `startDraft` applies it.
 */
export async function clarify(
  ctx: EngineContext,
  projectId: string,
  opts: { governor?: Governor; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ClarifyResult> {
  const project = ctx.store.projects.get(projectId);
  if (!project) throw new Error(`No such project: ${projectId}`);
  const governor = opts.governor ?? new Governor(() => ctx.store.listQuotas());
  const pick = governor.pick(project.routing.planner);
  if (!pick.seat) throw new Error(`No planner has headroom (${pick.reasons.join('; ')})`);
  const seat = pick.seat;
  const adapter = ctx.adapters.get(seat.provider);
  if (!adapter) throw new Error(`Provider not available: ${seat.provider}`);

  const { stdout } = await run('git', ['ls-files'], {
    cwd: project.repoPath,
    maxBuffer: 32 * 1024 * 1024,
  });
  const all = stdout.split('\n').filter(Boolean);
  const result = await collect(
    adapter.run({
      prompt: clarifyPrompt(project, all.slice(0, 300), all.length),
      cwd: project.repoPath,
      role: 'planner',
      readOnly: true,
      timeoutMs: opts.timeoutMs ?? 10 * 60_000,
      ...(opts.signal && { signal: opts.signal }),
      ...(seat.model && { model: seat.model }),
      ...(seat.effort && { effort: seat.effort }),
    }),
  );
  recordUsage(
    ctx.store,
    { seat, role: 'planner', source: 'project', refId: projectId, taskId: null },
    result,
  );
  governor.observe(seat.provider, result);
  if (!result.ok) {
    throw new Error(
      `${seatLabel(seat)} couldn't look at the project: ${result.rateLimited?.message ?? result.errors[0] ?? 'no reply'}`,
    );
  }
  const parsed = parseClarify(result.text);
  if (!parsed) throw new Error(`${seatLabel(seat)} didn't return questions or a plan. Try again.`);
  ctx.store.projects.log({
    projectId,
    kind: 'plan',
    message: `${seatLabel(seat)} looked at the project: ${parsed.questions.length} question(s), ${parsed.tasks.length} draft task(s)`,
    provider: seat.provider,
  });
  return { ...parsed, seat };
}

export interface DraftStart {
  answers: { question: string; answer: string; /** "Decide for me" */ assumed?: boolean }[];
  tasks: { title: string; spec: string }[];
  testCommand?: string | null;
}

/** Start a draft project: answers become decisions, the edited plan becomes the queue. */
export function startDraft(ctx: EngineContext, projectId: string, input: DraftStart): Project {
  const projects = ctx.store.projects;
  const project = projects.get(projectId);
  if (!project) throw new Error(`No such project: ${projectId}`);
  if (project.status !== 'draft') throw new Error('This project has already started.');
  for (const a of input.answers) {
    if (!a.question.trim() || !a.answer.trim()) continue;
    ctx.store.decisions.add({
      projectId,
      kind: a.assumed ? 'assumption' : 'decision',
      question: a.question,
      answer: a.answer,
      source: 'clarify',
    });
  }
  const tasks = input.tasks.filter((t) => t.title.trim() && t.spec.trim());
  if (tasks.length) projects.addTasks(projectId, tasks);
  const test = input.testCommand?.trim();
  if (test && !project.testCommand) projects.update(projectId, { proposedTestCommand: test });
  projects.setStatus(projectId, 'idle', null);
  projects.log({
    projectId,
    kind: 'plan',
    message: `Set up with ${input.answers.length} answer(s) and ${tasks.length} task(s)`,
  });
  return projects.get(projectId)!;
}
