import test from 'node:test';
import assert from 'node:assert';
import {
  MAX_QTY,
  addItem,
  itemCount,
  lines,
  loadCart,
  removeItem,
  saveCart,
  setQuantity,
  shippingFor,
  subtotal,
} from '../src/cart.js';

const products = [
  { id: 'a', name: 'A', price: 19.99 },
  { id: 'b', name: 'B', price: 0.1 },
];

test('adds items and merges repeated adds', () => {
  let c = addItem([], 'a');
  c = addItem(c, 'b', 2);
  c = addItem(c, 'a', 3);
  assert.deepStrictEqual(c, [
    { id: 'a', qty: 4 },
    { id: 'b', qty: 2 },
  ]);
  assert.strictEqual(itemCount(c), 6);
});

test('ignores empty adds and caps quantities', () => {
  assert.deepStrictEqual(addItem([], 'a', 0), []);
  assert.deepStrictEqual(addItem([], '', 1), []);
  assert.deepStrictEqual(addItem([{ id: 'a', qty: 98 }], 'a', 5), [{ id: 'a', qty: MAX_QTY }]);
});

test('sets quantities, removing at zero and ignoring nonsense', () => {
  const c = [{ id: 'a', qty: 1 }];
  assert.deepStrictEqual(setQuantity(c, 'a', 3), [{ id: 'a', qty: 3 }]);
  assert.deepStrictEqual(setQuantity(c, 'a', '7'), [{ id: 'a', qty: 7 }]);
  assert.deepStrictEqual(setQuantity(c, 'a', 0), []);
  assert.strictEqual(setQuantity(c, 'a', 'lots'), c);
  assert.deepStrictEqual(setQuantity(c, 'a', 1000), [{ id: 'a', qty: MAX_QTY }]);
});

test('removes items', () => {
  const c = [
    { id: 'a', qty: 1 },
    { id: 'b', qty: 1 },
  ];
  assert.deepStrictEqual(removeItem(c, 'a'), [{ id: 'b', qty: 1 }]);
});

test('computes line totals and the subtotal without float drift', () => {
  const c = [
    { id: 'a', qty: 3 },
    { id: 'b', qty: 3 },
    { id: 'gone', qty: 1 },
  ];
  assert.deepStrictEqual(
    lines(c, products).map((l) => l.total),
    [59.97, 0.3],
  );
  assert.strictEqual(subtotal(c, products), 60.27);
  assert.strictEqual(subtotal([], products), 0);
});

test('free shipping from $40', () => {
  assert.strictEqual(shippingFor(0), 0);
  assert.strictEqual(shippingFor(39.99), 5);
  assert.strictEqual(shippingFor(40), 0);
});

test('saves and loads, surviving junk in storage', () => {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  saveCart(storage, [{ id: 'a', qty: 2 }]);
  assert.deepStrictEqual(loadCart(storage), [{ id: 'a', qty: 2 }]);
  store.set('northwind.cart', '{nope');
  assert.deepStrictEqual(loadCart(storage), []);
  store.set(
    'northwind.cart',
    JSON.stringify([{ id: 'a', qty: -1 }, { id: 3 }, { id: 'b', qty: 2 }]),
  );
  assert.deepStrictEqual(loadCart(storage), [{ id: 'b', qty: 2 }]);
});
