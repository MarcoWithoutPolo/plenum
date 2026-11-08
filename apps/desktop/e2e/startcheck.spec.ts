import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test } from '@playwright/test';

// The start-up check in demo mode: Codex starts at its usage limit, so pressing Resume first
// says what that changes (Claude builds, so Antigravity reviews, far slower), with Resume anyway,
// Wait until… and Edit team. With CONCLAVE_SHOTS=1 it saves gallery images in light and dark.
const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'screenshots', 'gallery');

for (const scheme of ['light', 'dark'] as const) {
  test(`start-up check: an AI out of usage, explained before the start (${scheme})`, async () => {
    test.skip(
      scheme === 'dark' && process.env.CONCLAVE_SHOTS !== '1',
      'dark runs with CONCLAVE_SHOTS=1',
    );
    test.setTimeout(120_000);
    mkdirSync(out, { recursive: true });
    const home = mkdtempSync(join(tmpdir(), 'conclave-e2e-home-'));
    const repo = mkdtempSync(join(tmpdir(), 'conclave-e2e-check-'));
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
        CONCLAVE_DEMO_OUT: 'codex',
        CONCLAVE_DEMO_SLOW: '1',
        CONCLAVE_HOME: home,
        CONCLAVE_E2E_REPO: repo,
      },
      colorScheme: scheme,
    });
    const page = await app.firstWindow();
    const shot = async (name: string) => {
      if (process.env.CONCLAVE_SHOTS !== '1') return;
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(out, `${scheme}-${name}.png`) });
    };
    try {
      await page.setViewportSize({ width: 1320, height: 860 });
      await page.getByRole('button', { name: /^Projects/ }).click();
      await page.getByRole('button', { name: 'New project' }).click();
      const dialog = page.getByRole('dialog', { name: 'New project' });
      await dialog.getByRole('button', { name: 'Choose a folder' }).click();
      await expect(dialog.getByLabel('Ready')).toBeVisible();
      await dialog.getByRole('button', { name: 'Next' }).click();
      await dialog.getByRole('textbox', { name: 'Goal' }).fill('Add a greet() helper.');
      await dialog.getByRole('button', { name: 'Next' }).click();
      await dialog.getByRole('button', { name: 'Start', exact: true }).click();
      // Stop it right away, so the header's own button runs the check.
      await page.getByRole('button', { name: 'Stop', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();

      await page.getByRole('button', { name: 'Resume', exact: true }).click();
      const note = page.getByRole('group', { name: 'Before you start' });
      await expect(note).toContainText(
        /Codex is at its usage limit until .+\. Building moves to Claude, so reviews of Claude's work go to Antigravity, which is about 3× slower here\./,
      );
      await shot('start-check');

      // Edit team opens the project settings; nothing started.
      await note.getByRole('button', { name: 'Edit team' }).click();
      const settings = page.getByRole('dialog', { name: 'Project settings' });
      await expect(settings).toBeVisible();
      await settings.getByRole('button', { name: 'Cancel' }).click();
      await expect(note).toHaveCount(0);

      // Wait until…: the project waits, and says for whom.
      await page.getByRole('button', { name: 'Resume', exact: true }).click();
      await note.getByRole('button', { name: /^Wait until / }).click();
      await expect(page.getByText(/Starts at .+, when Codex can work again/).first()).toBeVisible();
      await shot('start-check-waiting');
      await page.getByRole('button', { name: 'Stop', exact: true }).click();

      // Resume anyway: it runs now, with the team the note described.
      await page.getByRole('button', { name: 'Resume', exact: true }).click();
      await note.getByRole('button', { name: 'Resume anyway' }).click();
      await expect(note).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
    } finally {
      await app.close();
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });
}
