import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type Page } from '@playwright/test';

// Every v0.9 AI signed in (CONCLAVE_DEMO_TEAM=9): the picker, the team editor and Accounts with
// seven providers, in light and dark. Screenshots land in e2e/screenshots/nine.
const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'screenshots', 'nine');

const providerButton = (page: Page, name: string) =>
  page
    .getByRole('dialog', { name: 'Choose model' })
    .getByRole('navigation', { name: 'Providers' })
    .getByRole('button', { name: new RegExp(`^${name}:`) });

for (const scheme of ['light', 'dark'] as const) {
  test(`seven AIs in the picker, team editor and accounts (${scheme})`, async () => {
    test.setTimeout(120_000);
    mkdirSync(out, { recursive: true });
    const home = mkdtempSync(join(tmpdir(), 'conclave-nine-'));
    const repo = mkdtempSync(join(tmpdir(), 'nine-repo-'));
    const git = (...a: string[]) =>
      execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...a], {
        cwd: repo,
      });
    git('init', '-q', '-b', 'main');
    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify({ name: 'nine', scripts: { test: 'node -e 0' } }),
    );
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    const app = await electron.launch({
      args: [join(here, '../out/main/index.js')],
      env: {
        ...process.env,
        CONCLAVE_DEMO: '1',
        CONCLAVE_DEMO_TEAM: '9',
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
      await expect(page.getByRole('heading', { name: 'What are we working on?' })).toBeVisible();

      await page.getByRole('button', { name: 'New chat' }).click();
      await page.getByRole('button', { name: 'Choose model' }).click();
      const picker = page.getByRole('dialog', { name: 'Choose model' });
      const rail = picker.getByRole('navigation', { name: 'Providers' });
      for (const name of ['Claude', 'Codex', 'Antigravity', 'Copilot', 'Cursor', 'Grok', 'Local']) {
        await expect(rail.getByRole('button', { name: new RegExp(`^${name}`) })).toBeVisible();
      }
      // The panel never scrolls the page; the provider column fits without scrolling.
      const box = await picker.boundingBox();
      expect(box!.height).toBeLessThanOrEqual(860);
      await shot('picker-claude');

      // Cursor: one chip per maker, efforts from the ids, and Fast where a fast id exists.
      await providerButton(page, 'Cursor').click();
      await expect(picker.getByRole('tablist', { name: 'Model makers' })).toBeVisible();
      await picker.getByRole('tab', { name: /^Claude/ }).click();
      await picker.getByRole('option', { name: /^Claude Opus 5\.5/ }).click();
      await expect(
        picker.getByRole('radiogroup', { name: /^Effort for Claude Opus 5\.5/ }),
      ).toBeVisible();
      await expect(picker.getByRole('checkbox', { name: /Fast/ })).toBeVisible();
      await expect(picker.getByText(/Older Claude models|Older models \(1\)/)).toBeVisible();
      await shot('picker-cursor');
      await picker.getByRole('radio', { name: 'Extra High', exact: true }).click(); // closes
      await expect(page.getByRole('button', { name: 'Choose model' })).toContainText('Extra High');

      // Local models: size and fit for this machine, and the context note instead of efforts.
      await page.getByRole('button', { name: 'Choose model' }).click();
      await providerButton(page, 'Local').click();
      await expect(picker.getByRole('option', { name: /GPT-OSS 20B/ })).toContainText('fits');
      await expect(picker.getByText(/Conclave gives each job the context it needs/)).toBeVisible();
      await shot('picker-local');

      // Grok's own effort levels.
      await providerButton(page, 'Grok').click();
      await expect(picker.getByRole('radio', { name: 'Extra High' })).toBeVisible();
      await expect(picker.getByRole('radio', { name: 'Max' })).toBeHidden();
      await page.keyboard.press('Escape');

      // A chat on the chosen Cursor model runs the id that carries its effort.
      const box2 = page.getByRole('textbox', { name: 'Message' });
      await box2.fill('Hello');
      await box2.press('Enter');
      await expect(page.getByText('Cursor (demo) here.')).toBeVisible();

      // The team editor shows three AIs per role, then "+N more".
      await page.getByRole('button', { name: /^Projects/ }).click();
      await page.getByRole('button', { name: 'New project' }).click();
      const wizard = page.getByRole('dialog', { name: 'New project' });
      await wizard.getByRole('button', { name: 'Choose a folder' }).click();
      await expect(wizard.getByLabel('Ready')).toBeVisible();
      await wizard.getByRole('button', { name: 'Next' }).click();
      await expect(wizard.getByRole('button', { name: /^\+\d more$/ }).first()).toBeVisible();
      await wizard
        .getByRole('button', { name: /^\+\d more$/ })
        .first()
        .click();
      await expect(wizard.getByRole('button', { name: /^Move .* up$/ }).first()).toBeVisible();
      await shot('team-editor');
      await page.keyboard.press('Escape');

      // Accounts: every AI connected; local models offer more downloads.
      await page.getByRole('button', { name: /^Accounts/ }).click();
      for (const name of ['GitHub Copilot', 'Cursor', 'Grok Build', 'Local models']) {
        await expect(
          page.getByRole('region', { name }).getByText('Connected', { exact: true }),
        ).toBeVisible();
      }
      await expect(page.getByRole('heading', { name: 'Get more models' })).toBeVisible();
      await shot('accounts');
    } finally {
      await app.close();
      rmSync(home, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });
}
