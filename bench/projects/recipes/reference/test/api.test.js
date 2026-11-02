import test from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { validatePhoto, validateRecipe } from '../src/validate.js';

const dir = mkdtempSync(join(tmpdir(), 'recipes-test-'));
const server = createApp(join(dir, 'test.db'));
let base;

test.before(
  () =>
    new Promise((r) =>
      server.listen(0, () => r((base = `http://localhost:${server.address().port}`))),
    ),
);
test.after(() => {
  server.closeAllConnections();
  return new Promise((r) =>
    server.close(() => (rmSync(dir, { recursive: true, force: true }), r())),
  );
});

const json = async (method, path, body) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body && JSON.stringify(body),
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
};

test('validates recipes', () => {
  assert.ok(validateRecipe({}).error);
  assert.ok(validateRecipe({ title: 'x', minutes: 1.5 }).error);
  assert.ok(validateRecipe({ title: 'x', tags: 'a' }).error);
  assert.deepStrictEqual(validateRecipe({ title: ' x ' }).value, {
    title: 'x',
    ingredients: [],
    steps: [],
    tags: [],
    minutes: null,
  });
});

test('validates photos', () => {
  assert.strictEqual(validatePhoto({ dataUrl: 'data:image/gif;base64,R0lG' }).status, 400);
  const big = Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64');
  assert.strictEqual(validatePhoto({ dataUrl: `data:image/png;base64,${big}` }).status, 413);
  assert.strictEqual(
    validatePhoto({ dataUrl: 'data:image/jpeg;base64,/9j/' }).value.type,
    'image/jpeg',
  );
});

test('CRUD, search and photos over HTTP', async () => {
  const made = await json('POST', '/api/recipes', {
    title: 'Soup',
    ingredients: ['Leek'],
    tags: ['Dinner'],
  });
  assert.strictEqual(made.status, 201);
  const { id } = made.body;
  assert.strictEqual((await json('GET', '/api/recipes?q=leek')).body.length, 1);
  assert.strictEqual((await json('GET', '/api/recipes?tag=dinner')).body.length, 1);
  assert.strictEqual(
    (await json('PUT', `/api/recipes/${id}`, { title: 'Leek soup' })).body.title,
    'Leek soup',
  );
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const up = await json('POST', `/api/recipes/${id}/photo`, {
    dataUrl: `data:image/png;base64,${png}`,
  });
  assert.strictEqual(up.body.hasPhoto, true);
  const photo = await fetch(`${base}/api/recipes/${id}/photo`);
  assert.strictEqual(photo.headers.get('content-type'), 'image/png');
  assert.strictEqual((await json('DELETE', `/api/recipes/${id}`)).status, 204);
  assert.strictEqual((await json('GET', `/api/recipes/${id}`)).status, 404);
  assert.strictEqual((await json('POST', '/api/recipes', { title: '' })).status, 400);
});
