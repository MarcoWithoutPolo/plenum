// Hidden acceptance tests for recipes: the JSON API on `node server.js`. Never shown to any agent.
const test = require('node:test');
const assert = require('node:assert');
const {
  startServer,
  tempDataFile,
  cleanup,
  call,
  PNG,
  JPEG,
  dataUrl,
} = require('./recipes-helpers.cjs');

let srv;
const api = (method, path, body, raw) => call(srv.base, method, path, body, raw);

test.before(async () => {
  srv = await startServer(tempDataFile());
});
test.after(async () => {
  await srv?.stop();
  cleanup();
});

const pancakes = {
  title: '  Pancakes ',
  ingredients: ['2 eggs', '250 g Flour', '500 ml milk'],
  steps: ['Whisk everything', 'Fry in butter'],
  tags: ['breakfast', 'Sweet'],
  minutes: 20,
};
async function create(recipe) {
  const r = await api('POST', '/api/recipes', recipe);
  assert.strictEqual(r.status, 201, `POST ${JSON.stringify(recipe)}: ${JSON.stringify(r.body)}`);
  return r.body;
}
function assertError(r, status, what) {
  assert.strictEqual(
    r.status,
    status,
    `${what}: status ${r.status}, body ${JSON.stringify(r.body)}`,
  );
  assert.ok(
    r.body &&
      typeof r.body === 'object' &&
      typeof r.body.error === 'string' &&
      r.body.error.length > 0,
    `${what}: JSON body with an error message, got ${JSON.stringify(r.body)}`,
  );
}

test('POST creates a recipe: 201, trimmed title, id, defaults, no photo', async () => {
  const r = await create(pancakes);
  assert.ok(Number.isInteger(r.id) && r.id > 0, `id ${r.id}`);
  assert.deepStrictEqual(
    { ...r, id: 0 },
    { ...pancakes, title: 'Pancakes', id: 0, hasPhoto: false },
  );
  const bare = await create({ title: 'Toast' });
  assert.deepStrictEqual(
    { ...bare, id: 0 },
    { id: 0, title: 'Toast', ingredients: [], steps: [], tags: [], minutes: null, hasPhoto: false },
  );
  assert.notStrictEqual(bare.id, r.id);
});

test('GET returns one recipe by id, and the list oldest first', async () => {
  const a = await create({ title: 'List A', ingredients: ['x'] });
  const b = await create({ title: 'List B', minutes: 5 });
  const one = await api('GET', `/api/recipes/${b.id}`);
  assert.strictEqual(one.status, 200);
  assert.deepStrictEqual(one.body, b);
  const all = await api('GET', '/api/recipes');
  assert.strictEqual(all.status, 200);
  assert.ok(Array.isArray(all.body));
  const ids = all.body.map((r) => r.id);
  assert.deepStrictEqual(
    ids,
    [...ids].sort((x, y) => x - y),
    'oldest first',
  );
  assert.deepStrictEqual(
    all.body.find((r) => r.id === a.id),
    a,
  );
});

test('PUT replaces the recipe and keeps its id', async () => {
  const r = await create(pancakes);
  const put = await api('PUT', `/api/recipes/${r.id}`, {
    title: 'Crêpes',
    ingredients: ['1 egg'],
    tags: ['french'],
    id: 999,
  });
  assert.strictEqual(put.status, 200, JSON.stringify(put.body));
  const want = {
    id: r.id,
    title: 'Crêpes',
    ingredients: ['1 egg'],
    steps: [],
    tags: ['french'],
    minutes: null,
    hasPhoto: false,
  };
  assert.deepStrictEqual(put.body, want);
  assert.deepStrictEqual((await api('GET', `/api/recipes/${r.id}`)).body, want);
});

test('DELETE removes the recipe: 204, then 404 and gone from the list', async () => {
  const r = await create({ title: 'Short-lived' });
  const del = await api('DELETE', `/api/recipes/${r.id}`);
  assert.strictEqual(del.status, 204);
  assert.strictEqual(del.bytes.length, 0, 'no body');
  assertError(await api('GET', `/api/recipes/${r.id}`), 404, 'GET after DELETE');
  const all = await api('GET', '/api/recipes');
  assert.ok(!all.body.some((x) => x.id === r.id));
});

test('unknown ids give 404 with a JSON error on every route', async () => {
  for (const id of ['987654', 'abc']) {
    assertError(await api('GET', `/api/recipes/${id}`), 404, `GET ${id}`);
    assertError(await api('PUT', `/api/recipes/${id}`, { title: 'x' }), 404, `PUT ${id}`);
    assertError(await api('DELETE', `/api/recipes/${id}`), 404, `DELETE ${id}`);
    assertError(await api('GET', `/api/recipes/${id}/photo`), 404, `GET photo ${id}`);
    assertError(
      await api('POST', `/api/recipes/${id}/photo`, { dataUrl: dataUrl('image/png', PNG) }),
      404,
      `POST photo ${id}`,
    );
  }
  assertError(await api('GET', '/api/nothing-here'), 404, 'unknown API path');
});

