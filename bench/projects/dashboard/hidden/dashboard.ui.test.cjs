// Hidden acceptance tests for dashboard: the page in a browser. Never shown to any agent.
// They serve the result over HTTP and drive it in Electron's Chromium through Playwright.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const {
  createReadStream,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { extname, join, normalize } = require('node:path');
const { canonical, filter, readCsv, totals } = require('./dashboard-helpers.cjs');

const root = process.env.BENCH_ROOT;
const { _electron: electron } = require(join(root, 'node_modules', '@playwright', 'test'));
const electronBin = require(join(root, 'node_modules', 'electron'));

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.csv': 'text/csv',
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

const ROWS = canonical();
const downloads = mkdtempSync(join(tmpdir(), 'dashboard-downloads-'));
let app;
let page;
const errors = [];

test.before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  app = await electron.launch({
    executablePath: electronBin,
    args: [join(__dirname, 'electron-main.cjs')],
    env: { ...process.env, DASHBOARD_URL: url, DOWNLOAD_DIR: downloads },
  });
  page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/favicon/i.test(m.location()?.url ?? '')) errors.push(m.text());
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForLoadState('load');
});

test.after(async () => {
  await app?.close();
  server.close();
  rmSync(downloads, { recursive: true, force: true });
});

// A wrapping label's accessible name can include the select's current option ("Region All regions").
const LABEL = {
  Region: /^\s*Region\b/i,
  Category: /^\s*Category\b/i,
  From: /^\s*From\b/i,
  To: /^\s*To\b/i,
};
const num = (s) => Number(String(s).replace(/[^0-9.-]/g, ''));
async function shown() {
  const read = async (attr) => num(await page.locator(`[${attr}]`).first().innerText());
  return {
    revenue: await read('data-total-revenue'),
    units: await read('data-total-units'),
    orders: await read('data-total-orders'),
  };
}

/** Reload with no filters and wait until the totals show every order. */
async function fresh() {
  await page.reload();
  await page.waitForLoadState('load');
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-total-orders]');
      return el && Number(el.textContent.replace(/[^0-9.-]/g, '')) === 500;
    },
    null,
    { timeout: 10_000 },
  );
}

async function setFilters(f) {
  if (f.region !== undefined) await page.getByLabel(LABEL.Region).selectOption(f.region);
  if (f.category !== undefined) await page.getByLabel(LABEL.Category).selectOption(f.category);
  if (f.from !== undefined) await page.getByLabel(LABEL.From).fill(f.from);
  if (f.to !== undefined) await page.getByLabel(LABEL.To).fill(f.to);
  await page.waitForTimeout(150);
}

async function expectTotals(f) {
  const want = totals(filter(ROWS, f));
  const got = await shown();
  assert.strictEqual(got.orders, want.orders, `orders for ${JSON.stringify(f)}`);
  assert.strictEqual(got.units, want.units, `units for ${JSON.stringify(f)}`);
  assert.ok(
    Math.abs(got.revenue - want.revenue) < 0.006,
    `revenue for ${JSON.stringify(f)}: shown ${got.revenue}, expected ${want.revenue}`,
  );
}

test('loads without errors and shows the totals for every order', async () => {
  errors.length = 0;
  await fresh();
  await expectTotals({});
  await setFilters({ region: 'North', category: 'Furniture' });
  await page.waitForTimeout(200);
  assert.deepStrictEqual(errors, []);
});

test('filters have labels and list every region and category', async () => {
  await fresh();
  const options = (label) =>
    page
      .getByLabel(LABEL[label])
      .locator('option')
      .evaluateAll((os) => os.map((o) => ({ value: o.value, text: o.textContent.trim() })));
  const regions = await options('Region');
  assert.deepStrictEqual(regions[0], { value: '', text: 'All regions' });
  assert.deepStrictEqual(
    regions
      .slice(1)
      .map((o) => o.value)
      .sort(),
    [...new Set(ROWS.map((r) => r.region))].sort(),
  );
  const cats = await options('Category');
  assert.deepStrictEqual(cats[0], { value: '', text: 'All categories' });
  assert.deepStrictEqual(
    cats
      .slice(1)
      .map((o) => o.value)
      .sort(),
    [...new Set(ROWS.map((r) => r.category))].sort(),
  );
  for (const label of ['From', 'To'])
    assert.strictEqual(await page.getByLabel(LABEL[label]).getAttribute('type'), 'date');
});

test('totals follow the region and category filters', async () => {
  await fresh();
  for (const f of [
    { region: 'North', category: '' },
    { region: '', category: 'Furniture' },
    { region: 'West', category: 'Electronics' },
    { region: '', category: '' },
  ]) {
    await setFilters(f);
    await expectTotals(f);
  }
});

