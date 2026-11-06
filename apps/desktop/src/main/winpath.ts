import { execFile } from 'node:child_process';

/** The current PATH plus any folders from `fresh` it doesn't have yet, in order. */
export function mergePath(current: string, fresh: string, separator = ';'): string {
  const seen = new Set<string>();
  return [...current.split(separator), ...fresh.split(separator)]
    .map((p) => p.trim())
    .filter((p) => {
      const key = p.toLowerCase();
      if (!p || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join(separator);
}

/**
 * On Windows a running app keeps the PATH it started with, so Node.js or a CLI installed since
 * wouldn't be found until a restart. This reads the saved PATH again and adds what's new.
 */
export function refreshWindowsPath(): Promise<void> {
  if (process.platform !== 'win32') return Promise.resolve();
  const script =
    "[Environment]::GetEnvironmentVariable('Path','Machine');[Environment]::GetEnvironmentVariable('Path','User')";
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 10_000, windowsHide: true },
      (err, stdout) => {
        if (!err) {
          const fresh = stdout.split(/\r?\n/).filter(Boolean).join(';');
          process.env.PATH = mergePath(process.env.PATH ?? '', fresh);
        }
        resolve();
      },
    );
  });
}
