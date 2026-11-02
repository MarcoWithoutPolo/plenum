// Hidden acceptance tests for dashboard: the pure data functions in src/data.js. Never shown to any agent.
// Expected values come from the canonical sales.csv next to this file, read by an independent parser.
const test = require('node:test');
const assert = require('node:assert');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { canonical, filter, cents } = require('./dashboard-helpers.cjs');

let mod;
const load = async () =>
  (mod ??= await import(pathToFileURL(join(process.cwd(), 'src', 'data.js')).href));
const csvText = readFileSync(join(__dirname, 'sales.csv'), 'utf8');
const ROWS = canonical();
const near = (a, b, what) => assert.ok(Math.abs(a - b) < 0.006, `${what}: got ${a}, expected ${b}`);
const isCents = (x, what) =>
  assert.ok(Math.abs(x * 100 - Math.round(x * 100)) < 1e-6, `${what} is rounded to the cent: ${x}`);
const deepFreeze = (rows) => Object.freeze(rows.map((r) => Object.freeze({ ...r })));

test('parseCsv reads the sales file: 500 rows, typed fields, quoted products', async () => {
  const { parseCsv } = await load();
  const rows = parseCsv(csvText);
  assert.strictEqual(rows.length, 500);
  assert.deepStrictEqual(rows[0], ROWS[0]);
  assert.deepStrictEqual(rows, ROWS);
  assert.ok(
    rows.some((r) => r.product === 'Monitor 27"'),
    'doubled quotes are unescaped',
  );
  assert.ok(
    rows.some((r) => r.product === 'Desk Lamp, LED'),
    'commas inside quotes are kept',
  );
});

test('parseCsv: quoted commas and quotes, CRLF, blank lines, header only', async () => {
  const { parseCsv } = await load();
  const text =
    'date,region,category,product,units,revenue\r\n' +
    '2025-01-01,North,Furniture,"Desk, ""Oak"" edition",2,10.5\r\n' +
    '\r\n' +
    '2025-01-02,South,Apparel,Cap,1,3\n';
  assert.deepStrictEqual(parseCsv(text), [
    {
      date: '2025-01-01',
      region: 'North',
      category: 'Furniture',
      product: 'Desk, "Oak" edition',
      units: 2,
      revenue: 10.5,
    },
    {
      date: '2025-01-02',
      region: 'South',
      category: 'Apparel',
      product: 'Cap',
      units: 1,
      revenue: 3,
    },
  ]);
  assert.deepStrictEqual(parseCsv('date,region,category,product,units,revenue\n'), []);
  assert.deepStrictEqual(parseCsv('date,region,category,product,units,revenue'), []);
});

test('filterRows: empty filters keep every row, in order, without changing the input', async () => {
  const { filterRows } = await load();
  const rows = deepFreeze(ROWS);
  for (const f of [{}, { region: '', category: '' }, { region: null, from: undefined, to: '' }]) {
    const out = filterRows(rows, f);
    assert.deepStrictEqual(out, ROWS, JSON.stringify(f));
  }
  assert.notStrictEqual(filterRows(rows, {}), rows, 'returns a new array');
});

test('filterRows: region and category match exactly', async () => {
  const { filterRows } = await load();
  const rows = deepFreeze(ROWS);
  for (const f of [
    { region: 'North' },
    { category: 'Office Supplies' },
    { region: 'West', category: 'Electronics' },
  ]) {
    const out = filterRows(rows, f);
    assert.ok(out.length > 0, JSON.stringify(f));
    assert.deepStrictEqual(out, filter(ROWS, f), JSON.stringify(f));
  }
  assert.deepStrictEqual(filterRows(rows, { region: 'north' }), [], 'case matters');
  assert.deepStrictEqual(filterRows(rows, { region: 'Atlantis' }), []);
});

test('filterRows: date range is inclusive; a range with no orders gives []', async () => {
  const { filterRows } = await load();
  const rows = deepFreeze(ROWS);
  // Bounds on days that do have orders, so inclusiveness shows.
  const from = ROWS[100].date;
  const to = ROWS[300].date;
  const out = filterRows(rows, { from, to });
  assert.deepStrictEqual(out, filter(ROWS, { from, to }));
  assert.ok(
    out.some((r) => r.date === from) && out.some((r) => r.date === to),
    'both ends included',
  );
  assert.deepStrictEqual(filterRows(rows, { from: '2026-01-01', to: '2026-12-31' }), []);
  assert.deepStrictEqual(filterRows(rows, { from: '2025-07-10', to: '2025-07-01' }), []);
  const combined = { region: 'East', category: 'Furniture', from: '2025-04-01', to: '2025-09-30' };
  assert.deepStrictEqual(filterRows(rows, combined), filter(ROWS, combined));
});

