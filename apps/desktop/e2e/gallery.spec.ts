import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type Page } from '@playwright/test';

// Screenshots of each screen and popover in light and dark mode, for design review.
// Run with PLENUM_SHOTS=1; images land in e2e/screenshots/gallery.
test.skip(process.env.PLENUM_SHOTS !== '1', 'set PLENUM_SHOTS=1 to capture');

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'screenshots', 'gallery');

for (const scheme of ['light', 'dark'] as const) {
  test(`gallery ${scheme}`, async () => {
    test.setTimeout(180_000);
    mkdirSync(out, { recursive: true });
    const home = mkdtempSync(join(tmpdir(), 'plenum-shots-'));
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
        PLENUM_DEMO: '1',
        PLENUM_DEMO_SLOW: '1',
        PLENUM_DEMO_ASK: '1',
        PLENUM_HOME: home,
        PLENUM_E2E_REPO: repo,
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
      await page
        .getByRole('dialog', { name: 'Choose model' })
        .getByRole('navigation', { name: 'Providers' })
        .getByRole('button', { name: /^Codex/ })
        .click();
      await pickOption(page, 'GPT-6.1-Sol');
      await shot('picker-codex');
      await page.getByRole('radio', { name: 'Low', exact: true }).click();

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
    const home = mkdtempSync(join(tmpdir(), 'plenum-shots-'));
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
        PLENUM_DEMO: '1',
        PLENUM_DEMO_BREAK: '1',
        PLENUM_HOME: home,
        PLENUM_E2E_REPO: repo,
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
      await expect(dialog.getByLabel('Ready')).toBeVisible();
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
        .getByRole('button', { name: /^Add a greet\(\) helper/ })
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
    const home = mkdtempSync(join(tmpdir(), 'plenum-shots-'));
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
        PLENUM_DEMO: '1',
        PLENUM_DEMO_ASK: 'install',
        PLENUM_HOME: home,
        PLENUM_E2E_REPO: repo,
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
      await expect(dialog.getByLabel('Ready')).toBeVisible();
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

for (const scheme of ['light', 'dark'] as const) {
  test(`gallery usage limit ${scheme}`, async () => {
    test.setTimeout(120_000);
    mkdirSync(out, { recursive: true });
    const home = mkdtempSync(join(tmpdir(), 'plenum-shots-'));
    const repo = mkdtempSync(join(tmpdir(), 'greeter-'));
    const git = (...a: string[]) =>
      execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...a], {
        cwd: repo,
      });
    git('init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'README.md'), '# greeter');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    const app = await electron.launch({
      args: [join(here, '../out/main/index.js')],
      env: {
        ...process.env,
        PLENUM_DEMO: '1',
        PLENUM_DEMO_LIMIT: '1',
        PLENUM_HOME: home,
        PLENUM_E2E_REPO: repo,
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
      await expect(dialog.getByLabel('Ready')).toBeVisible();
      await dialog.getByRole('button', { name: 'Next' }).click();
      await dialog
        .getByRole('textbox', { name: 'Goal' })
        .fill('Add a greet() helper and document it.');
      await dialog.getByRole('button', { name: 'Next' }).click();
      await dialog.getByRole('button', { name: 'Start', exact: true }).click();
      const banner = page.getByRole('region', { name: 'Codex is out of usage' });
      await expect(banner).toBeVisible({ timeout: 60_000 });
      // While the work is moving to Claude, which is when the banner matters.
      await page.waitForTimeout(1500);
      await page.screenshot({ path: join(out, `${scheme}-usage-limit.png`) });
      await expect(page.getByRole('region', { name: 'Tasks' })).toContainText('2 of 2 merged', {
        timeout: 60_000,
      });
      await page.getByRole('button', { name: /^Accounts/ }).click();
      await expect(page.getByText(/Out of usage since/)).toBeVisible({ timeout: 30_000 });
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(out, `${scheme}-accounts-limit.png`) });
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

for (const scheme of ['light', 'dark'] as const) {
  test(`gallery lanes ${scheme}`, async () => {
    test.setTimeout(120_000);
    mkdirSync(out, { recursive: true });
    const home = mkdtempSync(join(tmpdir(), 'plenum-shots-'));
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
        PLENUM_DEMO: '1',
        PLENUM_DEMO_SLOW: '1',
        PLENUM_DEMO_LANES: '1',
        PLENUM_HOME: home,
        PLENUM_E2E_REPO: repo,
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
      await expect(dialog.getByLabel('Ready')).toBeVisible();
      await dialog.getByRole('button', { name: 'Next' }).click();
      await dialog
        .getByRole('textbox', { name: 'Goal' })
        .fill('Add a greet() helper and document how to use it.');
      await dialog.getByRole('button', { name: 'Next' }).click();
      await expect(dialog.getByText('What should greet() say?')).toBeVisible({ timeout: 20_000 });
      await dialog.getByRole('button', { name: 'Start', exact: true }).click();
      await expect(page.getByRole('region', { name: 'Lanes: 2 of 2 busy' })).toBeVisible({
        timeout: 30_000,
      });
      await page.waitForTimeout(3000);
      await shot('project-lanes');
      await page.getByRole('button', { name: 'Project actions' }).click();
      await page.getByRole('button', { name: /Team and settings/ }).click();
      const settings = page.getByRole('dialog', { name: 'Project settings' });
      // The default order already matches the measurements, so there's no reorder note to show.
      await expect(settings.getByRole('checkbox', { name: /Adjust the team/ })).toBeAttached();
      await settings.getByRole('checkbox', { name: /Adjust the team/ }).scrollIntoViewIfNeeded();
      await shot('project-settings-team');
      // Review effort: Tests only says what it gives up and what is still reviewed.
      await settings.getByRole('radio', { name: 'Tests only' }).click();
      await expect(settings.getByText(/merges without a reviewer/)).toBeVisible();
      await expect(settings.getByText(/last task is still reviewed/)).toBeVisible();
      await settings.getByRole('radio', { name: 'Tests only' }).scrollIntoViewIfNeeded();
      await shot('project-settings-tests-only');
      await page.keyboard.press('Escape');
      await expect(page.getByRole('article', { name: /Ready to merge/ })).toBeVisible({
        timeout: 60_000,
      });
      // Steering: the task menu, then a chat proposal before and after applying it.
      await page.getByRole('tab', { name: 'Chat' }).click();
      await shot('project-chat-empty');
      await page
        .getByRole('textbox', { name: 'Message to the project' })
        .fill('Add a goodbye helper too, and keep the docs short.');
      await page.getByRole('button', { name: 'Send' }).click();
      await expect(page.getByRole('group', { name: 'Proposed changes' })).toBeVisible();
      await shot('project-chat-proposal');
      await page.getByRole('button', { name: 'Apply 2 changes' }).click();
      await expect(page.getByRole('region', { name: 'Chat' })).toContainText(
        'Added “Add a farewell() helper”',
      );
      await shot('project-chat-applied');
      const row = page
        .getByRole('region', { name: 'Tasks' })
        .getByRole('listitem')
        .filter({ hasText: 'farewell' });
      await row.hover();
      await row.getByRole('button', { name: /^Actions for/ }).click();
      await shot('task-menu');
      await page.keyboard.press('Escape');
    } finally {
      await app.close();
      rmSync(home, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });
}

for (const scheme of ['light', 'dark'] as const) {
  test(`gallery settings ${scheme}`, async () => {
    test.setTimeout(60_000);
    mkdirSync(out, { recursive: true });
    const home = mkdtempSync(join(tmpdir(), 'plenum-shots-'));
    const app = await electron.launch({
      args: [join(here, '../out/main/index.js')],
      env: { ...process.env, PLENUM_DEMO: '1', PLENUM_HOME: home },
      colorScheme: scheme,
    });
    try {
      const page = await app.firstWindow();
      await page.setViewportSize({ width: 1320, height: 860 });
      await page.getByRole('button', { name: /^Settings/ }).click();
      await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Add quiet hours' }).click();
      await page
        .getByRole('group', { name: 'Quiet hours 1' })
        .getByRole('button', { name: 'Claude' })
        .click();
      await page
        .getByRole('radiogroup', { name: 'Codex lanes' })
        .getByRole('radio', { name: '3' })
        .click();
      // From the page's title, not wherever the last click scrolled to.
      await page
        .getByRole('heading', { name: 'Settings', exact: true })
        .evaluate((el) => el.scrollIntoView({ block: 'start' }));
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(out, `${scheme}-settings.png`) });
      await expect(page.getByRole('switch', { name: 'Pause everything' })).toBeEnabled();
      await page.getByRole('switch', { name: 'Pause everything' }).check({ force: true });
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(out, `${scheme}-settings-paused.png`) });
      // Settings persist across a reload.
      await page.reload();
      await page.getByRole('button', { name: /^Settings/ }).click();
      await expect(page.getByRole('switch', { name: 'Pause everything' })).toBeChecked();
      await expect(
        page.getByRole('radiogroup', { name: 'Codex lanes' }).getByRole('radio', { name: '3' }),
      ).toHaveAttribute('aria-checked', 'true');
    } finally {
      await app.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
}
