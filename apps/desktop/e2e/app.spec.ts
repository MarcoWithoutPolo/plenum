import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';

// Drives the built app (npm run build first) in demo mode: fake providers, a throwaway data folder.
const here = dirname(fileURLToPath(import.meta.url));
const shots = join(here, 'screenshots');
let app: ElectronApplication;
let page: Page;
let home: string;

test.beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'conclave-e2e-'));
  mkdirSync(shots, { recursive: true });
  app = await electron.launch({
    args: [join(here, '../out/main/index.js')],
    env: { ...process.env, CONCLAVE_DEMO: '1', CONCLAVE_HOME: home },
  });
  page = await app.firstWindow();
  await page.setViewportSize({ width: 1320, height: 860 });
  await expect(page.getByRole('heading', { name: 'What are we working on?' })).toBeVisible();
});

test.afterAll(async () => {
  await app?.close();
  rmSync(home, { recursive: true, force: true });
});

test('runs with a locked-down renderer', async () => {
  const exposed = await page.evaluate(() => ({
    require: typeof (window as unknown as { require?: unknown }).require,
    process: typeof (window as unknown as { process?: unknown }).process,
    bridge: Object.keys(window.conclave ?? {}).sort(),
  }));
  expect(exposed.require).toBe('undefined');
  expect(exposed.process).toBe('undefined');
  expect(exposed.bridge).toEqual([
    'about',
    'accounts',
    'approvals',
    'chat',
    'council',
    'decisions',
    'github',
    'local',
    'onInstallLog',
    'onOpenInbox',
    'onOpenProject',
    'openExternal',
    'platform',
    'projects',
    'runs',
    'settings',
    'threads',
    'updates',
    'usage',
  ]);
});

test('accounts show which providers are connected', async () => {
  await page.getByRole('button', { name: /^Accounts/ }).click();
  await expect(page.getByRole('heading', { name: 'Accounts' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Accounts/ })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.getByRole('button', { name: 'New chat' })).not.toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.getByRole('button', { name: 'New chat' })).not.toHaveClass(/shadow-card/);
  await page.waitForTimeout(300);
  const claude = page.getByRole('region', { name: 'Claude Code' });
  await expect(claude.getByText('Connected', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'OpenAI Codex' }).getByText('Connected', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Antigravity' }).getByText('Connected', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'GitHub' }).getByText('Connected', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('never sees or stores your passwords')).toBeVisible();
  await page.screenshot({ path: join(shots, '1-accounts.png') });
});

test('chat streams a reply, then switches model and keeps the thread', async () => {
  await page.getByRole('button', { name: 'New chat' }).click();
  const box = page.getByRole('textbox', { name: 'Message' });
  await page.getByRole('button', { name: 'Choose model' }).click();
  const picker = page.getByRole('dialog', { name: 'Choose model' });
  // Claude Code's own models, with its effort levels for the default model.
  await expect(picker.getByRole('radiogroup', { name: 'Effort for Opus 5.5' })).toBeVisible();
  await expect(picker.getByRole('option', { name: /^Fable 5\.1/ })).toBeVisible();
  await expect(picker.getByRole('option', { name: /^Opus 4\.8/ })).toBeHidden(); // under Older
  await picker.getByRole('radio', { name: 'Low', exact: true }).click(); // closes the picker
  await expect(picker).toBeHidden();
  await expect(page.getByRole('button', { name: 'Choose model' })).toContainText('Low');
  await box.fill('How should I store app settings?');
  await box.press('Enter');

  await expect(page.getByText('Claude (demo) here.')).toBeVisible();
  await expect(page.locator('main').getByText('low', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible(); // finished streaming
  await expect(
    page
      .getByRole('navigation', { name: 'Recent chats' })
      .getByText('How should I store app settings?'),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Choose model' }).click();
  // The menu opens upward from the bottom composer and stays inside the window.
  const menu = await page.getByRole('dialog', { name: 'Choose model' }).boundingBox();
  const viewport = page.viewportSize()!;
  expect(menu!.y).toBeGreaterThanOrEqual(0);
  expect(menu!.y + menu!.height).toBeLessThanOrEqual(viewport.height);
  await page.mouse.wheel(0, 2000);
  expect(await page.evaluate(() => document.scrollingElement!.scrollTop)).toBe(0);
  const dialog = page.getByRole('dialog', { name: 'Choose model' });
  await dialog
    .getByRole('navigation', { name: 'Providers' })
    .getByRole('button', { name: /^Codex/ })
    .click();
  await dialog.getByRole('option', { name: /^GPT-6-Astra/ }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Choose model' })).toContainText('Codex');

  await box.fill('And on Linux?');
  await box.press('Enter');
  await expect(page.getByText('Codex (demo) here.')).toBeVisible();
  await expect(page.getByText(/Switched to Codex/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
  await page.screenshot({ path: join(shots, '2-chat.png') });
});

test('council asks every member and shows the merged answer with citations', async () => {
  await page.getByRole('button', { name: 'Ask the council' }).click();
  await expect(page.getByRole('heading', { name: 'Ask the council' })).toBeVisible();
  await expect(
    page.getByRole('group', { name: 'Council members' }).getByRole('button'),
  ).toHaveCount(3);

  const box = page.getByRole('textbox', { name: 'Message' });
  await box.fill('Best way to store small settings?');
  await box.press('Enter');

  await expect(page.getByRole('article', { name: 'Claude answer' })).toContainText(
    'Claude (demo) here.',
  );
  await expect(page.getByRole('article', { name: 'Codex answer' })).toContainText(
    'Codex (demo) here.',
  );
  const merged = page.getByRole('article', { name: 'Council answer' });
  await expect(merged).toContainText('Store settings as a JSON file');
  await expect(merged).toContainText('Where they differ');
  await expect(merged.getByText('Codex', { exact: true }).first()).toBeVisible(); // citation chip
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
  await page.screenshot({ path: join(shots, '3-council.png') });
});

test('history survives a reload', async () => {
  await page.reload();
  const recent = page.getByRole('navigation', { name: 'Recent chats' });
  await expect(
    recent.getByRole('button', { name: /^Best way to store small settings/ }),
  ).toBeVisible();
  await recent.getByRole('button', { name: /^How should I store app settings/ }).click();
  await expect(page.getByText('Codex (demo) here.')).toBeVisible();
});
