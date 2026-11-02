/**
 * Named points where the crash tests end the process, as a power cut would: no `finally`, no
 * cleanup. Does nothing unless CONCLAVE_CRASH_AT names the point.
 */
export type CrashPoint =
  | 'after-plan'
  | 'after-commit'
  | 'mid-tests'
  | 'after-approve'
  | 'after-merge'
  | 'mid-merge-ref'
  | 'mid-merge-conflict';

/** Exit code a crashed test process ends with, so the test can tell it from a real failure. */
export const CRASH_EXIT = 86;

export function crashPoint(point: CrashPoint): void {
  if (process.env.CONCLAVE_CRASH_AT === point) process.exit(CRASH_EXIT);
}
