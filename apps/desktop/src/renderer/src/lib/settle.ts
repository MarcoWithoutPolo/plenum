import { errorText, useApp } from './store';

/**
 * Start an action nobody waits for (a click, a refresh) so that a failure is shown instead of
 * vanishing (v1.0 Q2 rule 2). Controls that can show an error next to themselves do that too;
 * this is the floor every promise in the window stands on, enforced by the lint rule
 * `no-floating-promises`.
 */
export function settle(work: Promise<unknown>): void {
  work.catch((err: unknown) => useApp.getState().showToast('error', errorText(err)));
}

/** A sign-in that couldn't open its terminal is an error, not silence (U7). */
export async function mustOpen(
  result: Promise<{ opened: boolean; error?: string }>,
): Promise<void> {
  const r = await result;
  if (!r.opened)
    throw new Error(`Couldn't open a terminal for the sign-in: ${r.error ?? 'unknown error'}`);
}
