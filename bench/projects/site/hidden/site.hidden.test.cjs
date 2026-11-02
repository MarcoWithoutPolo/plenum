// Hidden acceptance tests for the Northwind Roasters site. Never shown to any agent.
// They serve the result over HTTP and drive it in Electron's Chromium through Playwright.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createReadStream, existsSync, readFileSync, statSync } = require('node:fs');
const { extname, join, normalize } = require('node:path');

const root = process.env.BENCH_ROOT;
const { _electron: electron } = require(join(root, 'node_modules', '@playwright', 'test'));
const electronBin = require(join(root, 'node_modules', 'electron'));
const { default: AxeBuilder } = require(join(root, 'node_modules', '@axe-core', 'playwright'));

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
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
let base;
const errors = [];

test.before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/`;
  app = await electron.launch({
    executablePath: electronBin,
    args: [join(__dirname, 'electron-main.cjs')],
    env: { ...process.env, SITE_URL: `${base}index.html` },
  });
  page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
  await page.waitForLoadState('load');
});

test.after(async () => {
  await app?.close();
  server.close();
});

/* ---------- Helpers ---------- */

const products = () => JSON.parse(readFileSync(join(dir, 'data', 'products.json'), 'utf8'));
const money = (n) => `$${(Math.round(n * 100) / 100).toFixed(2)}`;
const PAGES = () => [
  'index.html',
  'shop.html',
  `product.html?id=${encodeURIComponent(products()[0].id)}`,
  'cart.html',
  'contact.html',
];

async function open(path) {
  await page.goto(base + path);
  await page.waitForLoadState('load');
  await page.waitForTimeout(150);
}

/** A first visit: no cart, no theme choice. */
async function fresh(path = 'index.html') {
  await open(path);
  await page.evaluate(() => localStorage.clear());
  await open(path);
}

/** Retry an assertion until it passes or time runs out (for pages that render after a fetch). */
async function eventually(check, ms = 4000) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      return await check();
    } catch (e) {
      if (Date.now() > end) throw e;
      await page.waitForTimeout(100);
    }
  }
}

async function headerCount() {
  const el = page.locator('header [data-cart-count], [data-cart-count]').first();
  return (await el.innerText()).trim();
}

async function listed() {
  return page.locator('[data-product]').evaluateAll((els) =>
    els.map((e) => ({
      id: e.dataset.id,
      roast: e.dataset.roast,
      price: Number(e.dataset.price),
    })),
  );
}

async function openShop() {
  await open('shop.html');
  await page.locator('[data-product]').first().waitFor({ timeout: 5000 });
}

async function choose(label, value) {
  await page.getByLabel(label, { exact: true }).selectOption(value);
}

const ids = (list) => list.map((p) => p.id);
const sameSet = (a, b) => assert.deepStrictEqual([...a].sort(), [...b].sort());

async function addFromProductPage(id, qty) {
  await open(`product.html?id=${encodeURIComponent(id)}`);
  const button = page.getByRole('button', { name: 'Add to cart' });
  await button.waitFor({ timeout: 5000 });
  if (qty !== undefined) await page.getByLabel('Quantity').fill(String(qty));
  await button.click();
  await page.waitForTimeout(100);
}

async function settle() {
  await page.evaluate(() =>
    Promise.race([
      Promise.all(
        document
          .getAnimations()
          .filter((a) => a.effect?.getTiming().iterations !== Infinity)
          .map((a) => a.finished.catch(() => undefined)),
      ),
      new Promise((r) => setTimeout(r, 2000)),
    ]),
  );
}

/** Relative luminance of the page's background (html or body, whichever paints). */
async function backgroundLuminance() {
  return page.evaluate(() => {
    const parse = (c) => {
      const m = c.match(/rgba?\(([^)]+)\)/);
      if (!m) return [0, 0, 0, 0];
      const p = m[1]
        .split(/[ ,/]+/)
        .filter(Boolean)
        .map(Number);
      return [p[0], p[1], p[2], p[3] === undefined ? 1 : p[3]];
    };
    const body = parse(getComputedStyle(document.body).backgroundColor);
    const html = parse(getComputedStyle(document.documentElement).backgroundColor);
    const c = body[3] > 0 ? body : html[3] > 0 ? html : [255, 255, 255, 1];
    const f = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  });
}

/**
 * Switch the system colour scheme. Media-query change events fire during a rendering update, and a
 * hidden window whose only animations run on the compositor may not have one for a while; a real,
 * visible browser would, so ask for two frames.
 */
async function systemScheme(colorScheme) {
  await page.emulateMedia({ colorScheme });
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
}

const theme = () => page.evaluate(() => document.documentElement.dataset.theme);
const toggle = () => page.getByRole('button', { name: 'Dark mode', exact: true });

/* ---------- Tests ---------- */

test('every page loads without console errors and has the cart count in its header', async () => {
  await fresh();
  for (const path of PAGES()) {
    errors.length = 0;
    await open(path);
    await page.waitForTimeout(400);
    assert.deepStrictEqual(errors, [], `errors on ${path}`);
    assert.strictEqual(
      await page.locator('header [data-cart-count]').count(),
      1,
      `${path} has [data-cart-count] in its header`,
    );
    assert.strictEqual(await headerCount(), '0', `${path} shows an empty cart`);
  }
});

test('the shop lists every product of data/products.json, linked, with its price', async () => {
  const data = products();
  assert.ok(data.length >= 8, `at least 8 products (found ${data.length})`);
  await openShop();
  const shown = await listed();
  assert.deepStrictEqual(ids(shown), ids(data), 'all products, in the order of the data file');
  for (const p of data) {
    const card = page.locator(`[data-product][data-id="${p.id}"]`);
    assert.strictEqual(Number(await card.getAttribute('data-price')), p.price, `${p.id} price`);
    assert.strictEqual(await card.getAttribute('data-roast'), p.roast, `${p.id} roast`);
    const text = await card.innerText();
    assert.ok(text.includes(p.name), `${p.id} shows its name`);
    assert.ok(text.includes(money(p.price)), `${p.id} shows ${money(p.price)}`);
    const hrefs = await card
      .locator('a[href]')
      .evaluateAll((as) => as.map((a) => new URL(a.href).searchParams.get('id')));
    const self = await card.evaluate((e) =>
      e.closest('a[href]') ? new URL(e.closest('a').href).searchParams.get('id') : null,
    );
    assert.ok(hrefs.includes(p.id) || self === p.id, `${p.id} links to product.html?id=${p.id}`);
  }
});

test('the roast filter lists exactly the matching products', async () => {
  const data = products();
  await openShop();
  for (const roast of ['light', 'medium', 'dark', 'all']) {
    await choose('Roast', roast);
    const want = data.filter((p) => roast === 'all' || p.roast === roast);
    await eventually(async () => sameSet(ids(await listed()), ids(want)));
  }
});

test('the price filter lists exactly the matching products, and combines with roast', async () => {
  const data = products();
  const bands = {
    any: () => true,
    'under-15': (p) => p < 15,
    '15-20': (p) => p >= 15 && p <= 20,
    'over-20': (p) => p > 20,
  };
  await openShop();
  for (const [band, ok] of Object.entries(bands)) {
    await choose('Price', band);
    const want = data.filter((p) => ok(p.price));
    await eventually(async () => sameSet(ids(await listed()), ids(want)));
  }
  let empty;
  for (const roast of ['light', 'medium', 'dark']) {
    for (const [band, ok] of Object.entries(bands)) {
      await choose('Roast', roast);
      await choose('Price', band);
      const want = data.filter((p) => p.roast === roast && ok(p.price));
      await eventually(async () => sameSet(ids(await listed()), ids(want)));
      if (!want.length && !empty) {
        empty = `${roast} / ${band}`;
        const text = await page.locator('main').innerText();
        assert.match(text, /\bno\b|nothing|\b0\b|none/i, `says nothing matches (${empty})`);
      }
    }
  }
});

test('sorting by price both ways, by name, and back to featured', async () => {
  const data = products();
  const byId = Object.fromEntries(data.map((p) => [p.id, p]));
  await openShop();
  await choose('Sort by', 'price-asc');
  await eventually(async () => {
    const prices = (await listed()).map((p) => p.price);
    assert.strictEqual(prices.length, data.length);
    assert.deepStrictEqual(
      prices,
      [...prices].sort((a, b) => a - b),
    );
    if (!isSorted(data)) assert.notDeepStrictEqual(ids(await listed()), ids(data));
  });
  await choose('Sort by', 'price-desc');
  await eventually(async () => {
    const prices = (await listed()).map((p) => p.price);
    assert.strictEqual(prices.length, data.length);
    assert.deepStrictEqual(
      prices,
      [...prices].sort((a, b) => b - a),
    );
  });
  await choose('Sort by', 'name');
  await eventually(async () => {
    const names = (await listed()).map((p) => byId[p.id].name);
    assert.strictEqual(names.length, data.length);
    assert.deepStrictEqual(
      names,
      [...names].sort((a, b) => a.localeCompare(b, 'en')),
    );
  });
  await choose('Roast', 'dark');
  await choose('Sort by', 'price-desc');
  await eventually(async () => {
    const shown = await listed();
    sameSet(ids(shown), ids(data.filter((p) => p.roast === 'dark')));
    const prices = shown.map((p) => p.price);
    assert.deepStrictEqual(
      prices,
      [...prices].sort((a, b) => b - a),
    );
  });
  await choose('Roast', 'all');
  await choose('Sort by', 'featured');
  await eventually(async () => assert.deepStrictEqual(ids(await listed()), ids(data)));
});

/** True when the data file happens to be in ascending price order already. */
function isSorted(data) {
  return data.every((p, i) => i === 0 || data[i - 1].price <= p.price);
}

test('a product page shows the right product; an unknown id says not found', async () => {
  const data = products();
  for (const p of [data[0], data[data.length - 1], data[Math.floor(data.length / 2)]]) {
    await open(`product.html?id=${encodeURIComponent(p.id)}`);
    await eventually(async () => {
      assert.ok(
        (await page.locator('h1').first().innerText()).includes(p.name),
        `h1 names ${p.id}`,
      );
    });
    assert.strictEqual(await page.locator('h1').count(), 1, 'one h1');
    assert.ok(
      (await page.locator('main').innerText()).includes(money(p.price)),
      `price of ${p.id}`,
    );
  }
  await open('product.html?id=no-such-coffee-123');
  await eventually(async () => {
    assert.match(await page.locator('h1').first().innerText(), /not found/i);
  });
});

test('adding to the cart updates the header count on every page', async () => {
  const [a, b] = products();
  await fresh();
  await addFromProductPage(a.id, 2);
  await eventually(async () => assert.strictEqual(await headerCount(), '2'));
  await addFromProductPage(b.id);
  await eventually(async () => assert.strictEqual(await headerCount(), '3'));
  await addFromProductPage(a.id, 1);
  await eventually(async () => assert.strictEqual(await headerCount(), '4'));
  for (const path of PAGES()) {
    await open(path);
    await eventually(async () => assert.strictEqual(await headerCount(), '4', path));
  }
});

test('the cart page changes quantities, removes products and keeps the subtotal right', async () => {
  const [a, b] = products();
  await fresh();
  await addFromProductPage(a.id, 2);
  await addFromProductPage(b.id);
  await open('cart.html');
  const item = (id) => page.locator(`[data-cart-item][data-id="${id}"]`);
  const subtotal = async () =>
    (await page.locator('[data-cart-subtotal]').first().innerText()).trim();
  await eventually(async () => {
    assert.strictEqual(await page.locator('[data-cart-item]').count(), 2);
    assert.strictEqual(await subtotal(), money(2 * a.price + b.price));
  });

  const qty = item(b.id).getByRole('spinbutton', { name: /^Quantity/ });
  await qty.fill('4');
  await qty.dispatchEvent('change');
  await eventually(async () => {
    assert.strictEqual(await headerCount(), '6');
    assert.strictEqual(await subtotal(), money(2 * a.price + 4 * b.price));
  });

  await item(a.id)
    .getByRole('button', { name: /^Remove/ })
    .click();
  await eventually(async () => {
    assert.strictEqual(await page.locator('[data-cart-item]').count(), 1);
    assert.strictEqual(await headerCount(), '4');
    assert.strictEqual(await subtotal(), money(4 * b.price));
  });

  await page.reload();
  await page.waitForLoadState('load');
  await eventually(async () => {
    assert.strictEqual(await page.locator('[data-cart-item]').count(), 1);
    assert.strictEqual(
      await item(b.id)
        .getByRole('spinbutton', { name: /^Quantity/ })
        .inputValue(),
      '4',
    );
  });

  await item(b.id)
    .getByRole('button', { name: /^Remove/ })
    .click();
  await eventually(async () => {
    assert.strictEqual(await page.locator('[data-cart-item]').count(), 0);
    assert.strictEqual(await headerCount(), '0');
    assert.match(await page.locator('main').innerText(), /empty/i);
  });
});

test('the cart survives reloads and is shared between pages', async () => {
  const data = products();
  const c = data[2];
  await fresh();
  await addFromProductPage(c.id, 3);
  await page.reload();
  await page.waitForLoadState('load');
  await eventually(async () => assert.strictEqual(await headerCount(), '3'));
  await open('cart.html');
  await eventually(async () => {
    assert.strictEqual(await page.locator(`[data-cart-item][data-id="${c.id}"]`).count(), 1);
    assert.strictEqual(
      (await page.locator('[data-cart-subtotal]').first().innerText()).trim(),
      money(3 * c.price),
    );
  });
  await open('index.html');
  await eventually(async () => assert.strictEqual(await headerCount(), '3'));
});

/** The visible error message linked to a field, and how far it sits from the field. */
async function fieldError(label) {
  const field = page.getByLabel(label, { exact: true });
  return field.evaluate((f) => {
    const box = f.getBoundingClientRect();
    const ids = (f.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
    const messages = ids
      .map((id) => document.getElementById(id))
      .filter((m) => m && m.getClientRects().length && m.innerText.trim())
      .map((m) => {
        const r = m.getBoundingClientRect();
        const gap = Math.max(0, r.top - box.bottom, box.top - r.bottom);
        return { text: m.innerText.trim(), gap };
      });
    return { invalid: f.getAttribute('aria-invalid') === 'true', messages };
  });
}

test('the contact form shows its own messages next to invalid fields', async () => {
  await fresh('contact.html');
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.waitForTimeout(200);
  for (const label of ['Name', 'Email', 'Message']) {
    const f = await fieldError(label);
    assert.ok(f.invalid, `${label} has aria-invalid="true"`);
    assert.ok(f.messages.length > 0, `${label} has a visible message linked by aria-describedby`);
    assert.ok(
      f.messages.some((m) => m.gap < 120),
      `${label}'s message is next to it: ${JSON.stringify(f.messages)}`,
    );
  }
  assert.ok(!(await page.locator('[data-form-success]').isVisible()), 'no success yet');

  await page.getByLabel('Name', { exact: true }).fill('Ana Lima');
  await page.getByLabel('Email', { exact: true }).fill('ana.example.com');
  await page.getByLabel('Message', { exact: true }).fill('Do you sell green beans?');
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.waitForTimeout(200);
  const email = await fieldError('Email');
  assert.ok(email.invalid, 'a malformed email is invalid');
  assert.ok(email.messages.length > 0, 'with a message');
  assert.ok(!(await fieldError('Name')).invalid, 'Name is fine now');
  assert.ok(!(await fieldError('Message')).invalid, 'Message is fine now');
  assert.ok(!(await page.locator('[data-form-success]').isVisible()), 'still no success');

  await page.getByLabel('Email', { exact: true }).fill('ana@example.com');
  await page.getByLabel('Message', { exact: true }).fill('Too short');
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.waitForTimeout(200);
  assert.ok((await fieldError('Message')).invalid, 'a 9-character message is too short');
  assert.ok(!(await fieldError('Email')).invalid, 'Email is fine now');
});

