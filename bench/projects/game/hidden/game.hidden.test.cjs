// Hidden acceptance tests for the browser game. Never shown to any agent.
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
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.woff2': 'font/woff2',
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
const STATES = ['ready', 'playing', 'paused', 'over'];

test.before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  app = await electron.launch({
    executablePath: electronBin,
    args: [join(__dirname, 'electron-main.cjs')],
    env: { ...process.env, GAME_URL: url },
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

/* ---------- Helpers ---------- */

async function fresh() {
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForLoadState('load');
  await page.waitForTimeout(300);
}

const state = () => page.evaluate(() => document.body.dataset.state);
const number = async (selector) => {
  const text = (await page.locator(selector).first().innerText()).trim();
  const n = Number(text.replace(/[^\d.-]/g, ''));
  assert.ok(text !== '' && Number.isFinite(n), `${selector} shows a number ("${text}")`);
  return n;
};
const score = () => number('[data-score]');
const best = () => number('[data-best]');
const playerX = async () => {
  const v = await page.locator('canvas[data-player-x]').first().getAttribute('data-player-x');
  const n = Number(v);
  assert.ok(v !== null && Number.isFinite(n), `canvas has a numeric data-player-x ("${v}")`);
  return n;
};

async function waitForState(want, ms = 3000) {
  await page.waitForFunction((s) => document.body.dataset.state === s, want, { timeout: ms });
}

async function startWithSpace() {
  await page.keyboard.press('Space');
  await waitForState('playing');
}

/** Hold a key or an on-screen button for a while. */
async function holdKey(key, ms) {
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
}

async function holdButton(name, ms) {
  const box = await page.getByRole('button', { name, exact: true }).boundingBox();
  assert.ok(box, `the ${name} button is on the page`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(ms);
  await page.mouse.up();
}

/* ---------- Tests ---------- */

test('loads in the ready state, with its controls, without errors', async () => {
  errors.length = 0;
  await fresh();
  await page.waitForTimeout(1000);
  assert.strictEqual(await state(), 'ready');
  assert.strictEqual((await page.locator('canvas').count()) > 0, true, 'has a canvas');
  assert.strictEqual(await score(), 0);
  assert.strictEqual(await best(), 0);
  for (const name of ['Start', 'Pause', 'Left', 'Right'])
    assert.strictEqual(
      await page.getByRole('button', { name, exact: true }).count(),
      1,
      `one button named "${name}"`,
    );
  assert.deepStrictEqual(errors, []);
});

test('Space starts the game from ready', async () => {
  await fresh();
  assert.strictEqual(await state(), 'ready');
  await startWithSpace();
});

test('the Start button starts the game from ready', async () => {
  await fresh();
  assert.strictEqual(await state(), 'ready');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await waitForState('playing');
});

test('the score rises while playing, even if the player does nothing', async () => {
  await fresh();
  await startWithSpace();
  const before = await score();
  await page.waitForTimeout(3000);
  assert.strictEqual(await state(), 'playing', 'still playing after 3 s of doing nothing');
  const after = await score();
  assert.ok(after > before, `score went from ${before} to ${after}`);
});

test('P and the Pause button pause and resume; the score holds still while paused', async () => {
  await fresh();
  await startWithSpace();
  await page.waitForTimeout(800);

  await page.keyboard.press('p');
  await waitForState('paused');
  const held = await score();
  const x = await playerX();
  await page.keyboard.down('ArrowLeft');
  await page.waitForTimeout(1500);
  await page.keyboard.up('ArrowLeft');
  assert.strictEqual(await score(), held, 'score frozen while paused');
  assert.strictEqual(await playerX(), x, 'the player stays put while paused');
  await page.keyboard.press('p');
  await waitForState('playing');
  await page.waitForTimeout(1200);
  const resumed = await score();
  assert.ok(resumed > held, `score continues after resuming (${held} -> ${resumed})`);

  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await waitForState('paused');
  const held2 = await score();
  await page.waitForTimeout(1200);
  assert.strictEqual(await score(), held2, 'frozen again after the Pause button');
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await waitForState('playing');
  await page.waitForTimeout(1000);
  assert.ok((await score()) > held2, 'the Pause button resumes too');
});

test('the arrow keys move the player left and right', async () => {
  await fresh();
  await startWithSpace();
  await page.waitForTimeout(200);
  const x0 = await playerX();
  await holdKey('ArrowLeft', 350);
  const x1 = await playerX();
  assert.ok(x1 < x0, `ArrowLeft moves left (${x0} -> ${x1})`);
  await holdKey('ArrowRight', 700);
  const x2 = await playerX();
  assert.ok(x2 > x1, `ArrowRight moves right (${x1} -> ${x2})`);
});

test('phones: on-screen Left and Right buttons, big enough to tap, move the player', async () => {
  await page.setViewportSize({ width: 375, height: 812 });
  try {
    await fresh();
    for (const name of ['Left', 'Right', 'Start']) {
      const b = page.getByRole('button', { name, exact: true });
      assert.ok(await b.isVisible(), `${name} is visible`);
      const box = await b.boundingBox();
      assert.ok(box.width >= 44 && box.height >= 44, `${name} is at least 44 × 44 px`);
      assert.ok(
        box.x >= 0 && box.x + box.width <= 375 && box.y >= 0 && box.y + box.height <= 812,
        `${name} is on screen: ${JSON.stringify(box)}`,
      );
    }
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await waitForState('playing');
    await page.waitForTimeout(200);
    const x0 = await playerX();
    await holdButton('Left', 400);
    const x1 = await playerX();
    assert.ok(x1 < x0, `holding Left moves left (${x0} -> ${x1})`);
    await holdButton('Right', 800);
    const x2 = await playerX();
    assert.ok(x2 > x1, `holding Right moves right (${x1} -> ${x2})`);
    assert.strictEqual(await state(), 'playing');
  } finally {
    await page.setViewportSize({ width: 1280, height: 800 });
  }
});

test('left alone, the game ends within 60 s; the best score survives a reload', async () => {
  await fresh();
  await startWithSpace();
  await page.waitForFunction(() => document.body.dataset.state === 'over', null, {
    timeout: 65_000,
    polling: 250,
  });
  const final = await score();
  assert.ok(final > 0, `scored something (${final})`);
  assert.strictEqual(await best(), final, 'the first game sets the best score');
  await page.waitForTimeout(1000);
  assert.strictEqual(await score(), final, 'the score stays still once the game is over');

  await page.reload();
  await page.waitForLoadState('load');
  await page.waitForTimeout(300);
  assert.strictEqual(await state(), 'ready');
  assert.strictEqual(await best(), final, 'best score kept after a reload');

  await startWithSpace();
  await page.waitForTimeout(500);
  assert.ok((await score()) < final, 'a new game starts from a fresh score');
  assert.strictEqual(await best(), final, 'the best score stays while the new game is young');
});

test('20 seconds of scripted play: no errors, always a known state', async () => {
  await fresh();
  errors.length = 0;
  await page.keyboard.press('Space');
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const seen = new Set();
  const end = Date.now() + 20_000;
  while (Date.now() < end) {
    const s = await state();
    assert.ok(STATES.includes(s), `unknown state "${s}"`);
    seen.add(s);
    if (s === 'over' || s === 'ready') {
      await page.keyboard.press('Space');
      continue;
    }
    const r = rand();
    if (r < 0.3) await holdKey(rand() < 0.5 ? 'ArrowLeft' : 'ArrowRight', 100 + rand() * 300);
    else if (r < 0.55) await holdButton(rand() < 0.5 ? 'Left' : 'Right', 100 + rand() * 300);
    else if (r < 0.65) {
      await page.keyboard.press('p');
      await page.waitForTimeout(150);
      await page.keyboard.press('p');
    } else if (r < 0.72) {
      // force: the game may have just ended, and a disabled Pause button is fine then.
      const pause = page.getByRole('button', { name: 'Pause', exact: true });
      await pause.click({ force: true });
      await page.waitForTimeout(150);
      if ((await state()) === 'paused') await pause.click({ force: true });
    } else await page.waitForTimeout(150 + rand() * 250);
    await score();
  }
  assert.ok(seen.has('playing'), 'the game was played');
  assert.deepStrictEqual(errors, []);
});

async function layout(width, height) {
  await page.setViewportSize({ width, height });
  await fresh();
  await page.waitForTimeout(300);
  return page.evaluate(() => {
    const c = document.querySelector('canvas');
    const r = c ? c.getBoundingClientRect() : null;
    const box = (el) => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { top: b.top, bottom: b.bottom, left: b.left, right: b.right };
    };
    return {
      canvas: r && { width: r.width, height: r.height, ...box(c) },
      score: box(document.querySelector('[data-score]')),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      vw: innerWidth,
      vh: innerHeight,
    };
  });
}

const onScreen = (b, l) =>
  b && b.left >= -1 && b.right <= l.vw + 1 && b.top >= -1 && b.bottom <= l.vh + 1;

test('the canvas fills a sensible area at 375 and 1280 px, without sideways scrolling', async () => {
  try {
    const phone = await layout(375, 812);
    assert.ok(phone.canvas, 'there is a canvas');
    assert.ok(phone.overflow <= 1, `no sideways scrolling on a phone (${phone.overflow}px)`);
    assert.ok(
      phone.canvas.width >= 300 && phone.canvas.height >= 300,
      `phone canvas at least 300 × 300: ${JSON.stringify(phone.canvas)}`,
    );
    assert.ok(onScreen(phone.canvas, phone), 'the whole canvas is on a phone screen');
    assert.ok(onScreen(phone.score, phone), 'the score is on a phone screen');
    for (const name of ['Left', 'Right']) {
      const b = await page.getByRole('button', { name, exact: true }).boundingBox();
      assert.ok(
        b && onScreen({ left: b.x, right: b.x + b.width, top: b.y, bottom: b.y + b.height }, phone),
        `${name} is on a phone screen with the canvas`,
      );
    }

    const desk = await layout(1280, 800);
    assert.ok(desk.overflow <= 1, `no sideways scrolling on a desktop (${desk.overflow}px)`);
    assert.ok(
      Math.min(desk.canvas.width, desk.canvas.height) >= 400,
      `desktop canvas at least 400 px on its shorter side: ${JSON.stringify(desk.canvas)}`,
    );
    assert.ok(onScreen(desk.canvas, desk), 'the whole canvas is on a desktop screen');
  } finally {
    await page.setViewportSize({ width: 1280, height: 800 });
  }
});
