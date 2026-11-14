import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launch } from './integrity/kit';

test('Settings → About shows the version and saves a redacted report (C9)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'plenum-about-'));
  const file = join(dir, 'report.txt');
  const run = await launch('normal', 'light', { PLENUM_E2E_SAVE: file });
  try {
    const page = run.page;
    await page.setViewportSize({ width: 1320, height: 860 });
    await page.getByRole('button', { name: /^Settings/ }).click();
    const about = page.getByRole('region', { name: 'About' });
    await expect(about).toContainText(/Plenum \d+\.\d+\.\d+/);
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

test('Report a problem saves the logs and opens a bug report with nothing personal in it (1.0.1 S1)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'plenum-report-'));
  const file = join(dir, 'plenum-diagnostics.txt');
  const run = await launch('normal', 'light', { PLENUM_E2E_SAVE: file });
  try {
    // Record the link instead of opening a browser.
    await run.app.evaluate(({ shell }) => {
      const opened: string[] = [];
      (globalThis as unknown as { opened: string[] }).opened = opened;
      shell.openExternal = async (url: string) => {
        opened.push(url);
      };
    });
    const page = run.page;
    await page.setViewportSize({ width: 1320, height: 860 });
    await page.getByRole('button', { name: /^Settings/ }).click();
    const about = page.getByRole('region', { name: 'About' });
    await about.getByRole('button', { name: 'Report a problem…' }).click();
    await expect
      .poll(() =>
        run.app.evaluate(() => (globalThis as unknown as { opened: string[] }).opened.length),
      )
      .toBe(1);
    const url = new URL(
      await run.app.evaluate(() => (globalThis as unknown as { opened: string[] }).opened[0]!),
    );
    expect(url.origin + url.pathname).toBe('https://github.com/MarcoWithoutPolo/plenum/issues/new');
    expect(url.searchParams.get('template')).toBe('bug.yml');
    expect(url.searchParams.get('version')).toMatch(/^\d+\.\d+\.\d+/);
    expect(url.searchParams.get('system')).toContain('Electron');
    expect(url.searchParams.get('logs')).toContain('plenum-diagnostics.txt');
    // The file's name, never its folder or anything else about this computer.
    expect(url.href).not.toContain(encodeURIComponent(dir));
    expect(decodeURIComponent(url.href)).not.toContain(homedir());
    expect(existsSync(file)).toBe(true);
  } finally {
    await run.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
