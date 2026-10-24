import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test } from '@playwright/test';

// A web project in demo mode: the builder writes a page, Conclave screenshots it, a reviewer
// that can see sends it back once ("the count sits at the left"), and the fix merges. Along the
// way: the live preview, the Screenshots section, the visual failure card, the settings and
// the Usage line. With CONCLAVE_SHOTS=1 it also runs in dark mode and saves gallery images.
const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'screenshots', 'gallery');

for (const scheme of ['light', 'dark'] as const) {
  test(`visual review: preview, screenshots, a visual send-back and its fix (${scheme})`, async () => {
    test.skip(
      scheme === 'dark' && process.env.CONCLAVE_SHOTS !== '1',
      'dark runs with CONCLAVE_SHOTS=1',
    );
    test.setTimeout(180_000);
    mkdirSync(out, { recursive: true });
    const home = mkdtempSync(join(tmpdir(), 'conclave-e2e-home-'));
    const repo = mkdtempSync(join(tmpdir(), 'conclave-e2e-web-'));
    const git = (...a: string[]) =>
      execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...a], {
        cwd: repo,
        encoding: 'utf8',
      }).trim();
    git('init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'README.md'), '# counter\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    const app = await electron.launch({
      args: [join(here, '../out/main/index.js')],
      env: {
        ...process.env,
        CONCLAVE_DEMO: '1',
        CONCLAVE_DEMO_WEB: '1',
        CONCLAVE_DEMO_VISUAL: '1',
        CONCLAVE_HOME: home,
        CONCLAVE_E2E_REPO: repo,
      },
      colorScheme: scheme,
    });
    const shot = async (name: string) => {
      if (process.env.CONCLAVE_SHOTS !== '1') return;
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(out, `${scheme}-${name}.png`) });
    };
    const page = await app.firstWindow();
    try {
      await page.setViewportSize({ width: 1320, height: 900 });
      await page.getByRole('button', { name: /^Projects/ }).click();
      await page.getByRole('button', { name: 'New project' }).click();
      const dialog = page.getByRole('dialog', { name: 'New project' });
      await dialog.getByRole('button', { name: 'Choose a folder' }).click();
      await expect(dialog.getByLabel('Ready')).toBeVisible();
      await dialog.getByRole('button', { name: 'Next' }).click();
      await dialog.getByRole('textbox', { name: 'Goal' }).fill('A counter page.');
      await dialog
        .getByRole('radiogroup', { name: 'Attempts per task' })
        .getByRole('radio', { name: '1', exact: true })
        .click();
      await dialog.getByRole('button', { name: 'Next' }).click();
      await dialog.getByRole('button', { name: 'Start', exact: true }).click();

      // With one attempt, the visual send-back fails the task, so its card stays up.
      const tasks = page.getByRole('region', { name: 'Tasks' });
      await expect(tasks).toContainText('Failed', { timeout: 90_000 });
      await tasks.getByRole('button', { name: /^Build the counter page/ }).click();
      const drawer = page.getByRole('dialog', { name: 'Build the counter page' });
      await expect(drawer).toContainText('Looks wrong');
      const issue = drawer.getByRole('checkbox', {
        name: 'The count sits at the left edge, away from the title and button; center it',
      });
      await expect(issue).toBeChecked();
      // The screenshot the reviewer saw, with the region outlined.
      await expect(
        drawer.getByRole('img', { name: /^after: \/ \(phone, dark\): The count sits/ }),
      ).toBeVisible();
      await shot('visual-failure');

      // The Screenshots section: every size and theme, with the free checks' notes.
      const shots = drawer.getByRole('region', { name: 'Screenshots' });
      await shots.scrollIntoViewIfNeeded();
      await expect(shots.getByRole('img', { name: '/, desktop, light' })).toBeVisible();
      await shots
        .getByRole('radiogroup', { name: 'Size' })
        .getByRole('radio', { name: 'Phone' })
        .click();
      await shots
        .getByRole('radiogroup', { name: 'Theme' })
        .getByRole('radio', { name: 'Dark' })
        .click();
      await expect(shots.getByRole('img', { name: '/, phone, dark' })).toBeVisible();
      await shot('screenshots-first');

      // Retry: the builder centers the count, the reviewer looks again and approves.
      // The project pauses once nothing else is left to build; retry, then resume.
      await expect(page.getByText('Paused', { exact: true }).first()).toBeVisible({
        timeout: 60_000,
      });
      await drawer.getByRole('button', { name: 'Retry', exact: true }).click();
      await page.keyboard.press('Escape');
      await expect(page.getByText('Ready to resume', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Resume', exact: true }).click();
      await expect(page.getByText('Goal met', { exact: true }).first()).toBeVisible({
        timeout: 90_000,
      });
      await tasks.getByRole('button', { name: /^Build the counter page/ }).click();
      await expect(drawer).toContainText('Reviewed by');
      const after = drawer.getByRole('region', { name: 'Screenshots' });
      await after.scrollIntoViewIfNeeded();
      // Compared with what was merged before it (the empty repo had no page, so the second
      // attempt's shots compare with the first set only when one exists).
      await expect(after.getByRole('img').first()).toBeVisible();
      await shot('screenshots-merged');
      await page.keyboard.press('Escape');

      // The live preview of what's merged: the page itself, in a sandboxed frame.
      await page.getByRole('button', { name: 'Preview', exact: true }).click();
      const pane = page.getByRole('region', { name: /^Preview: / });
      const frame = pane.frameLocator('iframe');
      await expect(frame.getByRole('heading', { name: 'Counter' })).toBeVisible({
        timeout: 30_000,
      });
      // Desktop width is scaled down to fit; the page is shown whole.
      await expect(pane.locator('iframe')).toHaveAttribute('title', /1280 px$/);
      await pane
        .getByRole('radiogroup', { name: 'Device width' })
        .getByRole('radio', { name: /Phone/ })
        .click();
      await expect(pane.locator('iframe')).toHaveAttribute('title', /390 px/);
      // At phone width the frame is not scaled (Playwright can't click through a CSS scale).
      await frame.getByRole('button', { name: 'Add one' }).click();
      await expect(frame.locator('#count')).toHaveText('1');
      await shot('preview');
      await pane.getByRole('button', { name: 'Close the preview' }).click();
      await expect(pane).toHaveCount(0);

      // Settings: the Visual review switch and the pages to check, for web projects only.
      await page.getByRole('button', { name: 'Project actions' }).click();
      await page.getByRole('button', { name: /Team and settings/ }).click();
      const settings = page.getByRole('dialog', { name: 'Project settings' });
      await expect(settings.getByRole('checkbox', { name: 'Visual review' })).toBeChecked();
      await settings.getByRole('textbox', { name: 'Pages to check' }).fill('/ about');
      await expect(settings).toContainText('Paths start with "/": about');
      await expect(settings.getByRole('button', { name: 'Save' })).toBeDisabled();
      await settings.getByRole('textbox', { name: 'Pages to check' }).fill('/ /about');
      await settings.getByRole('checkbox', { name: 'Visual review' }).uncheck();
      await settings.getByRole('button', { name: 'Save' }).click();
      await expect(settings).toHaveCount(0);
      await page.getByRole('button', { name: 'Project actions' }).click();
      await page.getByRole('button', { name: /Team and settings/ }).click();
      await expect(settings.getByRole('checkbox', { name: 'Visual review' })).not.toBeChecked();
      await expect(settings.getByRole('textbox', { name: 'Pages to check' })).toHaveValue(
        '/ /about',
      );
      await settings.getByRole('button', { name: 'Cancel' }).click();

      // Usage: what the screenshots cost.
      await page
        .getByRole('complementary')
        .getByRole('button', { name: /^Usage/ })
        .click();
      await expect(
        page.getByText(/^Visual review: about [\d,]+ tokens of screenshots in 2 reviews/),
      ).toBeVisible();
      await shot('usage-visual');
    } finally {
      await app.close();
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });
}