test('a valid contact form shows a thank-you and sends nothing over the network', async () => {
  await fresh('contact.html');
  await page.waitForTimeout(300);
  const requests = [];
  const onRequest = (r) => requests.push(`${r.method()} ${r.url()}`);
  page.on('request', onRequest);
  try {
    await page.getByLabel('Name', { exact: true }).fill('Ana Lima');
    await page.getByLabel('Email', { exact: true }).fill('ana@example.com');
    await page
      .getByLabel('Message', { exact: true })
      .fill('Do you sell green beans for home roasting?');
    await page.getByRole('button', { name: 'Send message' }).click();
    const success = page.locator('[data-form-success]');
    await eventually(async () => {
      assert.ok(await success.isVisible(), 'the thank-you is visible');
      assert.ok((await success.innerText()).trim().length > 0, 'and says something');
    });
    await page.waitForTimeout(300);
    assert.match(page.url(), /contact\.html/, 'still on the contact page');
  } finally {
    page.off('request', onRequest);
  }
  assert.deepStrictEqual(requests, []);
});

test('dark mode follows the system setting, even while the page is open', async () => {
  await page.emulateMedia({ colorScheme: 'light' });
  await fresh();
  await settle();
  assert.strictEqual(await theme(), 'light');
  assert.strictEqual(await toggle().getAttribute('aria-pressed'), 'false');
  const light = await backgroundLuminance();
  await systemScheme('dark');
  await page.waitForTimeout(200);
  await settle();
  try {
    assert.strictEqual(await theme(), 'dark');
    assert.strictEqual(await toggle().getAttribute('aria-pressed'), 'true');
    const dark = await backgroundLuminance();
    assert.ok(light > 0.6, `light background luminance ${light.toFixed(2)}`);
    assert.ok(dark < 0.2, `dark background luminance ${dark.toFixed(2)}`);
  } finally {
    await page.emulateMedia({ colorScheme: 'light' });
  }
});

