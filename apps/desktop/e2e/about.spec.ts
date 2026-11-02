import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launch } from './integrity/kit';

test('Settings → About shows the version and saves a redacted report (C9)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'conclave-about-'));
  const file = join(dir, 'report.txt');
  const run = await launch('normal', 'light', { CONCLAVE_E2E_SAVE: file });
  try {
    const page = run.page;
    await page.setViewportSize({ width: 1320, height: 860 });
    await page.getByRole('button', { name: /^Settings/ }).click();
    const about = page.getByRole('region', { name: 'About' });
    await expect(about).toContainText(/Conclave \d+\.\d+\.\d+/);
    await about.getByRole('button', { name: 'Export logs…' }).click();
    await expect(about.getByRole('status')).toContainText('Saved to');
    expect(existsSync(file)).toBe(true);
    const report = readFileSync(file, 'utf8');
    expect(report).toContain('== AIs ==');
    expect(report).not.toContain(homedir());
  } finally {
    await run.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
