// Hidden acceptance tests for recipes: the web page served by `node server.js`. Never shown to any agent.
// They drive it in Electron's Chromium through Playwright.
const test = require('node:test');
const assert = require('node:assert');
const { join } = require('node:path');
const { startServer, tempDataFile, cleanup, call, PNG, dataUrl } = require('./recipes-helpers.cjs');

const root = process.env.BENCH_ROOT;
const { _electron: electron } = require(join(root, 'node_modules', '@playwright', 'test'));
const electronBin = require(join(root, 'node_modules', 'electron'));

let srv;
let app;
let page;
let seeded;
const errors = [];
const api = (method, path, body) => call(srv.base, method, path, body);

test.before(async () => {
  srv = await startServer(tempDataFile());
  const omelette = (
    await api('POST', '/api/recipes', {
      title: 'Cheese omelette',
      ingredients: ['3 eggs', 'Grated cheddar'],
      steps: ['Beat the eggs', 'Cook and fold'],
      tags: ['breakfast'],
      minutes: 10,
    })
  ).body;
  const curry = (
    await api('POST', '/api/recipes', {
      title: 'Chickpea curry',
      ingredients: ['Chickpeas', 'Coconut milk', 'Curry paste'],
      steps: ['Simmer everything'],
      tags: ['dinner', 'vegan'],
      minutes: 30,
    })
  ).body;
  await api('POST', `/api/recipes/${curry.id}/photo`, { dataUrl: dataUrl('image/png', PNG) });
  seeded = { omelette, curry };
  app = await electron.launch({
    executablePath: electronBin,
    args: [join(__dirname, 'electron-main.cjs')],
    env: { ...process.env, RECIPES_URL: `${srv.base}/` },
  });
  page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/favicon/i.test(m.location()?.url ?? '')) errors.push(m.text());
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForLoadState('load');
});

test.after(async () => {
  await app?.close();
  await srv?.stop();
  cleanup();
});

const items = () => page.locator('[data-recipe]');
const titles = async () => (await items().allInnerTexts()).map((t) => t.trim());
const hasTitle = async (title) => (await titles()).some((t) => t.includes(title));

async function fresh() {
  await page.reload();
  await page.waitForLoadState('load');
  await page.locator('[data-recipe]').first().waitFor({ timeout: 10_000 });
}

const field = (label) => page.getByLabel(label, { exact: true });
async function fillForm(r) {
  await field('Title').fill(r.title ?? '');
  await field('Ingredients').fill(r.ingredients ?? '');
  await field('Steps').fill(r.steps ?? '');
  await field('Tags').fill(r.tags ?? '');
  await field('Minutes').fill(r.minutes ?? '');
}
const saveButton = () => page.getByRole('button', { name: 'Save recipe' });

/** Wait until `fn` returns true (polled), or fail with `what`. */
async function until(fn, what, ms = 5000) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    assert.ok(Date.now() < deadline, what);
    await page.waitForTimeout(100);
  }
}

test('the page loads without errors and lists the recipes', async () => {
  errors.length = 0;
  await fresh();
  assert.ok(await hasTitle('Cheese omelette'), `listed: ${await titles()}`);
  assert.ok(await hasTitle('Chickpea curry'), `listed: ${await titles()}`);
  // Open both: one with a photo, one without.
  await items().filter({ hasText: 'Cheese omelette' }).first().click();
  await page
    .locator('[data-recipe-detail]')
    .filter({ hasText: 'Grated cheddar' })
    .waitFor({ timeout: 5000 });
  await items().filter({ hasText: 'Chickpea curry' }).first().click();
  await page
    .locator('[data-recipe-detail]')
    .filter({ hasText: 'Coconut milk' })
    .waitFor({ timeout: 5000 });
  await page.waitForTimeout(300);
  assert.deepStrictEqual(errors, []);
});

test('adding a recipe through the form shows it in the list and stores it', async () => {
  errors.length = 0;
  await fresh();
  await fillForm({
    title: '  Banana bread ',
    ingredients: '3 ripe bananas\n\n  200 g flour  \n',
    steps: 'Mash\nMix\nBake',
    tags: 'baking, , sweet ',
    minutes: '70',
  });
  await saveButton().click();
  await until(() => hasTitle('Banana bread'), 'Banana bread appears in the list');
  assert.strictEqual(await field('Title').inputValue(), '', 'the form is cleared');
  const stored = (await api('GET', '/api/recipes?q=banana')).body;
  assert.strictEqual(stored.length, 1);
  assert.deepStrictEqual(
    { ...stored[0], id: 0 },
    {
      id: 0,
      title: 'Banana bread',
      ingredients: ['3 ripe bananas', '200 g flour'],
      steps: ['Mash', 'Mix', 'Bake'],
      tags: ['baking', 'sweet'],
      minutes: 70,
      hasPhoto: false,
    },
  );
  await page.waitForTimeout(200);
  assert.deepStrictEqual(errors, []);
});

