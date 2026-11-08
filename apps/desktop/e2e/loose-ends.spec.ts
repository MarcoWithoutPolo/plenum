import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test } from '@playwright/test';

// v0.7 loose ends, in demo mode: a task can be stopped and skipped mid-build from the board,
// and turning Pause everything off in Settings resumes a waiting project within seconds.
const here = dirname(fileURLToPath(import.meta.url));

test('stop and skip a building task; Pause everything off resumes at once', async () => {
  test.setTimeout(120_000);
  const home = mkdtempSync(join(tmpdir(), 'plenum-e2e-home-'));
  const repo = mkdtempSync(join(tmpdir(), 'plenum-e2e-loose-'));
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
      PLENUM_DEMO_SLOW: '1',
      PLENUM_HOME: home,
      PLENUM_E2E_REPO: repo,
    },
  });
  const page = await app.firstWindow();
  try {
    await page.setViewportSize({ width: 1320, height: 860 });
    const sidebar = page.getByRole('complementary');
    await sidebar.getByRole('button', { name: /^Projects/ }).click();
    await page.getByRole('button', { name: 'New project' }).click();
    const dialog = page.getByRole('dialog', { name: 'New project' });
    await dialog.getByRole('button', { name: 'Choose a folder' }).click();
    await expect(dialog.getByLabel('Ready')).toBeVisible();
    await dialog.getByRole('button', { name: 'Next' }).click();
    await dialog.getByRole('textbox', { name: 'Goal' }).fill('Add a greet() helper.');
    await dialog.getByRole('button', { name: 'Next' }).click();
    await dialog.getByRole('button', { name: 'Start', exact: true }).click();

    // Stop and skip: the first task, while Codex builds it.
    const tasks = page.getByRole('region', { name: 'Tasks' });
    const first = tasks.getByRole('button', { name: /^Add a greet\(\) helper/ });
    await expect(first).toContainText('Building', { timeout: 30_000 });
    await tasks.getByRole('button', { name: 'Actions for Add a greet() helper' }).click();
    await page.getByRole('button', { name: 'Stop and skip' }).click();
    await expect(first).toContainText('Skipped', { timeout: 10_000 });
    await expect(
      page.getByText('Stopped work on Add a greet() helper: you skipped it'),
    ).toBeVisible();

    // Pause everything: the project waits; off again, it carries on within seconds.
    await sidebar.getByRole('button', { name: 'Settings' }).click();
    // The switch stays disabled (showing off) until Settings has loaded: wait for it, or a
    // click lands on nothing and the pause never changes.
    const pause = page.getByRole('switch', { name: 'Pause everything' });
    await expect(pause).toBeEnabled();
    await pause.check({ force: true });
    await expect(pause).toBeChecked();
    await sidebar.getByRole('button', { name: /^Projects/ }).click();
    await page
      .getByRole('button', { name: /^plenum-e2e-loose-/ })
      .first()
      .click();
    await expect(page.getByText('Waiting for usage', { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await sidebar.getByRole('button', { name: 'Settings' }).click();
    await expect(pause).toBeEnabled();
    await expect(pause).toBeChecked();
    await pause.uncheck({ force: true });
    await expect(pause).not.toBeChecked();
    const off = Date.now();
    await sidebar.getByRole('button', { name: /^Projects/ }).click();
    await page
      .getByRole('button', { name: /^plenum-e2e-loose-/ })
      .first()
      .click();
    await expect(page.getByText('Waiting for usage', { exact: true })).toHaveCount(0, {
      timeout: 10_000,
    });
    expect(Date.now() - off).toBeLessThan(10_000);
  } finally {
    await app.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
