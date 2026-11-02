import { expect, test, type Page } from '@playwright/test';
import { launch, type Running } from './integrity/kit';

// v1.0 F1 (Accounts, redesigned), F2 (default models), F3 (appearance and accessibility).
let run: Running;
let page: Page;

test.beforeAll(async () => {
  run = await launch('normal', 'light');
  page = run.page;
  await page.setViewportSize({ width: 1320, height: 860 });
});
test.afterAll(async () => {
  await run?.close();
});

const card = (name: string) => page.getByRole('region', { name });

test('every installed AI has the same card: state, default, usage, actions (F1)', async () => {
  await page.getByRole('button', { name: /^Accounts/ }).click();
  await expect(page.getByText(/\d+ connected/)).toBeVisible();
  for (const name of ['Claude Code', 'OpenAI Codex', 'Antigravity']) {
    const c = card(name);
    await expect(c.getByRole('heading', { name })).toBeVisible();
    // The state in words, not only a color.
    await expect(
      c.getByText(/(Connected|Signed out|Not connected|Out of usage)$/).first(),
    ).toBeVisible();
    await expect(c.getByText('Default model', { exact: true })).toBeVisible();
    await expect(c.getByText(/Plan usage/).first()).toBeVisible();
    await expect(c.getByRole('button', { name: /^(Switch account|Sign in)$/ })).toBeVisible();
    await expect(c.getByRole('button', { name: 'Check' })).toBeVisible();
  }
  // Antigravity doesn't report usage: it says so instead of leaving a gap.
  await expect(card('Antigravity')).toContainText('doesn’t report it');
});

test('a default model set on Accounts is what a "Default" chat runs (F2)', async () => {
  const codex = card('OpenAI Codex');
  await codex.getByRole('button', { name: /OpenAI Codex default model/ }).click();
  const picker = page.getByRole('dialog', { name: 'OpenAI Codex default model' });
  await picker
    .getByRole('option', { name: /GPT-6-Luna/ })
    .first()
    .click();
  await expect(codex.getByRole('button', { name: /OpenAI Codex default model/ })).toContainText(
    'GPT-6-Luna',
  );
  // New chats start with Codex, on its default.
  await page.getByRole('button', { name: /the AI chats start with/ }).click();
  await page.getByRole('option', { name: 'OpenAI Codex' }).click();
  await page.getByRole('button', { name: 'New chat' }).click();
  await expect(page.getByRole('button', { name: /choose model/ })).toContainText('Codex');
  const box = page.getByRole('textbox').last();
  await box.fill('Which model are you?');
  await box.press('Enter');
  await expect(page.getByText('Codex (demo) here.')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('gpt-6-luna').first()).toBeVisible();
  // Back to the CLI's own setting.
  await page.getByRole('button', { name: /^Accounts/ }).click();
  await codex.getByRole('button', { name: 'Use the CLI’s setting' }).click();
  await expect(codex.getByRole('button', { name: /OpenAI Codex default model/ })).toContainText(
    'Uses the CLI’s own setting',
  );
});

test('appearance settings take effect and the shortcuts sheet opens (F3)', async () => {
  await page.getByRole('button', { name: /^Settings/ }).click();
  await page
    .getByRole('radiogroup', { name: 'Text size' })
    .getByRole('radio', { name: '115%' })
    .click();
  await expect
    .poll(() =>
      run.app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.webContents.getZoomFactor(),
      ),
    )
    .toBeCloseTo(1.15);
  await page.getByText('Higher contrast', { exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-contrast', 'high');
  await page
    .getByRole('radiogroup', { name: 'Theme' })
    .getByRole('radio', { name: 'Dark' })
    .click();
  await expect
    .poll(() => run.app.evaluate(({ nativeTheme }) => nativeTheme.themeSource))
    .toBe('dark');
  // The look survives a restart of the window.
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-contrast', 'high');
  await page.keyboard.press('Control+/');
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
  await page.keyboard.press('Escape');
  // Back to the defaults for the other tests.
  await page.getByRole('button', { name: /^Settings/ }).click();
  await page
    .getByRole('radiogroup', { name: 'Text size' })
    .getByRole('radio', { name: '100%' })
    .click();
  await page.getByText('Higher contrast', { exact: true }).click();
  await page
    .getByRole('radiogroup', { name: 'Theme' })
    .getByRole('radio', { name: 'System' })
    .click();
});
