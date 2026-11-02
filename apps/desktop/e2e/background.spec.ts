import { expect, test } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import { launch } from './integrity/kit';

/**
 * Background mode (v1.0 F11): with "Keep running" chosen, closing the window hides it and the
 * app stays up in the tray; the tray menu opens it again, lists the Inbox and pauses everything.
 * macOS keeps apps running with the window closed anyway, so this runs on Windows and Linux.
 */
test.skip(process.platform === 'darwin', 'macOS keeps the app running with no window');

type Tray = { labels(): string[]; choose(label: string): void } | null | undefined;
const tray = (app: ElectronApplication, fn: string, arg?: string) =>
  app.evaluate(
    (_e, [fn, arg]) => {
      const t = (globalThis as { conclaveTray?: Tray }).conclaveTray;
      if (!t) return null;
      return fn === 'labels' ? t.labels() : (t.choose(arg!), null);
    },
    [fn, arg] as const,
  );
const visible = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((w) => !w.isDestroyed() && w.isVisible()),
  );

test('closing the window keeps Conclave in the tray, and the tray opens it again', async () => {
  const run = await launch('normal', 'light');
  try {
    const { app, page } = run;
    test.skip((await tray(app, 'labels')) === null, 'No tray on this desktop');
    await page.setViewportSize({ width: 1320, height: 860 });
    await page.getByRole('button', { name: /^Settings/ }).click();
    const section = page.getByRole('region', { name: 'Background' });
    await section.getByRole('radio', { name: 'Keep running' }).click();
    await expect(section.getByRole('radio', { name: 'Keep running' })).toBeChecked();

    const labels = (await tray(app, 'labels')) as string[];
    expect(labels).toContain('Open Conclave');
    expect(labels).toContain('Pause everything');
    expect(labels).toContain('Quit Conclave');
    expect(labels.some((l) => l.startsWith('Inbox:'))).toBe(true);

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
    await expect.poll(() => visible(app)).toEqual([false]); // hidden, not closed

    // Pause everything from the tray is the same setting as in Settings.
    await tray(app, 'choose', 'Pause everything');
    await tray(app, 'choose', 'Open Conclave');
    await expect.poll(() => visible(app)).toEqual([true]);
    await page.getByRole('button', { name: /^Projects/ }).click();
    await page.getByRole('button', { name: /^Settings/ }).click();
    await expect(page.getByRole('switch', { name: 'Pause everything' })).toBeChecked();

    // The Inbox item opens the Inbox.
    await tray(
      app,
      'choose',
      labels.find((l) => l.startsWith('Inbox:'))!,
    );
    await expect(page.getByRole('heading', { name: 'Inbox', level: 1 })).toBeVisible();
  } finally {
    await run.close();
  }
});