test('the Dark mode toggle overrides the system and persists across pages and reloads', async () => {
  await page.emulateMedia({ colorScheme: 'light' });
  await fresh();
  try {
    await toggle().click();
    await settle();
    assert.strictEqual(await theme(), 'dark');
    assert.strictEqual(await toggle().getAttribute('aria-pressed'), 'true');
    assert.ok((await backgroundLuminance()) < 0.2, 'dark background');
    await page.reload();
    await page.waitForLoadState('load');
    await settle();
    assert.strictEqual(await theme(), 'dark', 'still dark after a reload');
    assert.ok((await backgroundLuminance()) < 0.2, 'dark background after a reload');
    await open('shop.html');
    await settle();
    assert.strictEqual(await theme(), 'dark', 'dark on the shop page too');
    assert.ok((await backgroundLuminance()) < 0.2, 'dark background on the shop page');

    await systemScheme('dark');
    await toggle().click();
    await settle();
    assert.strictEqual(await theme(), 'light', 'light chosen while the system is dark');
    await open('contact.html');
    await settle();
    assert.strictEqual(await theme(), 'light', 'the choice beats the system on another page');
    assert.ok((await backgroundLuminance()) > 0.6, 'light background');
  } finally {
    await page.evaluate(() => localStorage.clear());
    await page.emulateMedia({ colorScheme: 'light' });
  }
});

