import { expect, test, type Page } from '@playwright/test';
import { launch, type Running } from './kit';

/**
 * Every failure is shown (v1.0 Q2 rules 1–4, Q3 fault injection): each action's call to the
 * engine is made to fail while the app runs (PLENUM_DEMO_FAIL). The error must appear where
 * you'd look, nothing may claim it worked, and the control must work again afterwards.
 */
let run: Running;
let page: Page;

test.beforeAll(async () => {
  run = await launch('normal', 'light', { PLENUM_DEMO_SLOW: '1' });
  page = run.page;
  await page.setViewportSize({ width: 1320, height: 860 });
});
test.afterAll(async () => {
  await run?.close();
});

/** Make these engine calls fail (or none) from now on. */
const failing = (channels: string) =>
  run.app.evaluate((_electron, list) => {
    process.env.PLENUM_DEMO_FAIL = list;
  }, channels);

const toast = () => page.getByRole('alert').filter({ hasText: 'Demo failure' });

test.afterEach(async () => {
  await failing('');
  const close = page.getByRole('button', { name: 'Dismiss' });
  if (await close.isVisible()) await close.click();
});

test('a sign-in that fails says so on the card, and the button works again (U7)', async () => {
  await page.getByRole('button', { name: /^Accounts/ }).click();
  const card = page.getByRole('region', { name: 'Claude Code' });
  await failing('accounts:sign-in');
  await card.getByRole('button', { name: 'Switch account' }).click();
  await expect(card.getByRole('alert')).toContainText('Demo failure');
  await expect(card.getByRole('button', { name: 'Switch account' })).toBeEnabled();
});

test('a setting the engine refuses goes back to what is saved, with the reason (U8)', async () => {
  await page.getByRole('button', { name: /^Settings/ }).click();
  const pause = page.getByRole('switch', { name: 'Pause everything' });
  await expect(pause).not.toBeChecked();
  // The switch is disabled until settings load; a click before then would do nothing.
  await expect(pause).toBeEnabled();
  await failing('settings:update');
  await pause.locator('xpath=ancestor::label[1]').click();
  await expect(toast()).toBeVisible();
  await expect(pause).not.toBeChecked();
});

test('a chat that fails to send says so, and the composer works again', async () => {
  await page.getByRole('button', { name: 'New chat' }).click();
  await failing('chat:send');
  const box = page.getByRole('textbox').last();
  await box.fill('Hello there');
  await box.press('Enter');
  await expect(toast()).toBeVisible();
  await failing('');
  await box.fill('Hello again');
  await box.press('Enter');
  await expect(page.getByText(/You asked: "Hello again"/)).toBeVisible({ timeout: 20_000 });
});

test('a council that fails says so', async () => {
  await page.getByRole('button', { name: 'Ask the council' }).click();
  await failing('council:ask');
  const box = page.getByRole('textbox').last();
  await box.fill('Which is better?');
  await box.press('Enter');
  await expect(toast()).toBeVisible();
});

test('finishing a council never pulls you away from another screen (U5)', async () => {
  await page.getByRole('button', { name: 'Ask the council' }).click();
  const box = page.getByRole('textbox').last();
  await box.fill('Slow question for everyone');
  await box.press('Enter');
  await page.getByRole('button', { name: /^Usage/ }).click();
  await expect(page.getByRole('heading', { name: 'Usage', level: 1 })).toBeVisible();
  // The demo council answers within a few seconds; the screen must stay on Usage.
  await page.waitForTimeout(8000);
  await expect(page.getByRole('heading', { name: 'Usage', level: 1 })).toBeVisible();
});

test('a project that fails to start says so, and Start works again (U11)', async () => {
  await page.getByRole('button', { name: /^Projects/ }).click();
  await page.getByRole('button', { name: 'New project' }).first().click();
  const wizard = page.getByRole('dialog', { name: 'New project' });
  await wizard.getByRole('button', { name: 'Choose a folder' }).click();
  await expect(wizard.getByLabel('Ready')).toBeVisible();
  await wizard.getByRole('button', { name: 'Next' }).click();
  await wizard.getByRole('textbox', { name: 'Goal' }).fill('Add a greet() helper.');
  await wizard.getByRole('button', { name: 'Next' }).click();
  // Save it without starting, then start it from the project page with start failing.
  await wizard.getByRole('button', { name: 'Save without starting' }).click({ timeout: 30_000 });
  await expect(wizard).toBeHidden();
  await failing('projects:start');
  const start = page.getByRole('button', { name: /^(Start|Resume)$/ });
  await start.click();
  await expect(toast()).toBeVisible();
  await expect(start).toBeEnabled();
});

test('a task that fails to save keeps the dialog and the edit (U12)', async () => {
  await page.getByRole('button', { name: 'Add a task' }).click();
  const add = page.getByRole('dialog', { name: 'Add a task' });
  await add.getByRole('textbox', { name: 'Title' }).fill('Handle empty names');
  await failing('projects:add-task');
  await add.getByRole('button', { name: 'Add task' }).click();
  await expect(add.getByRole('alert')).toContainText('Not saved');
  await expect(add).toBeVisible();
  await expect(add.getByRole('textbox', { name: 'Title' })).toHaveValue('Handle empty names');
  await failing('');
  await add.getByRole('button', { name: 'Add task' }).click();
  await expect(add).toBeHidden();
});

test('no unhandled errors along the way', () => {
  expect(run.errors.filter((e) => !e.includes('Demo failure'))).toEqual([]);
});

test('the delete button on a chat in the sidebar can be reached by keyboard (U22)', async () => {
  const del = page.getByRole('button', { name: /^Delete / }).first();
  await del.focus();
  await expect(del).toBeFocused();
  await expect(del).toHaveCSS('opacity', '1');
});
