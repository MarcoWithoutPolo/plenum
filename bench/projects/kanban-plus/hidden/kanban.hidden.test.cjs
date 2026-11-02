// Hidden acceptance tests for kanban. Never shown to any agent.
// They serve the result over HTTP and drive it in Electron's Chromium through Playwright.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createReadStream, existsSync, statSync } = require('node:fs');
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
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForLoadState('load');
}
const col = (name) => page.locator(`[data-column="${name}"]`);
const cards = (name) => col(name).locator('[data-card]');
async function add(text) {
  await page.getByRole('textbox', { name: 'New card' }).fill(text);
  await page.getByRole('button', { name: 'Add card' }).click();
}
const texts = async (name) =>
  (await cards(name).allInnerTexts()).map((t) => t.split('\n')[0].trim());
const count = async (name) => (await col(name).locator('[data-count]').innerText()).trim();

test('loads without errors', async () => {
  errors.length = 0;
  await fresh();
  await add('Write the spec');
  await cards('todo').first().getByRole('button', { name: 'Move right' }).click();
  await page.waitForTimeout(200);
  assert.deepStrictEqual(errors, []);
});

test('three columns in order, each with its name and a count', async () => {
  await fresh();
  const order = await page
    .locator('[data-column]')
    .evaluateAll((els) => els.map((e) => e.dataset.column));
  assert.deepStrictEqual(order, ['todo', 'doing', 'done']);
  for (const [name, label] of [
    ['todo', /to do/i],
    ['doing', /doing/i],
    ['done', /done/i],
  ]) {
    assert.match(await col(name).getByRole('heading').first().innerText(), label);
    assert.strictEqual(await count(name), '0');
  }
});

test('adds cards with the button and with Enter, trimmed, ignoring empty text', async () => {
  await fresh();
  await add('  First  ');
  await page.getByRole('textbox', { name: 'New card' }).fill('Second');
  await page.getByRole('textbox', { name: 'New card' }).press('Enter');
  await add('   ');
  await add('');
  assert.deepStrictEqual(await texts('todo'), ['First', 'Second']);
  assert.strictEqual(await page.getByRole('textbox', { name: 'New card' }).inputValue(), '');
});

test('moves cards to the end of the next column, never past the ends', async () => {
  await fresh();
  await add('A');
  await add('B');
  const moveRight = (name, i) => cards(name).nth(i).getByRole('button', { name: 'Move right' });
  await moveRight('todo', 0).click();
  await moveRight('todo', 0).click();
  assert.deepStrictEqual(await texts('doing'), ['A', 'B']);
  await moveRight('doing', 1).click();
  assert.deepStrictEqual(await texts('done'), ['B']);
  const stuck = cards('done').first().getByRole('button', { name: 'Move right' });
  assert.ok(
    (await stuck.count()) === 0 || (await stuck.isDisabled()),
    'Move right in Done is disabled or absent',
  );
  await cards('done').first().getByRole('button', { name: 'Move left' }).click();
  assert.deepStrictEqual(await texts('doing'), ['A', 'B']);
  await cards('doing').first().getByRole('button', { name: 'Move left' }).click();
  const left = cards('todo').first().getByRole('button', { name: 'Move left' });
  assert.ok(
    (await left.count()) === 0 || (await left.isDisabled()),
    'Move left in To do is disabled or absent',
  );
  assert.deepStrictEqual(await texts('todo'), ['A']);
});

test('deletes cards', async () => {
  await fresh();
  await add('Keep');
  await add('Drop');
  await cards('todo').nth(1).getByRole('button', { name: 'Delete' }).click();
  assert.deepStrictEqual(await texts('todo'), ['Keep']);
});

test('keeps the board after a reload', async () => {
  await fresh();
  await add('Saved');
  await add('Moved');
  await cards('todo').nth(1).getByRole('button', { name: 'Move right' }).click();
  await page.reload();
  await page.waitForLoadState('load');
  assert.deepStrictEqual(await texts('todo'), ['Saved']);
  assert.deepStrictEqual(await texts('doing'), ['Moved']);
});

test('counts follow the cards', async () => {
  await fresh();
  await add('1');
  await add('2');
  await add('3');
  await cards('todo').first().getByRole('button', { name: 'Move right' }).click();
  await cards('todo').first().getByRole('button', { name: 'Delete' }).click();
  assert.deepStrictEqual(
    [await count('todo'), await count('doing'), await count('done')],
    ['1', '1', '0'],
  );
});