test('totals follow the date range, and show zero when nothing matches', async () => {
  await fresh();
  const f = { region: 'East', category: '', from: '2025-04-01', to: '2025-06-30' };
  await setFilters(f);
  await expectTotals(f);
  // A day with no orders at all.
  const days = new Set(ROWS.map((r) => r.date));
  const d = new Date('2025-01-01T00:00:00Z');
  while (days.has(d.toISOString().slice(0, 10))) d.setUTCDate(d.getUTCDate() + 1);
  const empty = d.toISOString().slice(0, 10);
  const none = { region: '', category: '', from: empty, to: empty };
  await setFilters(none);
  assert.deepStrictEqual(await shown(), { revenue: 0, units: 0, orders: 0 });
  // Clearing the dates brings everything back.
  await setFilters({ from: '', to: '' });
  await expectTotals({});
});

async function chartBoxes() {
  return page.evaluate(() => {
    const box = (kind) => {
      const host = document.querySelector(`[data-chart="${kind}"]`);
      if (!host) return null;
      const el = host.matches('svg, canvas') ? host : host.querySelector('svg, canvas');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, width: r.width, height: r.height };
    };
    return {
      month: box('month'),
      category: box('category'),
      inner: window.innerWidth,
      scroll: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
}

test('charts render at 375, 768 and 1440 px wide, with no sideways scrolling', async () => {
  try {
    for (const [width, height] of [
      [375, 812],
      [768, 1024],
      [1440, 900],
    ]) {
      await page.setViewportSize({ width, height });
      await fresh();
      await page.waitForTimeout(200);
      const b = await chartBoxes();
      assert.ok(b.scroll <= 1, `${width}px: page scrolls sideways by ${b.scroll}px`);
      for (const kind of ['month', 'category']) {
        const c = b[kind];
        assert.ok(c, `${width}px: [data-chart="${kind}"] has an svg or canvas`);
        assert.ok(
          c.width > 20 && c.height > 20,
          `${width}px: ${kind} chart size ${c.width}x${c.height}`,
        );
        assert.ok(
          c.left >= -1 && c.right <= b.inner + 1,
          `${width}px: ${kind} chart fits the screen`,
        );
      }
    }
  } finally {
    await page.setViewportSize({ width: 1440, height: 900 });
  }
});

test('charts follow the filters', async () => {
  await fresh();
  const snapshot = () =>
    page.evaluate(() =>
      ['month', 'category'].map((k) => {
        const host = document.querySelector(`[data-chart="${k}"]`);
        const el = host?.matches('canvas') ? host : host?.querySelector('canvas');
        return el ? el.toDataURL() : host?.innerHTML;
      }),
    );
  const before = await snapshot();
  await setFilters({ region: 'South', category: 'Apparel', from: '2025-02-01', to: '2025-05-31' });
  await page.waitForTimeout(200);
  const after = await snapshot();
  assert.notStrictEqual(after[0], before[0], 'the month chart changed');
  assert.notStrictEqual(after[1], before[1], 'the category chart changed');
});

async function exportRows() {
  for (const f of readdirSync(downloads)) rmSync(join(downloads, f), { force: true });
  await page.getByRole('button', { name: 'Export CSV' }).click();
  const deadline = Date.now() + 10_000;
  for (;;) {
    const done = readdirSync(downloads).filter((f) => !/\.(crdownload|tmp)$/i.test(f));
    if (done.length) {
      await new Promise((r) => setTimeout(r, 300));
      const file = join(downloads, done[0]);
      return { name: done[0], text: readFileSync(file, 'utf8') };
    }
    assert.ok(Date.now() < deadline, 'Export CSV downloaded a file within 10 s');
    await new Promise((r) => setTimeout(r, 100));
  }
}

test('Export CSV downloads the filtered rows', async () => {
  await fresh();
  const f = { region: 'South', category: 'Office Supplies', from: '2025-03-01', to: '2025-10-31' };
  await setFilters(f);
  const { name, text } = await exportRows();
  assert.match(name, /\.csv$/i, 'a .csv file');
  assert.strictEqual(
    text.replace(/^﻿/, '').split(/\r?\n/)[0],
    'date,region,category,product,units,revenue',
  );
  const want = filter(ROWS, f);
  assert.ok(want.length > 0);
  assert.deepStrictEqual(readCsv(text.replace(/^﻿/, '')), want);
});

test('Export CSV with every row unfiltered, quotes intact', async () => {
  await fresh();
  const { text } = await exportRows();
  const rows = readCsv(text.replace(/^﻿/, ''));
  assert.strictEqual(rows.length, 500);
  assert.deepStrictEqual(rows, ROWS);
});
