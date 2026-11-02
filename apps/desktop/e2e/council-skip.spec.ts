import { expect, test } from '@playwright/test';
import { launch, type Running } from './integrity/kit';

// v1.0 F4: skip a council member, and Merge now, in the real window (demo, a slow member).
let run: Running;
test.beforeAll(async () => {
  run = await launch('normal', 'light', { CONCLAVE_DEMO_SLOW_COUNCIL: '1' });
  await run.page.setViewportSize({ width: 1320, height: 860 });
});
test.afterAll(async () => {
  await run?.close();
});

test('skip the slow member: it says so, keeps what it wrote, and the rest merge', async () => {
  const page = run.page;
  await page.getByRole('button', { name: 'Ask the council' }).click();
  const box = page.getByRole('textbox').last();
  await box.fill('Which database should a small team use?');
  await box.press('Enter');
  const skip = page.getByRole('button', { name: 'Skip Antigravity' });
  await expect(skip).toBeVisible();
  await skip.click();
  const card = page.getByRole('article', { name: 'Antigravity answer, skipped' });
  await expect(card).toContainText('Skipped by you');
  const merged = page.getByRole('article', { name: 'Council answer' }).last();
  await expect(merged).toContainText('Where they agree', { timeout: 20_000 });
  // Saved: still skipped, and what it had written is there, folded.
  await card.getByRole('button', { name: 'Show what it wrote' }).click();
  await expect(card).toContainText('Antigravity (demo)');
});

test('Merge now merges what came back without waiting', async () => {
  const page = run.page;
  const box = page.getByRole('textbox').last();
  await box.fill('And for backups?');
  await box.press('Enter');
  // Once Claude and Codex have answered (Antigravity still going): merge those two now.
  await expect(page.getByText('Codex (demo) here. You asked: "And for backups?"')).toBeVisible({
    timeout: 20_000,
  });
  const mergeNow = page.getByRole('button', { name: 'Merge now' });
  await expect(mergeNow).toBeVisible();
  await mergeNow.click();
  await expect(
    page.getByRole('article', { name: 'Antigravity answer, skipped' }).last(),
  ).toBeVisible();
  await expect(page.getByRole('article', { name: 'Council answer' }).last()).toContainText(
    'Where they agree',
    { timeout: 20_000 },
  );
  expect(run.errors).toEqual([]);
});
