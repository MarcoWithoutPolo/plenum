import { z } from 'zod';

/**
 * `conclave.shots.json` at the top of a web project: states worth a screenshot that the page
 * only reaches once it's used (a board with cards, a form with an error). Conclave replays each
 * state's steps in its screenshot browser before the shots, so the free checks and the reviewer
 * see the page in use, not just empty.
 */
export const SHOTS_FILE = 'conclave.shots.json';

export const ShotStep = z.union([
  /** Type into the field with this label (its label, aria-label or placeholder). */
  z
    .object({ fill: z.object({ label: z.string().min(1).max(100), text: z.string().max(500) }) })
    .strict(),
  /** Click the button or link with this name (its text, aria-label or title). */
  z.object({ click: z.string().min(1).max(100) }).strict(),
  /** Wait a moment, in milliseconds (an animation, a timer). */
  z.object({ wait: z.number().int().min(0).max(2000) }).strict(),
]);
export type ShotStep = z.infer<typeof ShotStep>;

export const ShotState = z
  .object({
    /** Short, e.g. "with cards"; it names the screenshots. */
    name: z
      .string()
      .min(1)
      .max(40)
      .regex(/^[\w -]+$/, 'letters, numbers, spaces and dashes only'),
    page: z.string().startsWith('/').max(200).default('/'),
    steps: z.array(ShotStep).min(1).max(20),
  })
  .strict();
export type ShotState = z.infer<typeof ShotState>;

export const ShotsFile = z.object({ states: z.array(ShotState).max(3) }).strict();
export type ShotsFile = z.infer<typeof ShotsFile>;

/** The states in a shots file, or why it can't be used (never throws). */
export function parseShotsFile(text: string): { states: ShotState[] } | { error: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { error: `${SHOTS_FILE} isn't valid JSON` };
  }
  const parsed = ShotsFile.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    return { error: `${SHOTS_FILE}: ${issue.path.join('.') || 'file'}: ${issue.message}` };
  }
  const names = parsed.data.states.map((s) => s.name.toLowerCase());
  if (new Set(names).size !== names.length)
    return { error: `${SHOTS_FILE}: two states share a name` };
  return { states: parsed.data.states };
}
