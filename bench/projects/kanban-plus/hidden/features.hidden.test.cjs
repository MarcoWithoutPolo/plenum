// Hidden acceptance tests for kanban-plus: the theme switch, keyboard shortcuts and CSV export.
// Never shown to any agent. kanban.hidden.test.cjs (the original board's checks) runs alongside.
// Same harness: serve the result over HTTP and drive it in Electron's Chromium through Playwright.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const { createReadStream, existsSync, statSync } = fs;
const { extname, join, normalize } = require('node:path');

const root = process.env.BENCH_ROOT;
const { _electron: electron } = require(join(root, 'node_modules', '@playwright', 'test'));
const electronBin = require(join(root, 'node_modules', 'electron'));

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};
const dir = process.cwd();
const server = http.createServer((req, res) => {
  const path = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^([/\\])+/, '');
  let file = join(dir, path);
  if (!file.startsWith(dir)) return void res.writeHead(403).end();
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file)) return void res.writeHead(404).end();
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
});

let app;
let page;
const errors = [];

test.before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  app = await electron.launch({
    executablePath: electronBin,
    args: [join(__dirname, 'electron-main.cjs')],
    env: { ...process.env, KANBAN_URL: url },
  });
  page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForLoadState('load');
});

test.after(async () => {
  await app?.close();
  server.close();
});

async function fresh() {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForLoadState('load');
}
const col = (name) => page.locator(`[data-column="${name}"]`);
const cards = (name) => col(name).locator('[data-card]');
const newCard = () => page.getByRole('textbox', { name: 'New card' });
async function add(text) {
  await newCard().fill(text);
  await page.getByRole('button', { name: 'Add card' }).click();
}
const texts = async (name) =>
  (await cards(name).allInnerTexts()).map((t) => t.split('\n')[0].trim());
/** The shortcuts dialog, if one is showing. */
const dialog = () => page.getByRole('dialog');
/** Put focus on nothing in particular, the way a user clicking the page background would. */
async function blur() {
  await page.evaluate(() => document.activeElement?.blur());
}

// --- Theme ---------------------------------------------------------------------------------------

// The control's accessible name starts with "Theme" (a wrapping <label> adds the shown value).
const THEME = /^\s*Theme\b/i;
const themeSelect = () =>
  page.getByRole('combobox', { name: THEME }).or(page.getByRole('listbox', { name: THEME }));

/** Pick a theme through the UI: a <select> labelled Theme, or a Theme button opening the choices. */
async function chooseTheme(choice) {
  const select = themeSelect();
  if (await select.count()) return void (await select.first().selectOption({ label: choice }));
  await page.getByRole('button', { name: THEME }).first().click();
  for (const role of ['menuitemradio', 'menuitem', 'radio', 'option', 'button']) {
    const item = page.getByRole(role, { name: choice, exact: true });
    if (await item.count()) return void (await item.first().click());
  }
  throw new Error(`no "${choice}" choice for the Theme control`);
}

/** Effective background behind an element (composited up its ancestors), as in the kanban checks. */
const PAGE_HELPERS = `
  const parse = (c) => { const m = c.match(/rgba?\\(([^)]+)\\)/); if (!m) return [0,0,0,0]; const p = m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number); return [p[0],p[1],p[2],p[3] === undefined ? 1 : p[3]]; };
  const over = (top, under) => { const a = top[3]; return [0,1,2].map((i) => top[i]*a + under[i]*(1-a)).concat(1); };
  const canvas = () => /dark/.test(getComputedStyle(document.documentElement).colorScheme) && (matchMedia('(prefers-color-scheme: dark)').matches || !/light/.test(getComputedStyle(document.documentElement).colorScheme)) ? [18,18,18,1] : [255,255,255,1];
  const bgOf = (el) => { const chain = []; for (let e = el; e; e = e.parentElement) chain.push(parse(getComputedStyle(e).backgroundColor)); let c = canvas(); for (const b of chain.reverse()) if (b[3] > 0) c = over(b, c); return c; };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); }; return 0.2126*f(c[0]) + 0.7152*f(c[1]) + 0.0722*f(c[2]); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x,y)+0.05)/(Math.min(x,y)+0.05); };
`;

