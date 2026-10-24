import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test } from '@playwright/test';

// A project with its own dev server: the preview asks once before running `npm run dev`, then
// loads it; allowed once, it opens straight away next time (a changed command asks again:
// covered by the BrainManager.preview unit tests).
// With CONCLAVE_SHOTS=1 it also runs in dark mode and saves gallery images.
const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'screenshots', 'gallery');

const SERVER = `const http = require('http');
const fs = require('fs');
http
  .createServer((q, s) => {
    s.setHeader('content-type', 'text/html');
    s.end(fs.readFileSync('index.html'));
  })
  .listen(+process.env.PORT, '127.0.0.1', () => console.log('Ready on http://localhost:' + process.env.PORT));
`;
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="color-scheme" content="light dark">
<title>Shop</title><style>body{font:18px system-ui;margin:3rem;text-align:center}</style></head>
<body><h1>Served by its own dev server</h1><p>npm run dev</p></body></html>
`;

for (const scheme of ['light', 'dark'] as const) {
  test(`dev-server preview: asks once, then loads it (${scheme})`, async () => {
    test.skip(
      scheme === 'dark' && process.env.CONCLAVE_SHOTS !== '1',
      'dark runs with CONCLAVE_SHOTS=1',
    );
    test.setTimeout(120_000);
    mkdirSync(out, { recursive: true });
    const home = mkdtempSync(join(tmpdir(), 'conclave-e2e-home-'));
    const repo = mkdtempSync(join(tmpdir(), 'conclave-e2e-dev-'));
    const git = (...a: string[]) =>
      execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...a], {
        cwd: repo,
      });
    git('init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'index.html'), PAGE);
    writeFileSync(join(repo, 'server.js'), SERVER);
    const pkg = (dev: string) =>
      writeFileSync(
        join(repo, 'package.json'),
        JSON.stringify({ name: 'shop', private: true, scripts: { dev } }, null, 2),
      );
    pkg('node server.js');
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
    const page = await app.firstWindow();
    const shot = async (name: string) => {
      if (process.env.CONCLAVE_SHOTS !== '1') return;
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(out, `${scheme}-${name}.png`) });
    };
    try {
      await page.setViewportSize({ width: 1320, height: 900 });
      await page.getByRole('button', { name: /^Projects/ }).click();
      await page.getByRole('button', { name: 'New project' }).click();
      const dialog = page.getByRole('dialog', { name: 'New project' });
      await dialog.getByRole('button', { name: 'Choose a folder' }).click();
      await expect(dialog.getByLabel('Ready')).toBeVisible();
      await dialog.getByRole('button', { name: 'Next' }).click();
      await dialog.getByRole('textbox', { name: 'Goal' }).fill('A small shop page.');
      await dialog.getByRole('button', { name: 'Next' }).click();
      await dialog.getByRole('button', { name: 'Start', exact: true }).click();
      await page.getByRole('button', { name: 'Stop', exact: true }).click();

      // The first time, it asks before running the project's own code.
      await page.getByRole('button', { name: 'Preview', exact: true }).click();
      const pane = page.getByRole('region', { name: /^Preview: / });
      const ask = pane.getByRole('group', { name: 'Allow the preview command' });
      await expect(ask).toContainText('Start a preview with npm run dev?');
      await expect(ask).toContainText('Runs: node server.js');
      await shot('preview-approval');
      await ask.getByRole('button', { name: 'Allow for this project' }).click();
      const frame = pane.frameLocator('iframe');
      await expect(frame.getByRole('heading', { name: 'Served by its own dev server' }))
        .toBeVisible({
          timeout: 60_000,
        })
        .catch(async (err: unknown) => {
          // What the pane said, and the server's own output, for a failure on CI.
          console.log('PANE', await pane.innerText().catch(() => '(gone)'));
          console.log(
            'SRC',
            await pane
              .locator('iframe')
              .getAttribute('src')
              .catch(() => null),
          );
          console.log(
            'LOGS',
            await page.evaluate(async () => {
              const w = window as unknown as {
                conclave: {
                  projects: {
                    list(): Promise<{ project: { id: string } }[]>;
                    previewLogs(id: string): Promise<string>;
                  };
                };
              };
              const [p] = await w.conclave.projects.list();
              return p ? w.conclave.projects.previewLogs(p.project.id) : '(no project)';
            }),
          );
          throw err;
        });
      await expect(pane).toContainText('Running the project’s own dev server on this computer.');
      await pane.getByText('Server output').click();
      await expect(pane).toContainText('Ready on http://localhost:');
      await shot('preview-dev-server');
      await pane.getByRole('button', { name: 'Close the preview' }).click();

      // Allowed once: no question the next time, and the decision is on record.
      await page.getByRole('button', { name: 'Preview', exact: true }).click();
      await expect(
        frame.getByRole('heading', { name: 'Served by its own dev server' }),
      ).toBeVisible({
        timeout: 60_000,
      });
      await expect(ask).toHaveCount(0);
      await pane.getByRole('button', { name: 'Close the preview' }).click();
      await page.getByRole('tab', { name: /Decisions/ }).click();
      await expect(page.getByRole('region', { name: 'Decisions' })).toContainText(
        'npm run dev → node server.js',
      );
    } finally {
      await app.close();
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
      rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    }
  });
}
