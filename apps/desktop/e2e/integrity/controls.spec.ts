import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { launch, type DataSet, type Running } from './kit';

/**
 * Every control does something (v1.0 Q3, the control inventory).
 *
 * 1. Each screen's controls (role and name) are listed in `controls.json`. A control that
 *    appears or disappears fails the run until the list is updated (PLENUM_UPDATE_CONTROLS=1),
 *    so no control ships without someone looking at it.
 * 2. Each control is clicked while every engine call fails (PLENUM_DEMO_FAIL=*): nothing
 *    can change for real, and the click must still visibly do something: open a layer, change
 *    a value, move focus, change the screen, or show the failure.
 */
const here = dirname(fileURLToPath(import.meta.url));
const INVENTORY = join(here, 'controls.json');
const UPDATE = process.env.PLENUM_UPDATE_CONTROLS === '1';

interface Screen {
  name: string;
  data: DataSet;
  open: (page: Page) => Promise<void>;
}

const nav = (name: string | RegExp) => async (page: Page) => {
  for (let i = 0; i < 3 && (await page.locator('[aria-modal="true"], [data-popover]').count()); i++)
    await page.keyboard.press('Escape');
  await page.getByRole('button', { name }).first().click();
  await page.waitForTimeout(300);
};

const SCREENS: Screen[] = [
  { name: 'accounts', data: 'normal', open: nav(/^Accounts/) },
  { name: 'chat', data: 'normal', open: nav('New chat') },
  { name: 'council', data: 'normal', open: nav('Ask the council') },
  { name: 'projects', data: 'stress', open: nav(/^Projects/) },
  {
    name: 'project',
    data: 'stress',
    open: async (page) => {
      await nav(/^Projects/)(page);
      await page
        .getByRole('button', { name: /very long name/ })
        .first()
        .click();
      await page.waitForTimeout(400);
    },
  },
  { name: 'inbox', data: 'stress', open: nav(/^Inbox/) },
  { name: 'usage', data: 'normal', open: nav(/^Usage/) },
  { name: 'settings', data: 'normal', open: nav(/^Settings/) },
];

/** The controls on screen now, in the main area (the sidebar is checked once, on its own). */
async function controlsOf(page: Page, scope: string) {
  return page.locator(scope).evaluate((root) => {
    const sel =
      'button, a[href], [role="switch"], [role="tab"], [role="radio"], [role="checkbox"], input[type="checkbox"], select, summary';
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    const label = (el: Element) =>
      (el.getAttribute('aria-label') ?? (el as HTMLElement).innerText ?? el.textContent ?? '')
        .trim()
        .replace(/\s+/g, ' ')
        // Numbers and times change between runs; the control is the same.
        .replace(/\d+/g, '#')
        .slice(0, 60);
    return [...root.querySelectorAll(sel)]
      .filter((el) => visible(el) && !el.closest('[aria-hidden="true"]'))
      .map((el) => `${el.getAttribute('role') ?? el.tagName.toLowerCase()}: ${label(el)}`);
  });
}

/** The control an inventory entry ("role: label") names, inside the main area. */
function locate(page: Page, entry: string) {
  const [kind, ...rest] = entry.split(': ');
  const label = rest.join(': ');
  const role =
    (
      { a: 'link', select: 'combobox', summary: 'group', input: 'checkbox' } as Record<
        string,
        string
      >
    )[kind!] ?? kind!;
  // The label as a pattern: special characters taken literally, and "#" for any number.
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/#/g, '\\d+');
  const name = new RegExp(`^\\s*${escaped}`);
  return page.locator('main').getByRole(role as Parameters<Page['getByRole']>[0], { name });
}

/** A fingerprint of what the page shows, to tell whether a click did anything. */
const state = (page: Page) =>
  page.evaluate(() => ({
    html: document.body.innerHTML.length + ':' + document.body.innerText.length,
    focus: document.activeElement?.outerHTML.slice(0, 120) ?? '',
    layers: document.querySelectorAll('[aria-modal="true"], [data-popover], [role="alert"]').length,
  }));

let run: Running | undefined;
let running: DataSet | undefined;
async function appFor(data: DataSet): Promise<Page> {
  if (run && running === data) return run.page;
  await run?.close();
  run = await launch(data, 'light');
  running = data;
  await run.page.setViewportSize({ width: 1320, height: 860 });
  return run.page;
}
test.afterAll(async () => {
  await run?.close();
});

