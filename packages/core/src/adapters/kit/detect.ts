import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ProviderId, ProviderStatus } from '@conclave/shared';
import { isNotFound, runCommand } from '../../process.js';

/**
 * The CLI's version, or a "not installed" status when it won't run. The first step of every
 * adapter's detect(): an adapter only checks sign-in once the CLI is there.
 */
export async function detectVersion(
  provider: ProviderId,
  command: string,
  opts: {
    /** Shown when the command isn't found, e.g. "Cursor CLI (cursor-agent) not found". */
    missing: string;
    /** Picks the version out of `--version` output; defaults to its first word. */
    version?: (stdout: string) => string | undefined;
    args?: string[];
  },
): Promise<{ installed: false; status: ProviderStatus } | { installed: true; version: string }> {
  const result = await runCommand(command, opts.args ?? ['--version']);
  if (result.code !== 0) {
    return {
      installed: false,
      status: {
        provider,
        installed: false,
        auth: 'unknown',
        detail: isNotFound(result) ? opts.missing : firstLine(result.stderr || result.stdout),
      },
    };
  }
  const text = result.stdout.trim();
  return {
    installed: true,
    version: opts.version?.(text) ?? text.split(/\s+/)[0] ?? text,
  };
}

/**
 * The CLI's path: on PATH, or where its installer puts it, since PATH changes only reach
 * terminals opened afterwards. `places` are tried in order; the bare name is the fallback.
 */
export function locateCli(name: string, places: { windows?: string[]; unix?: string[] }): string {
  const candidates = (process.platform === 'win32' ? places.windows : places.unix) ?? [];
  return candidates.find((c) => existsSync(c)) ?? name;
}

/** Folders installers commonly use, for locateCli. */
export const homeDirs = {
  home: homedir(),
  localAppData: process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'),
  appData: process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'),
};

export function firstLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean) ?? ''
  );
}