test('saving without a title shows a message and adds nothing', async () => {
  await fresh();
  const before = (await api('GET', '/api/recipes')).body.length;
  const listed = (await titles()).length;
  const mentions = async () =>
    ((await page.locator('body').innerText()).match(/title/gi) ?? []).length;
  const mentionsBefore = await mentions();
  await fillForm({ title: '   ', ingredients: 'water' });
  await saveButton().click();
  await page.waitForTimeout(500);
  assert.strictEqual((await api('GET', '/api/recipes')).body.length, before);
  assert.strictEqual((await titles()).length, listed);
  const alert = (await page.getByRole('alert').allInnerTexts()).join(' ').trim();
  const native = await field('Title').evaluate((e) => e.validationMessage);
  assert.ok(
    (await mentions()) > mentionsBefore || alert.length > 0 || native.length > 0,
    'a message about the missing title is shown',
  );
});

test('the search field narrows the list by title and ingredient', async () => {
  await fresh();
  const search = page
    .getByRole('searchbox', { name: 'Search' })
    .or(page.getByRole('textbox', { name: 'Search' }));
  await search.first().fill('COCONUT');
  await until(async () => {
    const t = await titles();
    return t.length === 1 && t[0].includes('Chickpea curry');
  }, 'only the curry matches "COCONUT"');
  await search.first().fill('omelette');
  await until(async () => {
    const t = await titles();
    return t.length === 1 && t[0].includes('Cheese omelette');
  }, 'only the omelette matches "omelette"');
  await search.first().fill('');
  await until(
    async () => (await titles()).length >= 2,
    'clearing the search lists everything again',
  );
});

test('a recipe with a photo shows it in the details', async () => {
  await fresh();
  await items().filter({ hasText: 'Chickpea curry' }).first().click();
  const img = page.locator('[data-recipe-detail] img').first();
  await img.waitFor({ timeout: 5000 });
  await until(() => img.evaluate((e) => e.complete && e.naturalWidth > 0), 'the photo loads');
  const src = await img.evaluate((e) => e.currentSrc || e.src);
  assert.match(src, new RegExp(`/api/recipes/${seeded.curry.id}/photo|^data:image/png|^blob:`));
});

test('Edit loads a recipe into the form and Save recipe updates it', async () => {
  await fresh();
  await items().filter({ hasText: 'Cheese omelette' }).first().click();
  const detail = page.locator('[data-recipe-detail]');
  await detail.filter({ hasText: 'Grated cheddar' }).waitFor({ timeout: 5000 });
  await detail.getByRole('button', { name: 'Edit' }).click();
  await until(
    async () => (await field('Title').inputValue()) === 'Cheese omelette',
    'the title is loaded',
  );
  assert.match(await field('Ingredients').inputValue(), /3 eggs\s*\n\s*Grated cheddar/);
  const before = (await api('GET', '/api/recipes')).body.length;
  await field('Title').fill('Herb omelette');
  await field('Minutes').fill('12');
  await saveButton().click();
  await until(() => hasTitle('Herb omelette'), 'the new title shows in the list');
  assert.ok(!(await hasTitle('Cheese omelette')), 'the old title is gone');
  const stored = (await api('GET', `/api/recipes/${seeded.omelette.id}`)).body;
  assert.strictEqual(stored.title, 'Herb omelette');
  assert.strictEqual(stored.minutes, 12);
  assert.deepStrictEqual(stored.ingredients, ['3 eggs', 'Grated cheddar']);
  assert.strictEqual((await api('GET', '/api/recipes')).body.length, before, 'updated, not added');
});

test('phones: the page fits without sideways scrolling', async () => {
  await page.setViewportSize({ width: 375, height: 812 });
  try {
    await fresh();
    const scroll = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    assert.ok(scroll <= 1, `page scrolls sideways by ${scroll}px`);
    assert.ok(await saveButton().isVisible());
  } finally {
    await page.setViewportSize({ width: 1280, height: 900 });
  }
});