test('no sideways scrolling at 375, 768 and 1440 px on any page', async () => {
  const [a] = products();
  await fresh();
  await addFromProductPage(a.id, 2);
  const bad = [];
  try {
    for (const width of [375, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const path of PAGES()) {
        await open(path);
        await page.waitForTimeout(250);
        assert.strictEqual(await page.locator('header [data-cart-count]').count(), 1, path);
        const over = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        if (over > 1) bad.push(`${path} @ ${width}px: ${over}px`);
      }
    }
  } finally {
    await page.setViewportSize({ width: 1280, height: 800 });
  }
  assert.deepStrictEqual(bad, []);
});

test('the hero animates, but nothing runs when reduced motion is requested', async () => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await fresh();
  await page.waitForTimeout(1500);
  const hero = await page.evaluate(() => {
    const h = document.querySelector('[data-hero]');
    if (!h) return null;
    return {
      heading: !!h.querySelector('h1'),
      running: h.getAnimations({ subtree: true }).filter((a) => a.playState === 'running').length,
    };
  });
  assert.ok(hero, 'the home page has [data-hero]');
  assert.ok(hero.heading, 'the hero holds the h1');
  assert.ok(hero.running > 0, 'the hero has a running animation while motion is allowed');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  const running = [];
  try {
    for (const path of PAGES()) {
      await open(path);
      await page.waitForTimeout(1200);
      const n = await page.evaluate(
        () => document.getAnimations().filter((a) => a.playState === 'running').length,
      );
      if (n) running.push(`${path}: ${n} running`);
    }
  } finally {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
  }
  assert.deepStrictEqual(running, []);
});

