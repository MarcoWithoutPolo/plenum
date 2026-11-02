import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';

export class ProjectBusyError extends Error {}

/** A held lock is touched this often; one untouched for STALE_MS has no living owner (E7). */
const HEARTBEAT_MS = 20_000;
const STALE_MS = 90_000;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Who holds the lock at `path`, if that process is still running and still holding it. The pid
 * alone isn't proof: Windows reuses pids, so a lock whose owner died could look held for ever.
 * A living owner touches the file every 20 s; one untouched for 90 s is stale.
 */
export function lockHolder(path: string): number | undefined {
  try {
    const pid = Number(readFileSync(path, 'utf8').trim());
    if (!Number.isInteger(pid) || pid <= 0 || !alive(pid)) return undefined;
    if (pid !== process.pid && Date.now() - statSync(path).mtimeMs > STALE_MS) return undefined;
    return pid;
  } catch {
    return undefined;
  }
}

/**
 * One brain per project, across the desktop app and every `conclave` CLI: a lock file holding
 * the owner's pid, touched while held. A lock left by a crashed process is taken over; when two
 * processes find it stale at once, only one can move it aside, so only one gets the lock (E7).
 */
export function acquireLock(path: string): { release: () => void } {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(path, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      let released = false;
      const beat = setInterval(() => {
        try {
          const now = new Date();
          utimesSync(path, now, now);
        } catch {
          // Gone (released elsewhere): nothing to keep fresh.
        }
      }, HEARTBEAT_MS);
      beat.unref();
      return {
        release: () => {
          if (released) return;
          released = true;
          clearInterval(beat);
          if (lockHolder(path) === process.pid) rmSync(path, { force: true });
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const holder = lockHolder(path);
      if (holder !== undefined) {
        throw new ProjectBusyError(
          holder === process.pid
            ? 'This project is already running here.'
            : `This project is already running in another Conclave window or terminal (process ${holder}).`,
        );
      }
      // Stale: move it aside under a name only this process uses. A rename is atomic, so of two
      // processes doing this at once one succeeds and the other finds nothing to move.
      const aside = `${path}.stale-${process.pid}-${Date.now()}`;
      try {
        renameSync(path, aside);
        rmSync(aside, { force: true });
      } catch {
        // Someone else moved it first; try again to create ours.
      }
    }
  }
  throw new ProjectBusyError('Could not take the project lock.');
}
