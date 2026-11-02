import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test';

// v1.0 Q1: typing is never interrupted (U4, the "auto-tab" bug), every menu is fully on screen
// and scrolls to its end at every window size (U1, U2, U27), and Escape closes only the top
// layer (U3).
const here = dirname(fileURLToPath(import.meta.url));
let app: ElectronApplication;
let page: Page;
let home: string;
let repo: string;

const SENTENCE =
  'Build a small greeter: greet(name) returns "Hello, <name>!", with a README section, tests for empty names, and a note on Unicode names like Zoë and 李雷.';

test.beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'conclave-e2e-home-'));
  repo = mkdtempSync(join(tmpdir(), 'conclave-e2e-repo-'));
  const git = (...a: string[]) =>
    execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...a], {
      cwd: repo,
    });
  git('init', '-q', '-b', 'main');
  writeFileSync(
    join(repo, 'package.json'),
    '{ "name": "greeter", "scripts": { "test": "node -e 0" } }\n',
  );
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  app = await electron.launch({
    args: [join(here, '../out/main/index.js')],
    env: {
      ...process.env,
      CONCLAVE_DEMO: '1',
      CONCLAVE_DEMO_SLOW: '1',
      CONCLAVE_HOME: home,
      CONCLAVE_E2E_REPO: repo,
    },
  });
  page = await app.firstWindow();
  await page.setViewportSize({ width: 1320, height: 860 });
});

test.afterAll(async () => {
  await app?.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

/** The open popover's box is inside the window, and its list scrolls to a fully shown end. */
async function expectFullyShown(popover: Locator, what: string) {
  const fit = await popover.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const clipped: string[] = [];
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (s.overflow === 'visible' && s.overflowX === 'visible' && s.overflowY === 'visible')
        continue;
      const q = p.getBoundingClientRect();
      if (
        r.left < q.left - 1 ||
        r.right > q.right + 1 ||
        r.top < q.top - 1 ||
        r.bottom > q.bottom + 1
      )
        clipped.push(p.className.slice(0, 60));
    }
    // Scroll every scrolling list inside it to its end (and the panel, if it scrolls too): its
    // last row must then be fully inside both. A list of several rows must show about four.
    const ends: string[] = [];
    const short: string[] = [];
    for (const list of el.querySelectorAll<HTMLElement>('*')) {
      if (list.scrollHeight <= list.clientHeight + 1) continue;
      const s = getComputedStyle(list);
      if (s.overflowY !== 'auto' && s.overflowY !== 'scroll') continue;
      const rows = list.querySelectorAll<HTMLElement>('button, [role="option"]');
      if (rows.length >= 4 && list.clientHeight < 150) short.push(`${list.clientHeight}px`);
      list.scrollTop = list.scrollHeight;
      const last = [...rows].at(-1);
      if (!last) continue;
      last.scrollIntoView({ block: 'nearest' });
      const a = last.getBoundingClientRect();
      const b = list.getBoundingClientRect();
      const p = el.getBoundingClientRect();
      if (a.bottom > b.bottom + 1 || a.bottom > p.bottom + 1) ends.push(last.textContent ?? '');
    }
    return {
      inside:
        r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1,
      box: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)],
      window: [innerWidth, innerHeight],
      clipped,
      ends,
      short,
    };
  });
  expect(fit.inside, `${what}: ${JSON.stringify(fit)}`).toBe(true);
  expect(fit.clipped, what).toEqual([]);
  expect(fit.ends, `${what}: last row not reachable`).toEqual([]);
  expect(fit.short, `${what}: list too short to use`).toEqual([]);
}

/** Open each picker inside `scope` in turn, check it, and close it with Escape. */
async function checkPickers(scope: Locator, what: string) {
  const triggers = scope.locator('[aria-haspopup="dialog"]:visible');
  const count = await triggers.count();
  expect(count, `${what}: no pickers found`).toBeGreaterThan(0);
  for (let i = 0; i < count; i++) {
    const trigger = triggers.nth(i);
    const name = (await trigger.getAttribute('aria-label')) ?? (await trigger.innerText());
    await trigger.click();
    const popover = page.locator(`[id="${await trigger.getAttribute('aria-controls')}"]`);
    await expect(popover).toBeVisible();
    await expectFullyShown(popover, `${what} › ${name}`);
    await page.keyboard.press('Escape');
    await expect(popover).toBeHidden();
  }
}

const SIZES = [
  { width: 900, height: 600 },
  { width: 1024, height: 700 },
  { width: 1320, height: 860 },
];

test('typing in the New project wizard is never interrupted', async () => {
  await page.getByRole('button', { name: /^Projects/ }).click();
  await page.getByRole('button', { name: 'New project' }).click();
  const dialog = page.getByRole('dialog', { name: 'New project' });
  await dialog.getByRole('button', { name: 'Choose a folder' }).click();
  await expect(dialog.getByLabel('Ready')).toBeVisible();
  await dialog.getByRole('button', { name: 'Next' }).click();
  const goal = dialog.getByRole('textbox', { name: 'Goal' });
  await goal.click();
  // Real keystrokes, one by one: each re-renders the wizard.
  await goal.pressSequentially(SENTENCE, { delay: 4 });
  await expect(goal).toHaveValue(SENTENCE);
  await expect(goal).toBeFocused();
  await expect(dialog).toBeVisible();
  const command = dialog.getByRole('textbox', { name: 'Test command' });
  await command.fill('');
  await command.pressSequentially('npm test -- --run', { delay: 4 });
  await expect(command).toHaveValue('npm test -- --run');
});