test('summarize: totals for all rows, for a subset, and for no rows', async () => {
  const { summarize } = await load();
  assert.deepStrictEqual(summarize([]), { revenue: 0, units: 0, orders: 0 });
  for (const f of [{}, { region: 'South', category: 'Apparel' }, { from: '2025-11-01' }]) {
    const sub = filter(ROWS, f);
    const s = summarize(deepFreeze(sub));
    assert.deepStrictEqual(Object.keys(s).sort(), ['orders', 'revenue', 'units']);
    assert.strictEqual(s.orders, sub.length);
    assert.strictEqual(
      s.units,
      sub.reduce((n, r) => n + r.units, 0),
    );
    near(s.revenue, cents(sub.reduce((n, r) => n + r.revenue, 0)), `revenue ${JSON.stringify(f)}`);
    isCents(s.revenue, 'revenue');
  }
});

test('byMonth: one entry per month with orders, oldest first, to the cent', async () => {
  const { byMonth } = await load();
  assert.deepStrictEqual(byMonth([]), []);
  const check = (rows) => {
    const got = byMonth(deepFreeze(rows));
    const want = new Map();
    for (const r of rows)
      want.set(r.date.slice(0, 7), (want.get(r.date.slice(0, 7)) ?? 0) + r.revenue);
    const months = [...want.keys()].sort();
    assert.deepStrictEqual(
      got.map((m) => m.month),
      months,
    );
    got.forEach((m, i) => {
      assert.deepStrictEqual(Object.keys(m).sort(), ['month', 'revenue']);
      near(m.revenue, cents(want.get(months[i])), m.month);
      isCents(m.revenue, m.month);
    });
  };
  check(ROWS);
  assert.strictEqual(byMonth(ROWS).length, 12);
  check(filter(ROWS, { region: 'North', from: '2025-03-15', to: '2025-08-20' }));
});

test('byCategory: highest revenue first, to the cent', async () => {
  const { byCategory } = await load();
  assert.deepStrictEqual(byCategory([]), []);
  for (const f of [{}, { region: 'West' }]) {
    const rows = filter(ROWS, f);
    const want = new Map();
    for (const r of rows) want.set(r.category, (want.get(r.category) ?? 0) + r.revenue);
    const expected = [...want]
      .map(([category, revenue]) => ({ category, revenue: cents(revenue) }))
      .sort((a, b) => b.revenue - a.revenue || a.category.localeCompare(b.category));
    const got = byCategory(deepFreeze(rows));
    assert.deepStrictEqual(
      got.map((c) => c.category),
      expected.map((c) => c.category),
    );
    got.forEach((c, i) => near(c.revenue, expected[i].revenue, c.category));
  }
  const tie = [
    { date: '2025-01-01', region: 'N', category: 'Zeta', product: 'p', units: 1, revenue: 5 },
    { date: '2025-01-01', region: 'N', category: 'Alpha', product: 'p', units: 1, revenue: 5 },
  ];
  assert.deepStrictEqual(
    byCategory(tie).map((c) => c.category),
    ['Alpha', 'Zeta'],
  );
});

test('toCsv: header, quoting, trailing newline, and a round trip through parseCsv', async () => {
  const { toCsv, parseCsv } = await load();
  assert.strictEqual(toCsv([]), 'date,region,category,product,units,revenue\n');
  const sample = [
    {
      date: '2025-01-01',
      region: 'North',
      category: 'Furniture',
      product: 'Desk, "Oak"',
      units: 2,
      revenue: 10.5,
    },
    {
      date: '2025-01-02',
      region: 'South',
      category: 'Apparel',
      product: 'Cap',
      units: 1,
      revenue: 3,
    },
  ];
  assert.strictEqual(
    toCsv(sample),
    'date,region,category,product,units,revenue\n' +
      '2025-01-01,North,Furniture,"Desk, ""Oak""",2,10.5\n' +
      '2025-01-02,South,Apparel,Cap,1,3\n',
  );
  assert.deepStrictEqual(parseCsv(toCsv(deepFreeze(ROWS))), ROWS);
  assert.strictEqual(toCsv(deepFreeze(ROWS)), csvText.replace(/\r\n/g, '\n'));
});
