const test = require('node:test');
const assert = require('node:assert');
const inv = require('../inventory.js');

test('adds and totals', () => {
  inv.add('A1', 'Widget', 2, 3);
  inv.add('A1', 'Widget', 1, 3);
  assert.strictEqual(inv._items.A1.qty, 3);
  assert.strictEqual(inv.total(), 9);
});

test('finds by name', () => {
  assert.strictEqual(inv.find('Widget').sku, 'A1');
});
