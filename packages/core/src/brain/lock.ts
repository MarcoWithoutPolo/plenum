import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

export class ProjectBusyError extends Error {}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Who holds the lock at `path`, if that process is still running. */
export function lockHolder(path: string): number | undefined {
  try {
    const pid = Number(readFileSync(path, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 && alive(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One brain per project, across the desktop app and every `conclave` CLI:
 * a lock file holding the owner's pid. A lock left by a crashed process is taken over.
 */
export function acquireLock(path: string): { release: () => void } {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      let released = false;
      return {
        release: () => {
          if (released) return;
          released = true;
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
      rmSync(path, { force: true }); // stale: its owner is gone
    }
  }
  throw new ProjectBusyError('Could not take the project lock.');
}