test('axe finds no serious or critical problems on any page, light or dark', async () => {
  const [a, b] = products();
  await fresh();
  await addFromProductPage(a.id, 1);
  await addFromProductPage(b.id, 2);
  const found = [];
  try {
    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme });
      for (const path of PAGES()) {
        await open(path);
        await page.waitForTimeout(300);
        await settle();
        assert.strictEqual(await page.locator('header [data-cart-count]').count(), 1, path);
        const result = await new AxeBuilder({ page }).setLegacyMode(true).analyze();
        for (const v of result.violations)
          if (v.impact === 'serious' || v.impact === 'critical')
            found.push(
              `${colorScheme} ${path}: ${v.id} (${v.impact}) ${v.nodes
                .slice(0, 3)
                .map((n) => n.target.join(' '))
                .join(' | ')}`,
            );
      }
    }
  } finally {
    await page.emulateMedia({ colorScheme: 'light' });
  }
  assert.deepStrictEqual(found, []);
});

test('every image has alt text, and product images name their coffee', async () => {
  const data = products();
  await fresh();
  await addFromProductPage(data[0].id);
  const missing = [];
  for (const path of PAGES()) {
    await open(path);
    await page.waitForTimeout(300);
    const bad = await page
      .locator('img')
      .evaluateAll((imgs) => imgs.filter((i) => !i.hasAttribute('alt')).map((i) => i.src));
    for (const src of bad) missing.push(`${path}: ${src}`);
  }
  assert.deepStrictEqual(missing, [], 'images without alt');

  await openShop();
  const cards = await page.locator('[data-product]').evaluateAll((els) =>
    els.map((e) => ({
      id: e.dataset.id,
      alts: [...e.querySelectorAll('img')].map((i) => i.alt),
    })),
  );
  const byId = Object.fromEntries(data.map((p) => [p.id, p.name]));
  const withImages = cards.filter((c) => c.alts.length);
  assert.ok(withImages.length >= 8, `product cards have images (${withImages.length})`);
  for (const c of withImages)
    assert.ok(
      c.alts.some((alt) => alt.toLowerCase().includes(byId[c.id].toLowerCase())),
      `${c.id}'s image alt names "${byId[c.id]}": ${JSON.stringify(c.alts)}`,
    );

  const p = data[1];
  await open(`product.html?id=${encodeURIComponent(p.id)}`);
  await eventually(async () => {
    const alts = await page.locator('main img').evaluateAll((imgs) => imgs.map((i) => i.alt));
    assert.ok(
      alts.some((alt) => alt.toLowerCase().includes(p.name.toLowerCase())),
      `the product page has an image of ${p.name}: ${JSON.stringify(alts)}`,
    );
  });
});
