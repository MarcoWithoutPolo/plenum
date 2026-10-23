import { AgentQuestion } from '@conclave/shared';
import { extractJson } from './json.js';

export interface ParsedQuestion extends AgentQuestion {
  /** True when the agent used the JSON protocol; false for a question guessed from prose. */
  structured: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Did the agent stop to ask something? First the JSON protocol
 * (`{"question": ..., "options": [...]}`), then, only when it changed nothing, a reply
 * whose last paragraph reads like a question to the user.
 */
export function parseQuestion(
  text: string,
  opts: { allowProse?: boolean } = {},
): ParsedQuestion | undefined {
  const json = extractJson(text);
  if (isObj(json) && typeof json.question === 'string' && json.question.trim()) {
    const options = Array.isArray(json.options)
      ? json.options
          .filter((o): o is string => typeof o === 'string' && o.trim().length > 0)
          .map((o) => o.trim())
          .slice(0, 6)
      : [];
    const recommended =
      typeof json.recommended === 'string' && json.recommended.trim()
        ? json.recommended.trim()
        : undefined;
    const permission = isObj(json.permission) ? json.permission : undefined;
    const kind = permission?.kind;
    const parsed = AgentQuestion.safeParse({
      question: json.question.trim(),
      ...(typeof json.why === 'string' && json.why.trim() && { why: json.why.trim() }),
      options,
      ...(recommended && { recommended }),
      ...(permission &&
        (kind === 'install' || kind === 'network') && {
          permission: {
            kind,
            ...(typeof permission.command === 'string' && {
              command: permission.command.trim(),
            }),
            ...(typeof permission.alternative === 'string' && {
              alternative: permission.alternative.trim(),
            }),
          },
        }),
    });
    if (parsed.success) return { ...parsed.data, structured: true };
  }
  if (!opts.allowProse) return undefined;
  const last = text
    .trim()
    .split(/\n\s*\n/)
    .at(-1)
    ?.trim();
  if (!last || last.length > 600) return undefined;
  if (last.endsWith('?') || /^(should i|do you want|would you like|which|shall i)\b/i.test(last)) {
    return { question: last, options: [], structured: false };
  }
  return undefined;
}

/** Install commands Conclave will run for you once approved; anything else is copy-only. */
const INSTALL_SHAPES = [
  /^(npm|pnpm|yarn|bun) (add|install|i)( (-D|--save-dev|-E|--save-exact|--dev))*( [@a-z0-9][\w@./^~=<>-]*)+$/i,
  /^(pip|pip3|python -m pip) install( [a-z0-9][\w.[\]=<>~!-]*)+$/i,
  /^uv add( [a-z0-9][\w.[\]=<>~!-]*)+$/i,
  /^cargo add( [a-z0-9][\w@.-]*)+$/i,
  /^go get( [a-z0-9][\w@./-]*)+$/i,
  /^dotnet add package [\w.]+( --version [\w.-]+)?$/i,
];

export function isRunnableInstall(command: string | undefined): boolean {
  if (!command) return false;
  const c = command.trim().replace(/\s+/g, ' ');
  return INSTALL_SHAPES.some((re) => re.test(c));
}

/** What the agent is told when it may not ask any more questions. */
export const DECIDE_YOURSELF =
  'Do not ask more questions for this task. Make the most reasonable choice yourself and state the assumption in your summary.';

/** The rule builder and planner prompts carry. */
export const QUESTION_RULE = `If you cannot continue without a decision only the user can make, do not guess and do not stop silently. Reply with only
{"question": "...", "why": "...", "options": ["...", "..."], "recommended": "one of the options"}
If the work needs a new dependency or the network, reply with only
{"question": "...", "why": "...", "permission": {"kind": "install" or "network", "command": "e.g. npm install howler", "alternative": "how to do it without"}}
Ask only when the answer changes what gets built; never about things the code or the decisions above already answer.`;