async function settle() {
  await page.evaluate(() =>
    Promise.race([
      Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))),
      new Promise((r) => setTimeout(r, 2000)),
    ]),
  );
}
async function scheme(colorScheme) {
  await page.emulateMedia({ colorScheme });
  await settle();
}
/** Luminance of the page background (0 black … 1 white). */
async function background() {
  await settle();
  return page.evaluate((helpers) => {
    // eslint-disable-next-line no-new-func
    const h = new Function(`${helpers}; return { bgOf, lum };`)();
    return h.lum(h.bgOf(document.body));
  }, PAGE_HELPERS);
}
async function lowContrast() {
  await settle();
  return page.evaluate((helpers) => {
    // eslint-disable-next-line no-new-func
    const h = new Function(`${helpers}; return { parse, over, bgOf, ratio };`)();
    const bad = [];
    const els = [...document.querySelectorAll('body *')].filter((e) => {
      if (e.closest('[hidden],[aria-hidden="true"]') || e.disabled) return false;
      if (e.tagName === 'OPTION') return false; // drawn by the system's own popup
      const own = [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      const r = e.getBoundingClientRect();
      return own && r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden';
    });
    for (const e of els) {
      const bg = h.bgOf(e);
      const fg = h.over(h.parse(getComputedStyle(e).color), bg);
      const r = h.ratio(fg, bg);
      if (r < 4.5)
        bad.push(
          `${e.tagName.toLowerCase()} "${e.textContent.trim().slice(0, 20)}" ${r.toFixed(2)}`,
        );
    }
    return bad;
  }, PAGE_HELPERS);
}

test('the Theme control offers System, Light and Dark, and Dark overrides a light system', async () => {
  await fresh();
  await add('Plan the release');
  await scheme('light');
  await chooseTheme('Dark');
  const dark = await background();
  assert.ok(dark < 0.2, `Dark on a light system: background luminance ${dark.toFixed(2)}`);
  await chooseTheme('System');
  const system = await background();
  assert.ok(system > 0.6, `System on a light system: background luminance ${system.toFixed(2)}`);
});

test('Light overrides a dark system setting', async () => {
  await fresh();
  await scheme('dark');
  try {
    const before = await background();
    assert.ok(before < 0.2, `a dark system starts dark: ${before.toFixed(2)}`);
    await chooseTheme('Light');
    const light = await background();
    assert.ok(light > 0.6, `Light on a dark system: background luminance ${light.toFixed(2)}`);
  } finally {
    await scheme('light');
  }
});

test('System follows the system setting as it changes', async () => {
  await fresh();
  await chooseTheme('Dark');
  await chooseTheme('System');
  await scheme('dark');
  const dark = await background();
  await scheme('light');
  const light = await background();
  assert.ok(dark < 0.2 && light > 0.6, `dark ${dark.toFixed(2)}, light ${light.toFixed(2)}`);
});

test('the theme is saved in localStorage and applied after a reload', async () => {
  await fresh();
  await chooseTheme('Dark');
  const saved = await page.evaluate(() =>
    Object.keys(localStorage).map((k) => localStorage.getItem(k)),
  );
  assert.ok(
    saved.some((v) => /dark/i.test(v)),
    `the choice is in localStorage: ${JSON.stringify(saved)}`,
  );
  await page.reload();
  await page.waitForLoadState('load');
  const dark = await background();
  assert.ok(dark < 0.2, `Dark after a reload on a light system: ${dark.toFixed(2)}`);
  const select = themeSelect().and(page.locator('select'));
  if (await select.count()) {
    const shown = await select.first().evaluate((s) => s.selectedOptions[0]?.textContent.trim());
    assert.strictEqual(shown, 'Dark', 'the Theme select shows the saved choice');
  }
});

test('text is readable in the chosen Light and Dark themes, whatever the system says', async () => {
  await fresh();
  await add('Plan the release');
  await add('Write the notes');
  await cards('todo').first().getByRole('button', { name: 'Move right' }).click();
  const found = {};
  try {
    for (const [system, choice] of [
      ['light', 'Dark'],
      ['dark', 'Light'],
    ]) {
      await scheme(system);
      await chooseTheme(choice);
      await blur();
      found[`${choice} on ${system}`] = await lowContrast();
    }
  } finally {
    await scheme('light');
  }
  assert.deepStrictEqual(found, { 'Dark on light': [], 'Light on dark': [] });
});

// --- Keyboard ------------------------------------------------------------------------------------

test('N puts the cursor in the New card field without typing an n', async () => {
  await fresh();
  await blur();
  await page.keyboard.press('n');
  const focused = await page.evaluate(
    () => document.activeElement?.id || document.activeElement?.tagName,
  );
  assert.ok(
    await newCard().evaluate((el) => el === document.activeElement),
    `focus is on ${focused}`,
  );
  assert.strictEqual(await newCard().inputValue(), '');
  await page.keyboard.type('Typed after N');
  await page.keyboard.press('Enter');
  assert.deepStrictEqual(await texts('todo'), ['Typed after N']);
});

test('shortcuts never interrupt typing in the New card field', async () => {
  await fresh();
  await add('Existing');
  await newCard().click();
  await page.keyboard.type('n? N');
  assert.strictEqual(await newCard().inputValue(), 'n? N');
  assert.strictEqual(await dialog().count(), 0, 'no dialog opened while typing');
  await page.keyboard.press('Home');
  await page.keyboard.press('Delete');
  assert.strictEqual(await newCard().inputValue(), '? N', 'Delete deletes text in the field');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowRight');
  assert.deepStrictEqual(await texts('todo'), ['Existing'], 'no card moved or deleted');
});

test('? opens a dialog listing the shortcuts, and Escape closes it', async () => {
  await fresh();
  await blur();
  await page.keyboard.press('?');
  const d = dialog();
  await d.first().waitFor({ state: 'visible', timeout: 3000 });
  const text = await d.first().innerText();
  for (const [what, re] of [
    ['N', /(^|[^A-Za-z])N([^A-Za-z]|$)/],
    ['?', /\?/],
    ['ArrowLeft', /←|ArrowLeft|Left/],
    ['ArrowRight', /→|ArrowRight|Right/],
    ['Delete', /Delete|Del\b/],
    ['Escape', /Esc/i],
  ])
    assert.match(text, re, `the dialog lists ${what}`);
  const readable = await lowContrast();
  assert.deepStrictEqual(readable, [], 'the dialog is readable');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  assert.ok(
    (await dialog().count()) === 0 || !(await dialog().first().isVisible()),
    'Escape closes the dialog',
  );
});

test('ArrowRight and ArrowLeft move the focused card, which keeps focus', async () => {
  await fresh();
  await add('Mover');
  await add('Stayer');
  await cards('todo').first().focus();
  await page.keyboard.press('ArrowRight');
  assert.deepStrictEqual(await texts('todo'), ['Stayer']);
  assert.deepStrictEqual(await texts('doing'), ['Mover']);
  await page.keyboard.press('ArrowRight');
  assert.deepStrictEqual(await texts('doing'), []);
  assert.deepStrictEqual(await texts('done'), ['Mover'], 'the card kept focus and moved on');
  await page.keyboard.press('ArrowLeft');
  assert.deepStrictEqual(await texts('doing'), ['Mover']);
  assert.deepStrictEqual(await texts('done'), []);
  // The board is saved, as with the buttons.
  await page.reload();
  await page.waitForLoadState('load');
  assert.deepStrictEqual([await texts('todo'), await texts('doing')], [['Stayer'], ['Mover']]);
});

test('arrow keys do nothing at the ends of the board', async () => {
  await fresh();
  await add('Edge');
  await cards('todo').first().focus();
  await page.keyboard.press('ArrowLeft');
  assert.deepStrictEqual([await texts('todo'), await texts('doing')], [['Edge'], []]);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await cards('done').first().focus();
  await page.keyboard.press('ArrowRight');
  assert.deepStrictEqual(
    [await texts('todo'), await texts('doing'), await texts('done')],
    [[], [], ['Edge']],
  );
});

test('Delete removes the focused card', async () => {
  await fresh();
  await add('Keep me');
  await add('Remove me');
  await add('Keep me too');
  await cards('todo').nth(1).focus();
  await page.keyboard.press('Delete');
  assert.deepStrictEqual(await texts('todo'), ['Keep me', 'Keep me too']);
  assert.strictEqual(await col('todo').locator('[data-count]').innerText(), '2');
  await page.reload();
  await page.waitForLoadState('load');
  assert.deepStrictEqual(await texts('todo'), ['Keep me', 'Keep me too']);
});

test('cards can be reached with Tab', async () => {
  await fresh();
  await add('Reachable');
  await newCard().focus();
  let reached = false;
  for (let i = 0; i < 12 && !reached; i++) {
    await page.keyboard.press('Tab');
    reached = await page.evaluate(() => document.activeElement?.matches('[data-card]') ?? false);
  }
  assert.ok(reached, 'Tab reaches the card itself');
});

// --- CSV export ----------------------------------------------------------------------------------

/** Click Export CSV and capture the download in Electron's main process. */
async function exportCsv() {
  const folder = fs.mkdtempSync(join(os.tmpdir(), 'kanban-csv-'));
  const save = join(folder, 'download.csv');
  let timer;
  try {
    await app.evaluate(({ session }, save) => {
      globalThis.__benchDownload = new Promise((resolve) => {
        session.defaultSession.once('will-download', (_e, item) => {
          item.setSavePath(save);
          item.once('done', (_e2, state) => resolve({ state, filename: item.getFilename() }));
        });
      });
    }, save);
    await page.getByRole('button', { name: 'Export CSV' }).click();
    const result = await Promise.race([
      app.evaluate(() => globalThis.__benchDownload),
      new Promise((r) => {
        timer = setTimeout(() => r({ state: 'no download within 10 s' }), 10_000);
      }),
    ]);
    assert.strictEqual(result.state, 'completed', `download ${result.state}`);
    assert.match(result.filename, /\.csv$/i, `file name ${result.filename}`);
    const text = fs.readFileSync(save, 'utf8').replace(/^\uFEFF/, '');
    return text.split(/\r?\n/).filter((line, i, all) => line !== '' || i < all.length - 1);
  } finally {
    clearTimeout(timer);
    fs.rmSync(folder, { recursive: true, force: true });
  }
}

test('Export CSV downloads a column,text header and the cards in board order', async () => {
  await fresh();
  for (const t of ['Alpha', 'Bravo', 'Charlie', 'Delta']) await add(t);
  const right = (name, i) => cards(name).nth(i).getByRole('button', { name: 'Move right' });
  await right('todo', 0).click(); // Alpha -> Doing
  await right('todo', 1).click(); // Charlie -> Doing
  await right('doing', 0).click(); // Alpha -> Done
  assert.deepStrictEqual(await exportCsv(), [
    'column,text',
    'To do,Bravo',
    'To do,Delta',
    'Doing,Charlie',
    'Done,Alpha',
  ]);
});

test('Export CSV quotes commas and double quotes, and keeps non-ASCII text', async () => {
  await fresh();
  await add('Say "hi", then go');
  await add('Plain');
  await add('Café ☕ für 2');
  await add('a,b');
  assert.deepStrictEqual(await exportCsv(), [
    'column,text',
    'To do,"Say ""hi"", then go"',
    'To do,Plain',
    'To do,Café ☕ für 2',
    'To do,"a,b"',
  ]);
});

test('Export CSV on an empty board is just the header, and the board is untouched', async () => {
  await fresh();
  assert.deepStrictEqual(await exportCsv(), ['column,text']);
  await add('After export');
  assert.deepStrictEqual(await texts('todo'), ['After export']);
});

test('the new features cause no errors', async () => {
  errors.length = 0;
  await fresh();
  await add('One');
  await chooseTheme('Dark');
  await chooseTheme('System');
  await blur();
  await page.keyboard.press('?');
  await page.keyboard.press('Escape');
  await cards('todo').first().focus();
  await page.keyboard.press('ArrowRight');
  await exportCsv();
  await page.waitForTimeout(200);
  assert.deepStrictEqual(errors, []);
});
