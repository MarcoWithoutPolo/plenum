import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test } from '@playwright/test';

/**
 * The installed app works (v1.0 C2): the packaged build, not the dev bundle, opens in demo mode
 * with a fresh home, shows every screen, and runs a chat end to end. Runs after
 * `npm run -w @conclave/desktop dist`; skipped when there's no packaged build.
 */
const here = dirname(fileURLToPath(import.meta.url));
const exe = {
  win32: join(here, '../release/win-unpacked/Conclave.exe'),
  darwin: join(here, '../release/mac-universal/Conclave.app/Contents/MacOS/Conclave'),
  linux: join(here, '../release/linux-unpacked/conclave'),
}[process.platform as 'win32' | 'darwin' | 'linux'];

test.skip(!exe || !existsSync(exe), 'No packaged build: run `npm run -w @conclave/desktop dist`');

test('the packaged app opens, shows every screen and answers a chat', async () => {
  const home = mkdtempSync(join(tmpdir(), 'conclave-packaged-'));
  const app = await electron.launch({
    executablePath: exe,
    env: { ...process.env, CONCLAVE_DEMO: '1', CONCLAVE_HOME: home },
  });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewportSize({ width: 1320, height: 860 });
    expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true);
    for (const screen of ['Projects', 'Inbox', 'Usage', 'Accounts', 'Settings']) {
      await page
        .getByRole('button', { name: new RegExp(`^${screen}`) })
        .first()
        .click();
      await expect(page.locator('main')).toBeVisible();
    }
    await page.getByRole('button', { name: 'New chat' }).click();
    const box = page.getByRole('textbox', { name: 'Message' });
    await box.fill('Hello from the installed app');
    await box.press('Enter');
    await expect(page.getByText('(demo) here.').first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  }
});
