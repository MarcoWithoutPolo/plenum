import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type Page } from '@playwright/test';

// Screenshots of each screen and popover in light and dark mode, for design review.
// Run with CONCLAVE_SHOTS=1; images land in e2e/screenshots/gallery.
test.skip(process.env.CONCLAVE_SHOTS !== '1', 'set CONCLAVE_SHOTS=1 to capture');

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'screenshots', 'gallery');

for (const scheme of ['light', 'dark'] as const) {
  test(`gallery ${scheme}`, async () => {
    test.setTimeout(180_000);
    mkdirSync(out, { recursive: true });
    const home = mkdtempSync(join(tmpdir(), 'conclave-shots-'));
    const repo = mkdtempSync(join(tmpdir(), 'greeter-'));
    const git = (...a: string[]) =>
      execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...a], {
        cwd: repo,
      });
    git('init', '-q', '-b', 'main');
    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify({ name: 'greeter', scripts: { test: 'node -e 0' } }),
    );
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    const app = await electron.launch({
      args: [join(here, '../out/main/index.js')],
      env: {
        ...process.env,
        CONCLAVE_DEMO: '1',
        CONCLAVE_DEMO_SLOW: '1',
        CONCLAVE_HOME: home,
        CONCLAVE_E2E_REPO: repo,
      },
      colorScheme: scheme,
    });
    try {
      const page = await app.firstWindow();
      await page.setViewportSize({ width: 1320, height: 860 });
      const shot = async (name: string) => {
        await page.waitForTimeout(250);
        await page.screenshot({ path: join(out, `${scheme}-${name}.png`) });
      };

      await page.getByRole('button', { name: /^Accounts/ }).click();
      await expect(page.getByRole('heading', { name: 'Accounts' })).toBeVisible();
      await expect(page.getByText('Plan usage').first()).toBeVisible();
      await shot('accounts');

      await page.getByRole('button', { name: 'New chat' }).click();
      await page.getByRole('button', { name: 'Choose model' }).click();
      await shot('picker-claude');
      await pickOption(page, 'GPT-6.1-Sol');
      await shot('picker-codex');
      await page.getByRole('radio', { name: 'low', exact: true }).click();

      const box = page.getByRole('textbox', { name: 'Message' });
      await box.fill('How should I store app settings?');
      await box.press('Enter');
      await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
      await page
        .getByText(/tokens$/)
        .first()
        .hover();
      await shot('chat-usage');

      await page.getByRole('button', { name: 'Ask the council' }).click();
      await page.getByRole('button', { name: 'OpenAI Codex model' }).click();
      await shot('council-member-picker');
      await page.keyboard.press('Escape');
      await box.fill('Best way to store small settings?');
      await box.press('Enter');
      await expect(page.getByRole('article', { name: 'Council answer' })).toContainText('JSON');
      await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
      await shot('council');

      await page
        .getByRole('complementary')
        .getByRole('button', { name: /^Projects/ })
        .click();
      await expect(page.getByRole('heading', { name: 'Start your first project' })).toBeVisible();
      await shot('projects-empty');
      await page.getByRole('button', { name: 'New project' }).click();
      const dialog = page.getByRole('dialog', { name: 'New project' });
      await dialog.getByRole('button', { name: 'Choose a folder' }).click();
      await dialog
        .getByRole('textbox', { name: 'Goal' })
        .fill('Add a greet() helper and document how to use it.');
      await shot('new-project');
      await dialog.getByRole('button', { name: 'Create and start' }).click();
      await expect(page.getByRole('status').filter({ hasText: 'building' })).toBeVisible({
        timeout: 20_000,
      });
      await shot('project-running');
      await expect(page.getByRole('region', { name: 'Ready to merge' })).toBeVisible({
        timeout: 60_000,
      });
      await shot('project-done');
      await page.getByRole('region', { name: 'Tasks' }).getByRole('button').first().click();
      await page.waitForTimeout(300);
      await shot('task-drawer');
      await page.keyboard.press('Escape');
      await page
        .getByRole('complementary')
        .getByRole('button', { name: /^Projects/ })
        .click();
      await shot('projects-list');
      await page.getByRole('button', { name: /^Approvals/ }).click();
      await shot('approvals');
      await page.getByRole('button', { name: /^Usage/ }).click();
      await expect(page.getByRole('region', { name: 'Recent requests' })).toContainText('Project');
      await shot('usage');
    } finally {
      await app.close();
      rmSync(home, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });
}

async function pickOption(page: Page, name: string) {
  await page
    .getByRole('dialog', { name: 'Choose model' })
    .getByRole('option', { name: new RegExp(`^${name}`) })
    .click();
}
