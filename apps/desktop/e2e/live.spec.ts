import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test } from '@playwright/test';

// The real app against the real, signed-in Claude CLI. Spends a little usage: PLENUM_LIVE=1 only.
test.skip(process.env.PLENUM_LIVE !== '1', 'set PLENUM_LIVE=1 to run');

const here = dirname(fileURLToPath(import.meta.url));

test('chats with the real Claude CLI', async () => {
  test.setTimeout(180_000);
  const home = mkdtempSync(join(tmpdir(), 'plenum-live-'));
  const { PLENUM_DEMO: _demo, ...env } = process.env;
  const app = await electron.launch({
    args: [join(here, '../out/main/index.js')],
    env: { ...env, PLENUM_HOME: home } as Record<string, string>,
  });
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: /^Accounts/ }).click();
    const claude = page.getByRole('region', { name: 'Claude Code' });
    await expect(claude.getByText('Connected', { exact: true })).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: join(here, 'screenshots', 'live-accounts.png') });

    await page.getByRole('button', { name: 'New chat' }).click();
    await page.getByRole('button', { name: 'Choose model' }).click();
    await page.getByRole('option', { name: 'Haiku' }).click();
    await page.keyboard.press('Escape');
    const box = page.getByRole('textbox', { name: 'Message' });
    await box.fill('Reply with exactly the word: pong');
    await box.press('Enter');
    await expect(page.locator('.prose-chat').filter({ hasText: /pong/i }).first()).toBeVisible({
      timeout: 120_000,
    });
    await expect(page.getByRole('button', { name: 'Send' })).toBeVisible({ timeout: 120_000 });
    await page.screenshot({ path: join(here, 'screenshots', 'live-chat.png') });
  } finally {
    await app.close();
    rmSync(home, { recursive: true, force: true });
  }
});
