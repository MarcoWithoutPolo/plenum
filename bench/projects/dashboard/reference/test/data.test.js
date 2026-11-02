import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { byCategory, byMonth, filterRows, parseCsv, summarize, toCsv } from '../src/data.js';

const rows = parseCsv(readFileSync(new URL('../data/sales.csv', import.meta.url), 'utf8'));

test('parses the sales data, with quoted fields and numbers', () => {
  assert.strictEqual(rows.length, 500);
  assert.strictEqual(typeof rows[0].units, 'number');
  assert.ok(rows.some((r) => r.product === 'Monitor 27"'));
  assert.deepStrictEqual(parseCsv('a,b\r\n"x, y",2\r\n\r\n'), [{ a: 'x, y', b: '2' }]);
});

test('filters by region, category and dates', () => {
  assert.strictEqual(filterRows(rows, {}).length, rows.length);
  const f = filterRows(rows, {
    region: 'North',
    category: 'Apparel',
    from: '2025-03-01',
    to: '2025-03-31',
  });
  assert.ok(
    f.every(
      (r) => r.region === 'North' && r.category === 'Apparel' && r.date.startsWith('2025-03'),
    ),
  );
  assert.deepStrictEqual(filterRows(rows, { from: '2030-01-01' }), []);
});

test('summarizes and groups', () => {
  assert.deepStrictEqual(summarize([]), { revenue: 0, units: 0, orders: 0 });
  const s = summarize(rows);
  assert.strictEqual(s.orders, 500);
  assert.strictEqual(byMonth(rows).length, 12);
  const cats = byCategory(rows);
  assert.ok(cats[0].revenue >= cats.at(-1).revenue);
  const sum = cats.reduce((n, c) => n + c.revenue, 0);
  assert.ok(Math.abs(sum - s.revenue) < 0.05);
});

test('toCsv round-trips', () => {
  assert.deepStrictEqual(parseCsv(toCsv(rows)), rows);
  assert.strictEqual(toCsv([]), 'date,region,category,product,units,revenue\n');
});
