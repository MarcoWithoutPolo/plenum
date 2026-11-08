import { expect, test } from '@playwright/test';
import { launch, type Running } from './integrity/kit';

// v1.0 F4: skip a council member, and Merge now, in the real window (demo, a slow member).
let run: Running;
test.beforeAll(async () => {
  run = await launch('normal', 'light', { PLENUM_DEMO_SLOW_COUNCIL: '1' });
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
  // Skipped once it has written something, so there's something to keep.
  await expect(page.getByRole('article', { name: 'Antigravity answer' })).toContainText(
    'Antigravity (demo)',
    { timeout: 20_000 },
  );
  await skip.click();
  const card = page.getByRole('article', { name: 'Antigravity answer, skipped' });
  await expect(card).toContainText('Skipped by you');
  // A follow-up typed while the round runs survives the round finishing and saving.
  await box.fill('A follow-up I am still typing');
  const merged = page.getByRole('article', { name: 'Council answer' }).last();
  await expect(merged).toContainText('Where they agree', { timeout: 20_000 });
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Which database should a small team use?',
  );
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue(
    'A follow-up I am still typing',
  );
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
  // Finished, not just started: a member's Skip button goes once its answer is done.
  await expect(page.getByRole('button', { name: 'Skip Claude' })).toBeHidden({ timeout: 20_000 });
  await expect(page.getByRole('button', { name: 'Skip Codex' })).toBeHidden({ timeout: 20_000 });
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