const failAll = (on: boolean) =>
  run!.app.evaluate(
    (_e, value) => {
      process.env.PLENUM_DEMO_FAIL = value;
    },
    on ? '*' : '',
  );

const found: Record<string, string[]> = {};

for (const screen of SCREENS) {
  test(`every control on ${screen.name} does something`, async () => {
    test.setTimeout(600_000);
    const page = await appFor(screen.data);
    await screen.open(page);
    const controls = await controlsOf(page, 'main');
    found[screen.name] = controls;
    // Every control is clicked from a freshly opened screen, about 15 s each on a fast machine:
    // the time allowed grows with the screen (a fixed 10 min ran out on a busy one, 1.0.1 S4).
    test.setTimeout(120_000 + controls.length * 40_000);
    const dead: string[] = [];
    for (let i = 0; i < controls.length; i++) {
      // Start each click from the screen as it was.
      await failAll(false);
      await screen.open(page);
      // Found by role and name (the nth of its kind when names repeat), never by position:
      // hidden checkboxes would shift positions and the wrong control would be clicked.
      const entry = controls[i]!;
      const occurrence = controls.slice(0, i).filter((c) => c === entry).length;
      const target = locate(page, entry).nth(occurrence);
      if ((await target.count()) === 0) continue;
      if (await target.isDisabled().catch(() => true)) continue;
      // No message left from the last click: a new one must be able to show as a change.
      await page
        .getByRole('alert')
        .first()
        .waitFor({ state: 'hidden', timeout: 3000 })
        .catch(() => undefined);
      const before = await state(page);
      await failAll(true);
      // A visually hidden checkbox (a styled switch) is clicked where people click: its label.
      const box = await target.boundingBox();
      const where = box && box.width <= 2 ? target.locator('xpath=ancestor::label[1]') : target;
      await where.click({ timeout: 3000, force: true }).catch(() => undefined);
      await page.waitForTimeout(450);
      const after = await state(page);
      const moved = (await page.locator('main').count()) === 0;
      if (
        !moved &&
        before.html === after.html &&
        before.focus === after.focus &&
        before.layers === after.layers
      )
        dead.push(controls[i]!);
      await failAll(false);
      for (
        let k = 0;
        k < 3 && (await page.locator('[aria-modal="true"], [data-popover]').count());
        k++
      )
        await page.keyboard.press('Escape');
      // Close any message the click left, so the next control starts from a quiet screen.
      const messages = page.getByRole('alert').getByRole('button');
      for (
        let k = 0;
        k < 3 &&
        (await messages
          .first()
          .isVisible()
          .catch(() => false));
        k++
      )
        // A message can close itself while being clicked; then there is nothing left to close.
        await messages
          .first()
          .click({ timeout: 3000 })
          .catch(() => undefined);
    }
    expect(dead, `controls that did nothing on ${screen.name}`).toEqual([]);
  });
}

test('the controls on every screen are the ones in the inventory', () => {
  const known: Record<string, string[]> = existsSync(INVENTORY)
    ? (JSON.parse(readFileSync(INVENTORY, 'utf8')) as Record<string, string[]>)
    : {};
  const sorted = Object.fromEntries(
    Object.entries(found).map(([k, v]) => [k, [...new Set(v)].sort()]),
  );
  if (UPDATE || !existsSync(INVENTORY)) {
    // Screens not run this time keep their entries.
    writeFileSync(INVENTORY, `${JSON.stringify({ ...known, ...sorted }, null, 2)}\n`);
    return;
  }
  // Settings leaves out what a platform doesn't have: "open at login" on Linux, and the
  // close-window choice on a Mac (closing the window never quits there).
  const notHere = new Set(
    {
      linux: ['switch: Open when you sign in to your computer'],
      darwin: ['radio: Ask', 'radio: Keep running', 'radio: Quit'],
    }[process.platform as string] ?? [],
  );
  for (const [screen, controls] of Object.entries(sorted)) {
    const was = new Set((known[screen] ?? []).filter((c) => !notHere.has(c)));
    const now = new Set(controls);
    const added = controls.filter((c) => !was.has(c));
    const removed = [...was].filter((c) => !now.has(c));
    expect(
      { added, removed },
      `${screen}: controls changed; check them, then run with PLENUM_UPDATE_CONTROLS=1`,
    ).toEqual({ added: [], removed: [] });
  }
});
