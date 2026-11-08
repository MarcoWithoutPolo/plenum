import type { TaskEstimate } from '@plenum/shared';

/**
 * Pull the JSON object out of a model reply: a ```json fence, a bare object,
 * or an object surrounded by prose. Returns undefined when there isn't one.
 */
export function extractJson(text: string): unknown {
  const candidates: string[] = [];
  for (const m of text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)) candidates.push(m[1]!);
  candidates.push(text.trim());
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  for (const c of candidates) {
    try {
      return JSON.parse(c) as unknown;
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export interface PlannedTask {
  title: string;
  spec: string;
  replaces?: string;
  estimate?: TaskEstimate;
  /** Tasks that must finish first: 1-based positions in this reply, or existing task ids. */
  after?: (number | string)[];
}

/** The planner's size guess, if it gave a usable one. */
function parseEstimate(v: unknown): TaskEstimate | undefined {
  if (!isObj(v)) return undefined;
  const lines = typeof v.lines === 'number' ? v.lines : Number(v.lines);
  if (!Number.isFinite(lines) || lines < 0) return undefined;
  const files = Array.isArray(v.files)
    ? v.files
        .filter((f): f is string => typeof f === 'string' && f.trim().length > 0)
        .map((f) => f.trim())
    : [];
  const risk = v.risk === 'low' || v.risk === 'high' ? v.risk : 'medium';
  return { files: files.slice(0, 50), lines: Math.round(lines), risk };
}

export type PlanReply =
  | { done: true; reason: string }
  | {
      done: false;
      tasks: PlannedTask[];
      testCommand?: string;
    };

export function parsePlan(text: string, maxTasks: number): PlanReply | undefined {
  const json = extractJson(text);
  if (!isObj(json)) return undefined;
  if (json.done === true) {
    return { done: true, reason: typeof json.reason === 'string' ? json.reason : 'Goal met' };
  }
  if (!Array.isArray(json.tasks)) return undefined;
  const tasks = json.tasks
    .filter(isObj)
    .map((t) => ({
      title: typeof t.title === 'string' ? t.title.trim() : '',
      spec: typeof t.spec === 'string' ? t.spec.trim() : '',
      ...(typeof t.replaces === 'string' && t.replaces.trim() && { replaces: t.replaces.trim() }),
      ...(parseEstimate(t.estimate) && { estimate: parseEstimate(t.estimate)! }),
      ...(Array.isArray(t.after) && {
        after: t.after.filter(
          (a): a is number | string =>
            (typeof a === 'number' && Number.isInteger(a)) ||
            (typeof a === 'string' && a.trim() !== ''),
        ),
      }),
    }))
    .filter((t) => t.title && t.spec)
    .slice(0, maxTasks);
  const test = typeof json.test_command === 'string' ? json.test_command.trim() : '';
  return { done: false, tasks, ...(test && { testCommand: test.slice(0, 500) }) };
}

export interface ReviewReply {
  approve: boolean;
  issues: string[];
  summary: string;
  /** Problems a reviewer saw in the screenshots, each pinned to one. */
  visual?: { shot: string; issue: string; box?: [number, number, number, number] }[];
  /** Only when asked for a goal check. */
  goalMet?: boolean;
  goalGaps?: string[];
  /** Rejected because the approach is wrong: the next attempt starts fresh, not from this one. */
  restart?: boolean;
}

export function parseReview(text: string): ReviewReply | undefined {
  const json = extractJson(text);
  if (!isObj(json) || typeof json.approve !== 'boolean') return undefined;
  const issues = Array.isArray(json.issues)
    ? json.issues.filter((i): i is string => typeof i === 'string' && i.trim().length > 0)
    : [];
  const summary = typeof json.summary === 'string' ? json.summary : '';
  const visual = Array.isArray(json.visual) && json.visual.some(isObj);
  // A rejection that says nothing at all isn't a verdict: the next reviewer is asked.
  if (!json.approve && !issues.length && !summary.trim() && !visual && !('question' in json))
    return undefined;
  return {
    approve: json.approve,
    issues,
    summary,
    ...(Array.isArray(json.visual) && {
      visual: json.visual
        .filter(isObj)
        .filter((v) => typeof v.issue === 'string' && v.issue.trim())
        .map((v) => {
          const box =
            Array.isArray(v.box) && v.box.length === 4 && v.box.every((n) => typeof n === 'number')
              ? (v.box.map((n) => Math.round(n as number)) as [number, number, number, number])
              : undefined;
          return {
            shot: typeof v.shot === 'string' ? v.shot : '',
            issue: (v.issue as string).trim(),
            ...(box && { box }),
          };
        })
        .slice(0, 10),
    }),
    ...(typeof json.goal_met === 'boolean' && { goalMet: json.goal_met }),
    ...(Array.isArray(json.goal_gaps) && {
      goalGaps: json.goal_gaps.filter(
        (g): g is string => typeof g === 'string' && g.trim().length > 0,
      ),
    }),
    ...(json.restart === true && { restart: true }),
  };
}
