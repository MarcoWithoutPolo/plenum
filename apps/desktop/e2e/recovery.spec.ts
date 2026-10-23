import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test } from '@playwright/test';

// Failure recovery in demo mode: Codex's builds crash, so both tasks fail on it; the
// project explains whose problem it is, and "Retry all with Claude" gets the work merged.
const here = dirname(fileURLToPath(import.meta.url));

test('a provider that keeps failing is called out, and Retry all hands the work to another AI', async () => {
  test.setTimeout(120_000);
  const home = mkdtempSync(join(tmpdir(), 'conclave-e2e-home-'));
  const repo = mkdtempSync(join(tmpdir(), 'conclave-e2e-broken-'));
  const git = (...a: string[]) =>
    execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...a], {
      cwd: repo,
      encoding: 'utf8',
    }).trim();
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
  });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1320, height: 860 });
    await page.getByRole('button', { name: /^Projects/ }).click();
    await page.getByRole('button', { name: 'New project' }).click();
    const dialog = page.getByRole('dialog', { name: 'New project' });
    await dialog.getByRole('button', { name: 'Choose a folder' }).click();
    await dialog.getByRole('button', { name: 'Next' }).click();
    await dialog
      .getByRole('textbox', { name: 'Goal' })
      .fill('Add a greet() helper and document it.');
    await dialog
      .getByRole('radiogroup', { name: 'Attempts per task' })
      .getByRole('radio', { name: '1', exact: true })
      .click();
    await dialog.getByRole('button', { name: 'Next' }).click();
    await expect(dialog.getByText('What should greet() say?')).toBeVisible({ timeout: 20_000 });
    await dialog.getByRole('button', { name: 'Start', exact: true }).click();

    const banner = page.getByRole('region', { name: 'Codex problem' });
    await expect(banner).toContainText('Codex caused 2 failed tasks', { timeout: 60_000 });
    const tasks = page.getByRole('region', { name: 'Tasks' });
    await expect(tasks).toContainText('0 of 2 merged');
    await expect(tasks).toContainText('Codex stopped with an error');

    // The drawer explains the failure and offers the fixes.
    await tasks.getByRole('button', { name: /Add a greet\(\) helper/ }).click();
    const drawer = page.getByRole('dialog', { name: 'Add a greet() helper' });
    await expect(drawer).toContainText('The AI tool stopped');
    await expect(drawer).toContainText('Attempt 1');
    await expect(drawer.getByRole('button', { name: 'Retry with…' })).toBeVisible();
    await page.keyboard.press('Escape');

    await banner.getByRole('button', { name: /Retry all 2 with Claude/ }).click();
    await expect(banner).toBeHidden();
    await page
      .getByRole('button', { name: /Resume|Start/ })
      .first()
      .click();
    await expect(page.getByRole('article', { name: /Ready to merge/ })).toBeVisible({
      timeout: 60_000,
    });
    await expect(tasks).toContainText('2 of 2 merged');
    await expect(tasks).toContainText('Claude built');
  } finally {
    await app.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});
