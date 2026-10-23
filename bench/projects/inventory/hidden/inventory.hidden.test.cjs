// Hidden acceptance tests for inventory. Never shown to any agent.
const test = require('node:test');
const assert = require('node:assert');
const { join } = require('node:path');
const { existsSync } = require('node:fs');
const { Inventory } = require(join(process.cwd(), 'index.js'));

const stocked = () => {
  const inv = new Inventory();
  inv.add('B2', 'Blue Widget', 5, 2.5);
  inv.add('A1', 'Widget', 10, 1.001);
  inv.add('C3', 'gadget', 1, 4);
  return inv;
};

test('refactor: class in src/, independent instances', () => {
  assert.ok(existsSync(join(process.cwd(), 'src')), 'src/ exists');
  const a = new Inventory();
  const b = new Inventory();
  a.add('X', 'Thing', 1, 1);
  assert.deepStrictEqual(b.find('thing'), []);
});

test('add: merges quantity, keeps first name and price', () => {
  const inv = new Inventory();
  inv.add('A1', 'Widget', 2, 3);
  inv.add('A1', 'Other name', 1, 99);
  assert.deepStrictEqual(inv.find('widget'), [{ sku: 'A1', name: 'Widget', qty: 3, price: 3 }]);
});

test('add: validation', () => {
  const inv = new Inventory();
  assert.throws(() => inv.add('A', 'x', 0, 1), RangeError);
  assert.throws(() => inv.add('A', 'x', -1, 1), RangeError);
  assert.throws(() => inv.add('A', 'x', 1, -0.5), RangeError);
  assert.deepStrictEqual(inv.find('x'), []);
  inv.add('F', 'free sample', 1, 0);
  assert.strictEqual(inv.total(), 0);
});

test('remove: errors change nothing; zero stays listed', () => {
  const inv = stocked();
  assert.throws(
    () => inv.remove('C3', 2),
    (e) => e instanceof RangeError && e.message === 'Not enough stock',
  );
  assert.strictEqual(inv.find('gadget')[0].qty, 1);
  assert.throws(
    () => inv.remove('ZZ', 1),
    (e) => e instanceof Error && e.message === 'Unknown SKU: ZZ',
  );
  inv.remove('C3', 1);
  assert.deepStrictEqual(inv.find('gadget'), [{ sku: 'C3', name: 'gadget', qty: 0, price: 4 }]);
});

test('total: rounded to cents', () => {
  const inv = new Inventory();
  inv.add('A', 'a', 1, 7.505);
  assert.strictEqual(inv.total(), 7.51);
  const s = stocked();
  assert.strictEqual(s.total(), 26.51);
  assert.strictEqual(typeof s.total(), 'number');
});

test('find: case-insensitive substring, sorted by SKU', () => {
  const inv = stocked();
  assert.deepStrictEqual(
    inv.find('WIDGET').map((i) => i.sku),
    ['A1', 'B2'],
  );
  assert.deepStrictEqual(
    inv.find('dge').map((i) => i.sku),
    ['A1', 'B2', 'C3'],
  );
  assert.deepStrictEqual(inv.find('nothing'), []);
});

test('lowStock: below threshold, by qty then SKU', () => {
  const inv = stocked();
  inv.add('D4', 'doohickey', 5, 1);
  assert.deepStrictEqual(
    inv.lowStock(6).map((i) => i.sku),
    ['C3', 'B2', 'D4'],
  );
  assert.deepStrictEqual(inv.lowStock(1), []);
});
