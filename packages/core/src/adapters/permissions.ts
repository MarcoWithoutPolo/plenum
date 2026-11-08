import type { PermissionLevel, Permissions } from '@plenum/shared';

/**
 * What one agent run may do, resolved from the project's permissions (C6c).
 * Adapters turn this into their CLI's own sandbox flags; Plenum never relies on the model obeying.
 */
export interface RunPermissions {
  level: PermissionLevel;
  /** May reach the network (level 4+ with the switch on, a one-time grant, or level 5). */
  network: boolean;
  /** Level 3: the only commands the agent may run. */
  commands?: string[];
}

/** Commands safe to put in an allow-list: no shell operators, quotes or separators. */
const SAFE_COMMAND = /^[\w .:/@=+-]+$/;

export function safeCommands(commands: string[] | undefined): string[] {
  return (commands ?? []).map((c) => c.trim()).filter((c) => c && SAFE_COMMAND.test(c));
}

/**
 * The permissions a builder runs with. Level 5 expires on its own; the network switch
 * only counts from level 4, while a one-time grant applies at any level.
 */
export function builderPermissions(
  permissions: Permissions,
  opts: { now?: number; grantNetwork?: boolean; commands?: string[] } = {},
): RunPermissions {
  const expired =
    permissions.level === 5 &&
    permissions.expiresAt !== null &&
    permissions.expiresAt <= (opts.now ?? Date.now());
  const level: PermissionLevel = expired ? 2 : permissions.level;
  const network =
    level === 5 || opts.grantNetwork === true || (level >= 4 && permissions.network === 'allow');
  return {
    level,
    network,
    ...(level === 3 && { commands: safeCommands(opts.commands) }),
  };
}

export const LEVEL_NAMES: Record<PermissionLevel, string> = {
  1: 'Read only',
  2: 'Edit files',
  3: 'Edit and run checks',
  4: 'Edit and run anything, offline',
  5: 'Full access',
};

/** The commands level 3 allows: the test command plus the usual package.json check scripts. */
export function checkCommands(
  testCommand: string | null,
  scripts: Record<string, string> | undefined,
): string[] {
  const out = new Set<string>();
  if (testCommand) out.add(testCommand.trim());
  for (const name of ['test', 'lint', 'build', 'typecheck', 'check', 'format:check']) {
    if (scripts?.[name]) out.add(name === 'test' ? 'npm test' : `npm run ${name}`);
  }
  return safeCommands([...out]);
}
