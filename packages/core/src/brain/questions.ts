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

/**
 * The planner's version: only product questions. Installs and network are asked for by the
 * builder of the task that needs them, so an approval always has a task to apply to.
 */
export const PLANNER_QUESTION_RULE = `If the plan hinges on a decision only the user can make, do not guess. Reply with only
{"question": "...", "why": "...", "options": ["...", "..."], "recommended": "one of the options"}
Never ask about installing packages or using the network: plan a task for it, and its builder asks when it gets there.
Ask only when the answer changes what gets built; never about things the code or the decisions above already answer.`;

/** What the agent is told when it may not ask any more questions. */
export const DECIDE_YOURSELF =
  'Do not ask more questions for this task. Make the most reasonable choice yourself and state the assumption in your summary.';

/**
 * "Decide and tell me": choices don't stop the build (each question would cost a whole
 * attempt); the builder makes them and lists them, and the brain records each as an assumption.
 * Installs and network access still need asking: those are permissions, not choices.
 */
export const DECIDE_AND_TELL = `Don't stop to ask about choices: make the most reasonable one yourself and keep going. End your summary with one line per choice you made that the user might want to know about:
ASSUMED: <the question> → <what you chose>
If the work needs a new dependency or the network, reply with only
{"question": "...", "why": "...", "permission": {"kind": "install" or "network", "command": "e.g. npm install howler", "alternative": "how to do it without"}}`;

/** The choices a builder listed with ASSUMED: lines (decide-and-tell). */
export function parseAssumptions(text: string): { question: string; answer: string }[] {
  const out: { question: string; answer: string }[] = [];
  for (const m of text.matchAll(/^\s*[-*]?\s*ASSUMED:\s*(.+?)\s*(?:→|->)\s*(.+?)\s*$/gm)) {
    out.push({ question: m[1]!.slice(0, 1000), answer: m[2]!.slice(0, 2000) });
  }
  return out.slice(0, 10);
}

/** Files a builder asked to delete with DELETE: lines (it can't run `rm` below level 4). */
export function parseDeletes(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/^\s*[-*]?\s*DELETE:\s*`?([^`\n]+?)`?\s*$/gm)) out.add(m[1]!);
  return [...out].slice(0, 50);
}

/** The rule builder and planner prompts carry. */
export const QUESTION_RULE = `If you cannot continue without a decision only the user can make, do not guess and do not stop silently. Reply with only
{"question": "...", "why": "...", "options": ["...", "..."], "recommended": "one of the options"}
If the work needs a new dependency or the network, reply with only
{"question": "...", "why": "...", "permission": {"kind": "install" or "network", "command": "e.g. npm install howler", "alternative": "how to do it without"}}
Ask only when the answer changes what gets built; never about things the code or the decisions above already answer.`;