async function count() {
  return (await api('GET', '/api/recipes')).body.length;
}

test('validation: a missing, empty or non-string title gives 400 and adds nothing', async () => {
  const before = await count();
  for (const body of [{}, { title: '' }, { title: '   ' }, { title: 42 }, { ingredients: ['egg'] }])
    assertError(await api('POST', '/api/recipes', body), 400, `POST ${JSON.stringify(body)}`);
  assert.strictEqual(await count(), before);
});

test('validation: minutes must be a positive whole number', async () => {
  const before = await count();
  for (const minutes of [0, -5, 2.5, '10', true])
    assertError(
      await api('POST', '/api/recipes', { title: 'Timed', minutes }),
      400,
      `minutes ${JSON.stringify(minutes)}`,
    );
  assert.strictEqual(await count(), before);
  assert.strictEqual((await create({ title: 'Timed', minutes: 1 })).minutes, 1);
});

test('validation: tags, ingredients and steps must be arrays of strings', async () => {
  const before = await count();
  for (const extra of [
    { tags: 'dinner' },
    { tags: ['ok', 3] },
    { ingredients: 'flour, eggs' },
    { ingredients: [{ name: 'flour' }] },
    { steps: 'mix' },
    { steps: [null] },
  ])
    assertError(
      await api('POST', '/api/recipes', { title: 'Typed', ...extra }),
      400,
      JSON.stringify(extra),
    );
  assert.strictEqual(await count(), before);
});

test('validation: bad JSON gives 400; a bad PUT changes nothing', async () => {
  assertError(await api('POST', '/api/recipes', '{"title": "oops"', true), 400, 'POST bad JSON');
  const r = await create({ title: 'Stable', minutes: 10 });
  assertError(await api('PUT', `/api/recipes/${r.id}`, '{nope', true), 400, 'PUT bad JSON');
  assertError(await api('PUT', `/api/recipes/${r.id}`, { title: '' }), 400, 'PUT empty title');
  assertError(
    await api('PUT', `/api/recipes/${r.id}`, { title: 'X', minutes: 0 }),
    400,
    'PUT minutes 0',
  );
  assert.deepStrictEqual((await api('GET', `/api/recipes/${r.id}`)).body, r);
});

test('search: ?q= matches title and ingredients, ignoring case', async () => {
  const soup = await create({
    title: 'Tomato Soup',
    ingredients: ['Tomatoes', 'Basil'],
    tags: ['Dinner'],
  });
  const salad = await create({
    title: 'Caprese',
    ingredients: ['tomato', 'Mozzarella'],
    tags: ['lunch'],
  });
  const cake = await create({
    title: 'Lemon cake',
    ingredients: ['lemons', 'sugar'],
    tags: ['dessert', 'dinner'],
  });
  const ids = async (query) => (await api('GET', `/api/recipes?${query}`)).body.map((r) => r.id);
  const mine = (list) => list.filter((id) => [soup.id, salad.id, cake.id].includes(id));
  assert.deepStrictEqual(mine(await ids('q=TOMATO')), [soup.id, salad.id]);
  assert.deepStrictEqual(mine(await ids('q=mozz')), [salad.id]);
  assert.deepStrictEqual(mine(await ids('q=lemon%20cake')), [cake.id]);
  assert.deepStrictEqual(await ids('q=zzz-no-such-thing'), []);
});

test('filter: ?tag= matches a whole tag, ignoring case, and combines with ?q=', async () => {
  const a = await create({ title: 'Tag stew', ingredients: ['beef'], tags: ['Hearty', 'winter'] });
  const b = await create({
    title: 'Tag salad',
    ingredients: ['beef', 'lettuce'],
    tags: ['summer'],
  });
  const c = await create({ title: 'Tag pie', ingredients: ['apples'], tags: ['winter'] });
  const ids = async (query) =>
    (await api('GET', `/api/recipes?${query}`)).body
      .map((r) => r.id)
      .filter((id) => [a.id, b.id, c.id].includes(id));
  assert.deepStrictEqual(await ids('tag=WINTER'), [a.id, c.id]);
  assert.deepStrictEqual(await ids('tag=hearty'), [a.id]);
  assert.deepStrictEqual(await ids('tag=wint'), [], 'a whole tag, not part of one');
  assert.deepStrictEqual(await ids('tag=winter&q=BEEF'), [a.id]);
  const tagged = (await api('GET', '/api/recipes?tag=summer')).body;
  assert.ok(tagged.every((r) => r.tags.some((t) => t.toLowerCase() === 'summer')));
});