/** Effective background behind an element (composited up its ancestors), and the page's own. */
const PAGE_HELPERS = `
  const parse = (c) => { const m = c.match(/rgba?\\(([^)]+)\\)/); if (!m) return [0,0,0,0]; const p = m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number); return [p[0],p[1],p[2],p[3] === undefined ? 1 : p[3]]; };
  const over = (top, under) => { const a = top[3]; return [0,1,2].map((i) => top[i]*a + under[i]*(1-a)).concat(1); };
  const canvas = () => matchMedia('(prefers-color-scheme: dark)').matches && /dark/.test(getComputedStyle(document.documentElement).colorScheme) ? [18,18,18,1] : [255,255,255,1];
  const bgOf = (el) => { const chain = []; for (let e = el; e; e = e.parentElement) chain.push(parse(getComputedStyle(e).backgroundColor)); let c = canvas(); for (const b of chain.reverse()) if (b[3] > 0) c = over(b, c); return c; };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); }; return 0.2126*f(c[0]) + 0.7152*f(c[1]) + 0.0722*f(c[2]); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x,y)+0.05)/(Math.min(x,y)+0.05); };
`;

async function lowContrast() {
  return page.evaluate((helpers) => {
    // eslint-disable-next-line no-new-func
    const h = new Function(`${helpers}; return { parse, over, bgOf, ratio };`)();
    const bad = [];
    const els = [...document.querySelectorAll('body *')].filter((e) => {
      if (e.closest('[hidden],[aria-hidden="true"]') || e.disabled) return false;
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

async function pageBackground() {
  return page.evaluate((helpers) => {
    // eslint-disable-next-line no-new-func
    const h = new Function(`${helpers}; return { bgOf, lum };`)();
    return h.lum(h.bgOf(document.body));
  }, PAGE_HELPERS);
}

/**
 * Switch the colour scheme and let the page settle: a page with colour transitions (a 120 ms
 * fade on its buttons) is mid-fade right after the switch, which is no reader's experience.
 */
async function scheme(colorScheme) {
  await page.emulateMedia({ colorScheme });
  await page.evaluate(() =>
    Promise.race([
      Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))),
      new Promise((r) => setTimeout(r, 2000)),
    ]),
  );
}

async function sampleBoard() {
  await fresh();
  await add('Plan the release');
  await add('Write the notes');
  await cards('todo').first().getByRole('button', { name: 'Move right' }).click();
}

test('dark mode follows the system setting', async () => {
  await sampleBoard();
  await scheme('light');
  const light = await pageBackground();
  await scheme('dark');
  const dark = await pageBackground();
  await scheme('light');
  assert.ok(light > 0.6, `light background luminance ${light.toFixed(2)}`);
  assert.ok(dark < 0.2, `dark background luminance ${dark.toFixed(2)}`);
});

test('text is readable in light and dark (contrast at least 4.5:1)', async () => {
  await sampleBoard();
  await scheme('light');
  const light = await lowContrast();
  await scheme('dark');
  const dark = await lowContrast();
  await scheme('light');
  assert.deepStrictEqual({ light, dark }, { light: [], dark: [] });
});

const rects = () =>
  page.locator('[data-column]').evaluateAll((els) =>
    els.map((e) => {
      const r = e.getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top) };
    }),
  );

test('phones: columns stacked, no sideways scrolling', async () => {
  await sampleBoard();
  await page.setViewportSize({ width: 390, height: 844 });
  try {
    const r = await rects();
    assert.ok(r[0].y < r[1].y && r[1].y < r[2].y, `columns stacked: ${JSON.stringify(r)}`);
    const scroll = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    assert.ok(scroll <= 1, `page scrolls sideways by ${scroll}px`);
  } finally {
    await page.setViewportSize({ width: 1280, height: 800 });
  }
});

test('desktop: columns side by side', async () => {
  await sampleBoard();
  const r = await rects();
  assert.ok(r[0].x < r[1].x && r[1].x < r[2].x, `side by side: ${JSON.stringify(r)}`);
  assert.ok(Math.abs(r[0].y - r[2].y) <= 4, 'columns start at the same height');
});

test('phones: every button at least 44 × 44 px', async () => {
  await sampleBoard();
  await page.setViewportSize({ width: 390, height: 844 });
  try {
    const small = await page.locator('button').evaluateAll((els) =>
      els
        .filter((e) => e.getBoundingClientRect().width > 0)
        .map((e) => {
          const r = e.getBoundingClientRect();
          return {
            name: e.getAttribute('aria-label') || e.textContent.trim(),
            w: r.width,
            h: r.height,
          };
        })
        .filter((b) => b.w < 43.5 || b.h < 43.5),
    );
    assert.deepStrictEqual(small, []);
  } finally {
    await page.setViewportSize({ width: 1280, height: 800 });
  }
});
