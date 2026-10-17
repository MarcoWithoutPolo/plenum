import { spawn } from 'node:child_process';
import type { LoginCommand } from '@conclave/core';

/**
 * Open the provider's own sign-in command in a real terminal window. The CLI
 * opens the browser and stores its credentials itself; Conclave never sees them.
 * Commands come from the adapters (fixed strings), never from user input.
 */
export function openInTerminal(login: LoginCommand): Promise<{ opened: boolean; error?: string }> {
  const line = [login.command, ...login.args].join(' ');
  if (!/^[\w .:/-]+$/.test(line))
    return Promise.resolve({ opened: false, error: 'Unsafe command' });

  const attempts = terminalCommands(line);
  return new Promise((resolve) => {
    const tryNext = (i: number, lastError?: string) => {
      const attempt = attempts[i];
      if (!attempt) {
        resolve({ opened: false, error: lastError ?? 'No terminal app found' });
        return;
      }
      const child = spawn(attempt.command, attempt.args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
        windowsVerbatimArguments: attempt.verbatim ?? false,
      });
      child.once('error', (err) => tryNext(i + 1, err.message));
      child.once('spawn', () => {
        child.unref();
        resolve({ opened: true });
      });
    };
    tryNext(0);
  });
}

interface Attempt {
  command: string;
  args: string[];
  verbatim?: boolean;
}

export function terminalCommands(line: string, platform = process.platform): Attempt[] {
  if (platform === 'win32') {
    return [
      {
        command: 'cmd.exe',
        args: ['/d', '/s', '/c', `"start "Conclave sign-in" cmd.exe /k ${line}"`],
        verbatim: true,
      },
    ];
  }
  if (platform === 'darwin') {
    return [
      {
        command: 'osascript',
        args: [
          '-e',
          `tell application "Terminal" to do script "${line}"`,
          '-e',
          'tell application "Terminal" to activate',
        ],
      },
    ];
  }
  const keep = `${line}; echo; read -p "Press Enter to close" _`;
  return [
    { command: 'x-terminal-emulator', args: ['-e', 'sh', '-c', keep] },
    { command: 'gnome-terminal', args: ['--', 'sh', '-c', keep] },
    { command: 'konsole', args: ['-e', 'sh', '-c', keep] },
    { command: 'xterm', args: ['-e', 'sh', '-c', keep] },
  ];
}
