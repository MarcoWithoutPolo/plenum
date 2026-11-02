import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import {
  browse,
  filterProducts,
  findProduct,
  formatPrice,
  readOptions,
  related,
  sortProducts,
} from '../src/catalog.js';

const products = JSON.parse(readFileSync(new URL('../data/products.json', import.meta.url)));
const ids = (list) => list.map((p) => p.id);
const sample = [
  { id: 'a', name: 'Bravo', roast: 'light', price: 15 },
  { id: 'b', name: 'Alpha', roast: 'dark', price: 20 },
  { id: 'c', name: 'Charlie', roast: 'dark', price: 12.5 },
  { id: 'd', name: 'Delta', roast: 'medium', price: 20.01 },
  { id: 'e', name: 'Echo', roast: 'medium', price: 15 },
];

test('the catalog has at least 8 well-formed products with unique ids', () => {
  assert.ok(products.length >= 8);
  assert.strictEqual(new Set(ids(products)).size, products.length);
  for (const p of products) {
    assert.match(p.id, /^[a-z0-9-]+$/);
    assert.ok(['light', 'medium', 'dark'].includes(p.roast));
    assert.ok(typeof p.price === 'number' && p.price > 0);
  }
});

test('filters by roast', () => {
  assert.deepStrictEqual(ids(filterProducts(sample, { roast: 'dark' })), ['b', 'c']);
  assert.deepStrictEqual(ids(filterProducts(sample, { roast: 'all' })), ['a', 'b', 'c', 'd', 'e']);
});

test('filters by price band, with 15 and 20 inclusive', () => {
  assert.deepStrictEqual(ids(filterProducts(sample, { price: 'under-15' })), ['c']);
  assert.deepStrictEqual(ids(filterProducts(sample, { price: '15-20' })), ['a', 'b', 'e']);
  assert.deepStrictEqual(ids(filterProducts(sample, { price: 'over-20' })), ['d']);
  assert.strictEqual(filterProducts(sample, { price: 'nonsense' }).length, 5);
});

test('combines filters', () => {
  assert.deepStrictEqual(ids(filterProducts(sample, { roast: 'dark', price: '15-20' })), ['b']);
});

test('sorts without changing the input', () => {
  const copy = [...sample];
  assert.deepStrictEqual(ids(sortProducts(sample, 'price-asc')), ['c', 'a', 'e', 'b', 'd']);
  assert.deepStrictEqual(ids(sortProducts(sample, 'price-desc')), ['d', 'b', 'a', 'e', 'c']);
  assert.deepStrictEqual(ids(sortProducts(sample, 'name')), ['b', 'a', 'c', 'd', 'e']);
  assert.deepStrictEqual(ids(sortProducts(sample, 'featured')), ids(sample));
  assert.deepStrictEqual(sample, copy);
});

test('browse filters then sorts', () => {
  assert.deepStrictEqual(ids(browse(sample, { roast: 'dark', sort: 'price-asc' })), ['c', 'b']);
});

test('reads options from a query string, ignoring junk', () => {
  assert.deepStrictEqual(readOptions(new URLSearchParams('roast=dark&price=over-20&sort=name')), {
    roast: 'dark',
    price: 'over-20',
    sort: 'name',
  });
  assert.deepStrictEqual(readOptions(new URLSearchParams('roast=burnt&price=toString&sort=x')), {
    roast: 'all',
    price: 'any',
    sort: 'featured',
  });
});

test('finds products and related ones', () => {
  assert.strictEqual(findProduct(sample, 'c').name, 'Charlie');
  assert.strictEqual(findProduct(sample, 'zzz'), undefined);
  assert.deepStrictEqual(ids(related(sample, 'b', 3)), ['c', 'a', 'd']);
  assert.deepStrictEqual(related(sample, 'zzz'), []);
});

test('formats prices in dollars', () => {
  assert.strictEqual(formatPrice(19), '$19.00');
  assert.strictEqual(formatPrice(21.5), '$21.50');
  assert.strictEqual(formatPrice(0.1 + 0.2), '$0.30');
});