test('photo: a PNG upload sets hasPhoto and downloads with image/png', async () => {
  const r = await create({ title: 'Photogenic' });
  assertError(await api('GET', `/api/recipes/${r.id}/photo`), 404, 'no photo yet');
  const up = await api('POST', `/api/recipes/${r.id}/photo`, {
    dataUrl: dataUrl('image/png', PNG),
  });
  assert.strictEqual(up.status, 200, JSON.stringify(up.body));
  assert.strictEqual(up.body.hasPhoto, true);
  assert.strictEqual(up.body.id, r.id);
  assert.strictEqual((await api('GET', `/api/recipes/${r.id}`)).body.hasPhoto, true);
  const down = await api('GET', `/api/recipes/${r.id}/photo`);
  assert.strictEqual(down.status, 200);
  assert.match(down.type, /^image\/png/);
  assert.ok(down.bytes.equals(PNG), 'the same bytes come back');
});

test('photo: a JPEG replaces the PNG and downloads with image/jpeg', async () => {
  const r = await create({ title: 'Two photos' });
  await api('POST', `/api/recipes/${r.id}/photo`, { dataUrl: dataUrl('image/png', PNG) });
  const up = await api('POST', `/api/recipes/${r.id}/photo`, {
    dataUrl: dataUrl('image/jpeg', JPEG),
  });
  assert.strictEqual(up.status, 200, JSON.stringify(up.body));
  const down = await api('GET', `/api/recipes/${r.id}/photo`);
  assert.match(down.type, /^image\/jpeg/);
  assert.ok(down.bytes.equals(JPEG));
});

test('photo: other types and malformed data URLs give 400', async () => {
  const r = await create({ title: 'Picky' });
  for (const body of [
    { dataUrl: dataUrl('image/gif', Buffer.from('GIF89a')) },
    { dataUrl: dataUrl('image/svg+xml', Buffer.from('<svg/>')) },
    { dataUrl: dataUrl('text/plain', Buffer.from('hello')) },
    { dataUrl: 'not a data url' },
    { dataUrl: 'data:image/png,rawtext' },
    {},
  ])
    assertError(
      await api('POST', `/api/recipes/${r.id}/photo`, body),
      400,
      JSON.stringify(body).slice(0, 60),
    );
  assert.strictEqual((await api('GET', `/api/recipes/${r.id}`)).body.hasPhoto, false);
});

test('photo: over 2 MB gives 413; exactly 2 MB is accepted', async () => {
  const r = await create({ title: 'Big picture' });
  const limit = 2 * 1024 * 1024;
  const pad = (n) => Buffer.concat([PNG, Buffer.alloc(n - PNG.length, 1)]);
  assertError(
    await api('POST', `/api/recipes/${r.id}/photo`, {
      dataUrl: dataUrl('image/png', pad(limit + 1)),
    }),
    413,
    '2 MB + 1 byte',
  );
  assert.strictEqual((await api('GET', `/api/recipes/${r.id}`)).body.hasPhoto, false);
  const ok = await api('POST', `/api/recipes/${r.id}/photo`, {
    dataUrl: dataUrl('image/png', pad(limit)),
  });
  assert.strictEqual(ok.status, 200, `exactly 2 MB: ${ok.status}`);
  const down = await api('GET', `/api/recipes/${r.id}/photo`);
  assert.strictEqual(down.bytes.length, limit);
});

test('data, photos included, survives a restart of the server', async () => {
  const file = tempDataFile();
  let s = await startServer(file);
  let made;
  try {
    made = (await call(s.base, 'POST', '/api/recipes', { ...pancakes, title: 'Persistent' })).body;
    const up = await call(s.base, 'POST', `/api/recipes/${made.id}/photo`, {
      dataUrl: dataUrl('image/png', PNG),
    });
    assert.strictEqual(up.status, 200);
    await call(s.base, 'POST', '/api/recipes', { title: 'Second' });
  } finally {
    await s.stop();
  }
  s = await startServer(file);
  try {
    const all = (await call(s.base, 'GET', '/api/recipes')).body;
    assert.deepStrictEqual(
      all.map((r) => r.title),
      ['Persistent', 'Second'],
    );
    assert.deepStrictEqual(all[0], { ...made, hasPhoto: true });
    const photo = await call(s.base, 'GET', `/api/recipes/${made.id}/photo`);
    assert.strictEqual(photo.status, 200);
    assert.ok(photo.bytes.equals(PNG));
    // New recipes after a restart get a fresh id.
    const third = (await call(s.base, 'POST', '/api/recipes', { title: 'Third' })).body;
    assert.ok(!all.some((r) => r.id === third.id));
  } finally {
    await s.stop();
  }
});
