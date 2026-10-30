import { _electron as electron } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const out = process.argv[2];
const app = await electron.launch({
  args: [join(import.meta.dirname, '../out/main/index.js')],
  env: { ...process.env, CONCLAVE_DEMO: '1', CONCLAVE_HOME: mkdtempSync(join(tmpdir(), 'pick-')) },
});
const page = await app.firstWindow();
await page.setViewportSize({ width: 1320, height: 860 });
await page.waitForLoadState('load');
const states = [
  ['1-claude', async () => {}],
  [
    '2-cursor',
    async (p) =>
      p
        .getByRole('navigation', { name: 'Providers' })
        .getByRole('button', { name: /^Cursor:/ })
        .click(),
  ],
  [
    '3-cursor-effort',
    async (p) => {
      await p.getByRole('tab', { name: /^Claude/ }).click();
      await p.getByRole('option', { name: /Claude Opus 5\.5/ }).click();
      await p.getByRole('radio', { name: 'XHigh' }).click();
    },
  ],
  [
    '4-antigravity',
    async (p) =>
      p
        .getByRole('navigation', { name: 'Providers' })
        .getByRole('button', { name: /^Antigravity:/ })
        .click(),
  ],
  [
    '5-codex',
    async (p) =>
      p
        .getByRole('navigation', { name: 'Providers' })
        .getByRole('button', { name: /^Codex:/ })
        .click(),
  ],
  [
    '8-local',
    async (p) =>
      p
        .getByRole('navigation', { name: 'Providers' })
        .getByRole('button', { name: /^Local models:/ })
        .click(),
  ],
  ['6-search', async (p) => p.getByRole('textbox', { name: 'Search models' }).fill('opus')],
  [
    '7-grok',
    async (p) => {
      await p.getByRole('textbox', { name: 'Search models' }).fill('');
      await p
        .getByRole('navigation', { name: 'Providers' })
        .getByRole('button', { name: /^Grok Build:/ })
        .click();
    },
  ],
];
for (const scheme of ['light', 'dark']) {
  await page.emulateMedia({ colorScheme: scheme });
  await page.evaluate(() => {
    location.hash = '#picker-preview';
    location.reload();
  });
  await page.waitForLoadState('load');
  await page.getByRole('textbox', { name: 'Search models' }).waitFor();
  for (const [name, act] of states) {
    await act(page);
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(out, `${name}-${scheme}.png`) });
  }
}
await app.close();
