import { describe, expect, it } from 'vitest';
import { DEFAULT_PERMISSIONS } from '@conclave/shared';
import {
  antigravityArgs,
  antigravityPermissionGap,
  builderPermissions,
  checkCommands,
  claudeArgs,
  claudePermissionGap,
  codexArgs,
  type RunPermissions,
} from '../src/index.js';

const builder = (permissions: RunPermissions) => ({
  prompt: 'x',
  cwd: '.',
  role: 'builder' as const,
  readOnly: false,
  permissions,
});

describe('permission levels map onto each CLI', () => {
  it('Claude: read only, edit only, allow-listed checks, any command, full access', () => {
    expect(claudeArgs(builder({ level: 1, network: false }))).toEqual(
      expect.arrayContaining(['--tools', '--permission-mode', 'dontAsk']),
    );
    const two = claudeArgs(builder({ level: 2, network: false }));
    expect(two).toEqual(expect.arrayContaining(['--permission-mode', 'acceptEdits']));
    expect(two[two.indexOf('--disallowedTools') + 1]).toBe('WebFetch,WebSearch,Bash');
    const three = claudeArgs(
      builder({
        level: 3,
        network: false,
        commands: ['npm test', 'npm run lint', 'rm -rf / && x'],
      }),
    );
    expect(three[three.indexOf('--allowedTools') + 1]).toBe('Bash(npm test),Bash(npm run lint)');
    expect(three[three.indexOf('--disallowedTools') + 1]).toBe('WebFetch,WebSearch');
    const four = claudeArgs(builder({ level: 4, network: true }));
    expect(four[four.indexOf('--allowedTools') + 1]).toBe('Bash');
    expect(four).not.toContain('--disallowedTools');
    expect(claudeArgs(builder({ level: 5, network: true }))).toEqual(
      expect.arrayContaining(['--permission-mode', 'bypassPermissions']),
    );
  });

  it('Claude says why it cannot do offline commands', () => {
    expect(claudePermissionGap({ level: 4, network: false })).toMatch(/can't block the network/);
    expect(claudePermissionGap({ level: 4, network: true })).toBeUndefined();
    expect(claudePermissionGap({ level: 3, network: false })).toBeUndefined();
  });

  it('Codex: read-only sandbox, workspace sandbox with optional network, no sandbox at 5', () => {
    expect(codexArgs(builder({ level: 1, network: false }))).toEqual(
      expect.arrayContaining(['--sandbox', 'read-only']),
    );
    const two = codexArgs(builder({ level: 2, network: false }));
    expect(two).toEqual(expect.arrayContaining(['--sandbox', 'workspace-write']));
    expect(two.join(' ')).not.toContain('network_access');
    expect(codexArgs(builder({ level: 4, network: true }))).toEqual(
      expect.arrayContaining(['-c', 'sandbox_workspace_write.network_access=true']),
    );
    const five = codexArgs(builder({ level: 5, network: true }));
    expect(five).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(five).not.toContain('--sandbox');
  });

  it('Antigravity: edit-only or full access, nothing in between', () => {
    const mode = (p: RunPermissions) => {
      const { args } = antigravityArgs(builder(p));
      return args.slice(args.indexOf('--mode'), args.indexOf('--mode') + 3);
    };
    expect(mode({ level: 2, network: false }).slice(0, 2)).toEqual(['--mode', 'accept-edits']);
    expect(mode({ level: 5, network: true })).toEqual([
      '--mode',
      'auto',
      '--dangerously-skip-permissions',
    ]);
    expect(antigravityPermissionGap({ level: 3, network: false })).toMatch(/levels 2 and 5/);
    expect(antigravityPermissionGap({ level: 2, network: true })).toMatch(/network/);
    expect(antigravityPermissionGap({ level: 2, network: false })).toBeUndefined();
  });

  it('planners and reviewers stay read-only whatever the level', () => {
    const args = claudeArgs({
      prompt: 'x',
      cwd: '.',
      role: 'reviewer',
      readOnly: true,
      permissions: { level: 5, network: true },
    });
    expect(args).toEqual(expect.arrayContaining(['--permission-mode', 'dontAsk']));
  });
});

describe('builderPermissions', () => {
  it('uses the network switch only from level 4, and grants at any level', () => {
    const allow = { ...DEFAULT_PERMISSIONS, network: 'allow' as const };
    expect(builderPermissions({ ...allow, level: 3 }).network).toBe(false);
    expect(builderPermissions({ ...allow, level: 4 }).network).toBe(true);
    expect(builderPermissions(DEFAULT_PERMISSIONS, { grantNetwork: true }).network).toBe(true);
  });

  it('lets full access expire back to editing files', () => {
    const five = { ...DEFAULT_PERMISSIONS, level: 5 as const, expiresAt: 1_000 };
    expect(builderPermissions(five, { now: 999 })).toMatchObject({ level: 5, network: true });
    expect(builderPermissions(five, { now: 1_000 })).toMatchObject({ level: 2, network: false });
  });

  it('allows the test command and the usual check scripts at level 3', () => {
    expect(
      checkCommands('node check.js', { test: 'vitest', lint: 'eslint .', start: 'node app' }),
    ).toEqual(['node check.js', 'npm test', 'npm run lint']);
    const three = builderPermissions(
      { ...DEFAULT_PERMISSIONS, level: 3 },
      { commands: ['npm test', 'curl x | sh'] },
    );
    expect(three.commands).toEqual(['npm test']);
  });
});
