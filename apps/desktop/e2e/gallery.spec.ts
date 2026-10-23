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
        CONCLAVE_DEMO_ASK: '1',
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
      await expect(dialog.getByLabel('Ready')).toBeVisible();
      await shot('new-project-where');
      await dialog.getByRole('button', { name: 'Next' }).click();
      await dialog
        .getByRole('textbox', { name: 'Goal' })
        .fill('Add a greet() helper and document how to use it.');
      await shot('new-project-what');
      await dialog.getByRole('button', { name: 'Next' }).click();
      await expect(dialog.getByText('What should greet() say?')).toBeVisible({ timeout: 20_000 });
      await shot('new-project-clarify');
      await dialog.getByRole('button', { name: 'Start', exact: true }).click();
      await expect(page.getByRole('status').filter({ hasText: 'building' })).toBeVisible({
        timeout: 20_000,
      });
      await shot('project-running');

      // The second task's builder asks a question; the project waits for it.
      const needsYou = page.getByRole('region', { name: 'Needs you' });
      await expect(needsYou).toBeVisible({ timeout: 60_000 });
      await shot('project-needs-you');
      await page.getByRole('button', { name: /^Inbox/ }).click();
      await expect(page.getByRole('region', { name: 'Questions' })).toBeVisible();
      await shot('inbox-question');
      await page.getByRole('radio', { name: /Friendly, with examples/ }).click();
      await page.getByRole('button', { name: 'Answer' }).click();
      await page
        .getByRole('complementary')
        .getByRole('button', { name: /^Projects/ })
        .click();
      await page
        .getByRole('button', { name: /greeter/ })
        .first()
        .click();
      await expect(page.getByRole('article', { name: /Ready to merge/ })).toBeVisible({
        timeout: 60_000,
      });
      await shot('project-done');
      await page.getByRole('tab', { name: /Decisions/ }).click();
      await shot('project-decisions');
      await page.getByRole('tab', { name: 'Activity' }).click();
      await page.getByRole('region', { name: 'Tasks' }).getByRole('button').first().click();
      await page.waitForTimeout(300);
      await shot('task-drawer');
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Project actions' }).click();
      await page.getByRole('button', { name: /Team and settings/ }).click();
      await page.waitForTimeout(300);
      await shot('project-settings');
      await page
        .getByRole('dialog', { name: 'Project settings' })
        .getByRole('radiogroup', { name: 'Retry strategy' })
        .scrollIntoViewIfNeeded();
      await shot('project-settings-permissions');
      await page.keyboard.press('Escape');
      await page
        .getByRole('complementary')
        .getByRole('button', { name: /^Projects/ })
        .click();
      await shot('projects-list');
      await page.getByRole('button', { name: /^Inbox/ }).click();
      await shot('inbox');
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

for (const scheme of ['light', 'dark'] as const) {
  test(`gallery failures ${scheme}`, async () => {
    test.setTimeout(120_000);
    mkdirSync(out, { recursive: true });
    const home = mkdtempSync(join(tmpdir(), 'conclave-shots-'));
    const repo = mkdtempSync(join(tmpdir(), 'greeter-'));
    const git = (...a: string[]) =>
      execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...a], {
        cwd: repo,
      });
    git('init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'README.md'), '# greeter\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    const app = await electron.launch({
      args: [join(here, '../out/main/index.js')],
      env: {
        ...process.env,
        CONCLAVE_DEMO: '1',
        CONCLAVE_DEMO_BREAK: '1',
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
      await page
        .getByRole('complementary')
        .getByRole('button', { name: /^Projects/ })
        .click();
      await page.getByRole('button', { name: 'New project' }).click();
      const dialog = page.getByRole('dialog', { name: 'New project' });
      await dialog.getByRole('button', { name: 'Choose a folder' }).click();
      await dialog.getByRole('button', { name: 'Next' }).click();
      await dialog
        .getByRole('textbox', { name: 'Goal' })
        .fill('Add a greet() helper and document how to use it.');
      await dialog
        .getByRole('radiogroup', { name: 'Attempts per task' })
        .getByRole('radio', { name: '1', exact: true })
        .click();
      await dialog.getByRole('button', { name: 'Next' }).click();
      await dialog.getByRole('button', { name: 'Start', exact: true }).click();
      await expect(page.getByRole('region', { name: /Codex problem/ })).toBeVisible({
        timeout: 60_000,
      });
      await shot('project-failed');
      await page
        .getByRole('region', { name: 'Tasks' })
        .getByRole('button', { name: /greet\(\) helper/ })
        .click();
      await page.waitForTimeout(300);
      await shot('failure-card');
    } finally {
      await app.close();
      rmSync(home, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });
}

for (const scheme of ['light', 'dark'] as const) {
  test(`gallery install request ${scheme}`, async () => {
    test.setTimeout(120_000);
    mkdirSync(out, { recursive: true });
    const home = mkdtempSync(join(tmpdir(), 'conclave-shots-'));
    const repo = mkdtempSync(join(tmpdir(), 'greeter-'));
    const git = (...a: string[]) =>
      execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...a], {
        cwd: repo,
      });
    git('init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'README.md'), '# greeter\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    const app = await electron.launch({
      args: [join(here, '../out/main/index.js')],
      env: {
        ...process.env,
        CONCLAVE_DEMO: '1',
        CONCLAVE_DEMO_ASK: 'install',
        CONCLAVE_HOME: home,
        CONCLAVE_E2E_REPO: repo,
      },
      colorScheme: scheme,
    });
    try {
      const page = await app.firstWindow();
      await page.setViewportSize({ width: 1320, height: 860 });
      await page
        .getByRole('complementary')
        .getByRole('button', { name: /^Projects/ })
        .click();
      await page.getByRole('button', { name: 'New project' }).click();
      const dialog = page.getByRole('dialog', { name: 'New project' });
      await dialog.getByRole('button', { name: 'Choose a folder' }).click();
      await dialog.getByRole('button', { name: 'Next' }).click();
      await dialog
        .getByRole('textbox', { name: 'Goal' })
        .fill('Add a greet() helper and document it.');
      await dialog.getByRole('button', { name: 'Next' }).click();
      await dialog.getByRole('button', { name: 'Start', exact: true }).click();
      const card = page.getByRole('region', { name: 'Needs you' });
      await expect(card).toContainText('Install marked?', { timeout: 60_000 });
      await card.scrollIntoViewIfNeeded();
      await page.waitForTimeout(250);
      await page.screenshot({ path: join(out, `${scheme}-install-request.png`) });
      await card.getByText("Why it's asking").click();
      await page.waitForTimeout(250);
      await page.screenshot({ path: join(out, `${scheme}-install-request-why.png`) });
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