test('Escape in a picker inside the wizard closes only the picker', async () => {
  const dialog = page.getByRole('dialog', { name: 'New project' });
  const trigger = dialog.locator('[aria-haspopup="dialog"]:visible').first();
  await trigger.click();
  const popover = page.locator(`[id="${await trigger.getAttribute('aria-controls')}"]`);
  await expect(popover).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(popover).toBeHidden();
  await expect(dialog).toBeVisible();
  await expect(trigger).toBeFocused();
  // The goal typed before is still there.
  await expect(dialog.getByRole('textbox', { name: 'Goal' })).toHaveValue(SENTENCE);
});

for (const size of SIZES) {
  test(`every picker in the wizard is fully shown at ${size.width}×${size.height}`, async () => {
    await page.setViewportSize(size);
    await checkPickers(page.getByRole('dialog', { name: 'New project' }), `wizard ${size.width}`);
  });
}

test('typing in Add a task while the project runs is never interrupted', async () => {
  await page.setViewportSize({ width: 1320, height: 860 });
  const dialog = page.getByRole('dialog', { name: 'New project' });
  await dialog.getByRole('button', { name: 'Next' }).click();
  await dialog.getByRole('button', { name: 'Start', exact: true }).click({ timeout: 30_000 });
  await expect(dialog).toBeHidden();
  // Events stream in while you type (demo slow mode).
  await page.getByRole('button', { name: 'Add a task' }).click();
  const add = page.getByRole('dialog', { name: 'Add a task' });
  const title = add.getByRole('textbox', { name: 'Title' });
  await expect(title).toBeFocused();
  await title.pressSequentially('Handle names with spaces and accents', { delay: 15 });
  const spec = add.getByRole('textbox').nth(1);
  await spec.click();
  await spec.pressSequentially(SENTENCE, { delay: 15 });
  await expect(title).toHaveValue('Handle names with spaces and accents');
  await expect(spec).toHaveValue(SENTENCE);
  await expect(add).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(add).toBeHidden();
});

for (const size of SIZES) {
  test(`every picker on Chat and Council is fully shown at ${size.width}×${size.height}`, async () => {
    await page.setViewportSize(size);
    await page.getByRole('button', { name: 'New chat' }).click();
    await checkPickers(page.locator('main, body').first(), `chat ${size.width}`);
    await page.getByRole('button', { name: 'Ask the council' }).click();
    await checkPickers(
      page.getByRole('group', { name: 'Council members' }),
      `council ${size.width}`,
    );
  });
}

test('a menu stays attached to its button while the dialog behind it scrolls (U27)', async () => {
  await page.setViewportSize({ width: 900, height: 600 });
  await page.getByRole('button', { name: /^Projects/ }).click();
  await page.getByRole('button', { name: 'New project' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New project' });
  const choose = dialog.getByRole('button', { name: 'Choose a folder' });
  if (await choose.isVisible()) {
    await choose.click();
    await expect(dialog.getByLabel('Ready')).toBeVisible();
  }
  const next = dialog.getByRole('button', { name: 'Next' });
  if (await dialog.getByRole('textbox', { name: 'Goal' }).isHidden()) await next.click();
  const trigger = dialog.locator('[aria-haspopup="dialog"]:visible').first();
  await trigger.scrollIntoViewIfNeeded();
  await trigger.click();
  const popover = page.locator(`[id="${await trigger.getAttribute('aria-controls')}"]`);
  await expect(popover).toBeVisible();
  // Wheel over the dialog, away from the menu: the dialog body scrolls under it.
  const box = (await dialog.boundingBox())!;
  await page.mouse.move(box.x + 24, box.y + box.height / 2);
  await page.mouse.wheel(0, 120);
  await page.waitForTimeout(300);
  if (await popover.isVisible()) {
    const t = (await trigger.boundingBox())!;
    const p = (await popover.boundingBox())!;
    const gap = Math.min(Math.abs(p.y - (t.y + t.height)), Math.abs(t.y - (p.y + p.height)));
    expect(gap, 'the menu moved away from its button').toBeLessThan(14);
  }
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1320, height: 860 });
});

test('arrow keys move through the effort choices, focus and selection together (U23)', async () => {
  await page.getByRole('button', { name: 'New chat' }).click();
  await page.getByRole('button', { name: /choose model/ }).click();
  const efforts = page.getByRole('radiogroup', { name: /Effort/ });
  const radios = efforts.getByRole('radio');
  const checked = efforts.locator('[role="radio"][aria-checked="true"]');
  await checked.focus();
  const from = await radios.evaluateAll((els) =>
    els.findIndex((e) => e === document.activeElement),
  );
  await page.keyboard.press('ArrowRight');
  const to = await radios.evaluateAll((els) => els.findIndex((e) => e === document.activeElement));
  expect(to).toBe((from + 1) % (await radios.count()));
  await expect(radios.nth(to)).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Home');
  await expect(radios.first()).toBeFocused();
  await expect(radios.first()).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
});
