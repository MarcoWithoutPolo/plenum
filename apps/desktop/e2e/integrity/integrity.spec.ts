import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  accessibilityProblems,
  launch,
  layoutProblems,
  pickerProblems,
  type DataSet,
  type Running,
  type Theme,
} from './kit';

/**
 * The UI integrity suite (v1.0 Q3): every screen, in every data set, theme and window size,
 * checked for sideways scrolling, overflowing or cut text, covered controls, accessibility
 * problems, menus that don't fit or can't reach their last row, and console errors.
 *
 * Each push runs the 900×600 and 1320×860 rows; CONCLAVE_FULL_MATRIX=1 adds 1024×700 and
 * 1920×1080. Problems are listed together (and saved to E:/ci-cache/integrity or the temp
 * folder), so one run shows everything wrong.
 */
const FULL = process.env.CONCLAVE_FULL_MATRIX === '1';
const SIZES = [
  { width: 900, height: 600 },
  ...(FULL ? [{ width: 1024, height: 700 }] : []),
  { width: 1320, height: 860 },
  ...(FULL ? [{ width: 1920, height: 1080 }] : []),
];
const REPORT =
  process.env.CONCLAVE_INTEGRITY_OUT ?? join(process.cwd(), 'test-results', 'integrity');

interface Screen {
  name: string;
  open: (page: Page) => Promise<void>;
  /** Open its pickers too (they're checked once per screen and size). */
  pickers?: string;
  only?: DataSet[];
  /** Text this screen must show, per data set. */
  expect?: Partial<Record<DataSet, string>>;
}

const nav = (name: string | RegExp) => async (page: Page) => {
  // Close whatever dialog the last screen left open, one layer at a time.
  for (let i = 0; i < 3 && (await page.locator('[aria-modal="true"]').count()); i++)
    await page.keyboard.press('Escape');
  await expect(page.locator('[aria-modal="true"]')).toHaveCount(0);
  await page.getByRole('button', { name }).first().click();
  await page.waitForTimeout(250);
};

const SCREENS: Screen[] = [
  { name: 'accounts', open: nav(/^Accounts/) },
  { name: 'chat', open: nav('New chat'), pickers: 'body' },
  { name: 'council', open: nav('Ask the council'), pickers: '[role="group"]' },
  {
    name: 'projects',
    open: nav(/^Projects/),
    // A project waiting on questions says so, not "Ready to merge" (U6).
    expect: { stress: '40 questions for you' },
  },
  {
    name: 'new project: where',
    open: async (page) => {
      await nav(/^Projects/)(page);
      await page.getByRole('button', { name: 'New project' }).first().click();
      await page.getByRole('dialog', { name: 'New project' }).waitFor();
    },
    only: ['normal', 'stress'],
  },
  {
    name: 'new project: what',
    open: async (page) => {
      const dialog = page.getByRole('dialog', { name: 'New project' });
      const choose = dialog.getByRole('button', { name: 'Choose a folder' });
      if (await choose.isVisible()) {
        await choose.click();
        await dialog.getByLabel('Ready').waitFor();
      }
      await dialog.getByRole('button', { name: 'Next' }).click();
      await dialog.getByRole('textbox', { name: 'Goal' }).waitFor();
    },
    pickers: '[role="dialog"]',
    only: ['normal', 'stress'],
  },
  {
    name: 'project',
    open: async (page) => {
      await nav(/^Projects/)(page);
      await page
        .getByRole('link')
        .or(page.getByRole('button', { name: /very long name/ }))
        .first()
        .click();
      await page.waitForTimeout(400);
    },
    only: ['stress'],
  },
  { name: 'inbox', open: nav(/^Inbox/) },
  { name: 'usage', open: nav(/^Usage/) },
  { name: 'settings', open: nav(/^Settings/) },
];

const CELLS: { data: DataSet; theme: Theme }[] = [
  { data: 'normal', theme: 'light' },
  { data: 'normal', theme: 'dark' },
  { data: 'empty', theme: 'light' },
  { data: 'stress', theme: 'light' },
  { data: 'stress', theme: 'dark' },
];

for (const cell of CELLS) {
  test.describe(`${cell.data} data, ${cell.theme}`, () => {
    let run: Running;
    test.beforeAll(async () => {
      run = await launch(cell.data, cell.theme);
    });
    test.afterAll(async () => {
      await run?.close();
    });

    for (const size of SIZES) {
      test(`every screen at ${size.width}×${size.height}`, async () => {
        test.setTimeout(240_000);
        const { page } = run;
        await page.setViewportSize(size);
        const problems: string[] = [];
        for (const screen of SCREENS) {
          if (screen.only && !screen.only.includes(cell.data)) continue;
          const where = `${screen.name}`;
          try {
            await screen.open(page);
          } catch (err) {
            problems.push(`${where}: couldn't open (${String(err).split('\n')[0]})`);
            continue;
          }
          // Let fades and slides finish: a half-faded dialog isn't what anyone reads.
          await page.evaluate(() =>
            Promise.race([
              Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))),
              new Promise((ok) => setTimeout(ok, 2000)),
            ]),
          );
          const must = screen.expect?.[cell.data];
          if (must && !(await page.getByText(must).first().isVisible()))
            problems.push(`${where}: "${must}" isn't shown`);
          for (const p of await layoutProblems(page)) problems.push(`${where}: ${p}`);
          for (const p of await accessibilityProblems(page)) problems.push(`${where}: ${p}`);
          if (screen.pickers)
            for (const p of await pickerProblems(page, screen.pickers))
              problems.push(`${where}: ${p}`);
          await page.screenshot({
            path: join(
              REPORT,
              `${cell.data}-${cell.theme}-${size.width}`,
              `${screen.name.replace(/[^a-z]+/g, '-')}.png`,
            ),
          });
        }
        await page.keyboard.press('Escape');
        problems.push(...run.errors.splice(0));
        const unique = [...new Set(problems)];
        mkdirSync(REPORT, { recursive: true });
        writeFileSync(
          join(REPORT, `${cell.data}-${cell.theme}-${size.width}.txt`),
          unique.join('\n'),
        );
        expect(unique, unique.join('\n')).toEqual([]);
      });
    }
  });
}
