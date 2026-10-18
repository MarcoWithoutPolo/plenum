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

export type PlanReply =
  { done: true; reason: string } | { done: false; tasks: { title: string; spec: string }[] };

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
    }))
    .filter((t) => t.title && t.spec)
    .slice(0, maxTasks);
  return { done: false, tasks };
}

export interface ReviewReply {
  approve: boolean;
  issues: string[];
  summary: string;
}

export function parseReview(text: string): ReviewReply | undefined {
  const json = extractJson(text);
  if (!isObj(json) || typeof json.approve !== 'boolean') return undefined;
  const issues = Array.isArray(json.issues)
    ? json.issues.filter((i): i is string => typeof i === 'string' && i.trim().length > 0)
    : [];
  return {
    approve: json.approve,
    issues,
    summary: typeof json.summary === 'string' ? json.summary : '',
  };
}
