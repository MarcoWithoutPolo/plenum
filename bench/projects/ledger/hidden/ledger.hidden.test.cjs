// Hidden acceptance tests for ledger. Never shown to any agent.
const test = require('node:test');
const assert = require('node:assert');
const { join } = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { mkdtempSync, writeFileSync, existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const L = require(join(process.cwd(), 'index.js'));

const isLedgerError = (message) => (err) =>
  err instanceof L.LedgerError && err instanceof Error && err.message === message;

const SAMPLE = `; sample books
2026-01-05 Coffee with Sam
    Expenses:Food:Coffee    4.50 USD
    Assets:Cash

2026-01-06 Pay
    Assets:Bank  1,000.00 USD
    Income:Salary  -1,000.00 USD

2026-01-20 Groceries
\tExpenses:Food:Groceries\t62.25 USD
\tAssets:Bank

2026-02-01 Trip deposit
    Expenses:Travel  200.00 EUR
    Assets:Bank:Euro  -200.00 EUR
`;

test('money: parse and format', () => {
  assert.deepStrictEqual(L.parseAmount('-1,234.5 EUR'), { cents: -123450, currency: 'EUR' });
  assert.deepStrictEqual(L.parseAmount('12 GBP'), { cents: 1200, currency: 'GBP' });
  assert.deepStrictEqual(L.parseAmount('$12.50'), { cents: 1250, currency: 'USD' });
  assert.deepStrictEqual(L.parseAmount('-$3'), { cents: -300, currency: 'USD' });
  assert.deepStrictEqual(L.parseAmount('0.07 USD'), { cents: 7, currency: 'USD' });
  for (const bad of ['1.234 USD', '12,34 USD', '1,2345 USD', 'abc', '12 usd', '12', '1..2 USD']) {
    assert.throws(() => L.parseAmount(bad), isLedgerError(`Invalid amount: ${bad}`), bad);
  }
  assert.strictEqual(L.formatAmount({ cents: 123450, currency: 'EUR' }), '1,234.50 EUR');
  assert.strictEqual(L.formatAmount({ cents: -300, currency: 'USD' }), '-3.00 USD');
  assert.strictEqual(L.formatAmount({ cents: 5, currency: 'USD' }), '0.05 USD');
  assert.strictEqual(L.formatAmount({ cents: 123456789, currency: 'JPY' }), '1,234,567.89 JPY');
});

test('money: allocate keeps every cent', () => {
  assert.deepStrictEqual(L.allocate(100, [1, 1, 1]), [34, 33, 33]);
  assert.deepStrictEqual(L.allocate(-100, [1, 1, 1]), [-34, -33, -33]);
  assert.deepStrictEqual(L.allocate(5, [3, 1]), [4, 1]);
  assert.deepStrictEqual(L.allocate(1000, [1]), [1000]);
  const parts = L.allocate(1001, [2, 3, 5]);
  assert.strictEqual(
    parts.reduce((a, b) => a + b, 0),
    1001,
  );
  assert.ok(parts.every(Number.isInteger));
});

test('journal: posts balanced transactions and fills one missing amount', () => {
  const j = new L.Journal();
  const t = j.post({
    date: '2026-03-01',
    memo: 'Lunch',
    postings: [
      { account: 'Expenses:Food', amount: '12.00 USD' },
      { account: 'Assets:Cash', amount: null },
    ],
  });
  assert.strictEqual(t.id, 1);
  assert.deepStrictEqual(t.postings, [
    { account: 'Expenses:Food', amount: { cents: 1200, currency: 'USD' } },
    { account: 'Assets:Cash', amount: { cents: -1200, currency: 'USD' } },
  ]);
  const t2 = j.post({
    date: '2026-02-01',
    memo: 'Earlier',
    postings: [
      { account: 'Assets:Bank', amount: { cents: 500, currency: 'USD' } },
      { account: 'Equity:Opening', amount: { cents: -500, currency: 'USD' } },
    ],
  });
  assert.strictEqual(t2.id, 2);
  assert.deepStrictEqual(
    j.transactions().map((x) => x.memo),
    ['Earlier', 'Lunch'],
  );
});

test('journal: rejects bad transactions and adds nothing', () => {
  const j = new L.Journal();
  const ok = [
    { account: 'Expenses:Food', amount: '1.00 USD' },
    { account: 'Assets:Cash', amount: '-1.00 USD' },
  ];
  assert.throws(
    () => j.post({ date: '2026-02-30', memo: '', postings: ok }),
    isLedgerError('Invalid date: 2026-02-30'),
  );
  assert.throws(
    () => j.post({ date: '2026/01/01', memo: '', postings: ok }),
    isLedgerError('Invalid date: 2026/01/01'),
  );
  assert.throws(
    () =>
      j.post({
        date: '2026-01-01',
        memo: '',
        postings: [ok[0], { account: 'Cash', amount: '-1.00 USD' }],
      }),
    isLedgerError('Invalid account: Cash'),
  );
  assert.throws(
    () =>
      j.post({
        date: '2026-01-01',
        memo: '',
        postings: [ok[0], { account: 'Assets::Cash', amount: '-1.00 USD' }],
      }),
    isLedgerError('Invalid account: Assets::Cash'),
  );
  assert.throws(
    () => j.post({ date: '2026-01-01', memo: '', postings: [ok[0]] }),
    isLedgerError('A transaction needs at least 2 postings'),
  );
  assert.throws(
    () =>
      j.post({
        date: '2026-01-01',
        memo: '',
        postings: [
          ok[0],
          { account: 'Assets:Cash', amount: null },
          { account: 'Assets:Bank', amount: null },
        ],
      }),
    isLedgerError('Only one posting may omit its amount'),
  );
  assert.throws(
    () =>
      j.post({
        date: '2026-01-01',
        memo: '',
        postings: [ok[0], { account: 'Assets:Cash', amount: '-0.99 USD' }],
      }),
    isLedgerError('Unbalanced transaction'),
  );
  assert.throws(
    () =>
      j.post({
        date: '2026-01-01',
        memo: '',
        postings: [ok[0], { account: 'Assets:Cash', amount: '-1.00 EUR' }],
      }),
    isLedgerError('Unbalanced transaction'),
  );
  assert.deepStrictEqual(j.transactions(), []);
  // Two currencies, each balanced, is fine.
  j.post({
    date: '2026-01-01',
    memo: 'fx',
    postings: [
      { account: 'Assets:Usd', amount: '10.00 USD' },
      { account: 'Equity:Fx', amount: '-10.00 USD' },
      { account: 'Assets:Eur', amount: '9.00 EUR' },
      { account: 'Equity:Fx', amount: '-9.00 EUR' },
    ],
  });
  assert.strictEqual(j.transactions().length, 1);
});

test('reports: balances roll up to parents, by date and depth', () => {
  const j = L.parseLedger(SAMPLE);
  const rows = L.balances(j).map((r) => `${r.account} ${r.currency} ${r.cents}`);
  assert.deepStrictEqual(rows, [
    'Assets EUR -20000',
    'Assets USD 93325',
    'Assets:Bank EUR -20000',
    'Assets:Bank USD 93775',
    'Assets:Bank:Euro EUR -20000',
    'Assets:Cash USD -450',
    'Expenses EUR 20000',
    'Expenses USD 6675',
    'Expenses:Food USD 6675',
    'Expenses:Food:Coffee USD 450',
    'Expenses:Food:Groceries USD 6225',
    'Expenses:Travel EUR 20000',
    'Income USD -100000',
    'Income:Salary USD -100000',
  ]);
  assert.deepStrictEqual(
    L.balances(j, { depth: 1 }).map((r) => `${r.account} ${r.currency}`),
    ['Assets EUR', 'Assets USD', 'Expenses EUR', 'Expenses USD', 'Income USD'],
  );
  assert.deepStrictEqual(
    L.balances(j, { asOf: '2026-01-05' }).map((r) => `${r.account} ${r.cents}`),
    [
      'Assets -450',
      'Assets:Cash -450',
      'Expenses 450',
      'Expenses:Food 450',
      'Expenses:Food:Coffee 450',
    ],
  );
});

test('reports: balances leave out accounts that net to zero', () => {
  const j = new L.Journal();
  j.post({
    date: '2026-01-01',
    memo: 'in',
    postings: [
      { account: 'Assets:A', amount: '5.00 USD' },
      { account: 'Assets:B', amount: null },
    ],
  });
  assert.deepStrictEqual(
    L.balances(j).map((r) => r.account),
    ['Assets:A', 'Assets:B'],
  );
});

test('query and register', () => {
  const j = L.parseLedger(SAMPLE);
  const accounts = (q) => L.register(j, q).map((r) => r.account);
  assert.deepStrictEqual(accounts('account:expenses:food'), [
    'Expenses:Food:Coffee',
    'Expenses:Food:Groceries',
  ]);
  assert.deepStrictEqual(accounts('account:Expenses:Foo'), []);
  assert.deepStrictEqual(accounts('account:assets date:2026-01-06..2026-01-31'), [
    'Assets:Bank',
    'Assets:Bank',
  ]);
  assert.deepStrictEqual(accounts('date:..2026-01-05'), ['Expenses:Food:Coffee', 'Assets:Cash']);
  assert.deepStrictEqual(accounts('date:2026-02-01'), ['Expenses:Travel', 'Assets:Bank:Euro']);
  assert.deepStrictEqual(accounts('amount:>100 account:expenses'), ['Expenses:Travel']);
  assert.deepStrictEqual(accounts('amount:<5'), ['Expenses:Food:Coffee', 'Assets:Cash']);
  assert.deepStrictEqual(accounts('amount:>=1000'), ['Assets:Bank', 'Income:Salary']);
  assert.deepStrictEqual(accounts('memo:COFFEE'), ['Expenses:Food:Coffee', 'Assets:Cash']);
  assert.deepStrictEqual(accounts('groc'), ['Expenses:Food:Groceries', 'Assets:Bank']);
  assert.strictEqual(L.register(j).length, 8);
  assert.throws(() => L.parseQuery('payee:x'), isLedgerError('Unknown query field: payee'));

  const bank = L.register(j, 'account:assets:bank');
  assert.deepStrictEqual(
    bank.map((r) => [r.date, r.memo, r.amount.cents, r.amount.currency, r.running]),
    [
      ['2026-01-06', 'Pay', 100000, 'USD', 100000],
      ['2026-01-20', 'Groceries', -6225, 'USD', 93775],
      ['2026-02-01', 'Trip deposit', -20000, 'EUR', -20000],
    ],
  );
  const pred = L.parseQuery('account:income');
  assert.strictEqual(
    pred(
      { account: 'Income:Salary', amount: { cents: -1, currency: 'USD' } },
      { date: '2026-01-01', memo: '' },
    ),
    true,
  );
});

test('reports: income statement by currency and date range', () => {
  const j = L.parseLedger(SAMPLE);
  assert.deepStrictEqual(L.incomeStatement(j), {
    USD: { income: 100000, expenses: 6675, net: 93325 },
    EUR: { income: 0, expenses: 20000, net: -20000 },
  });
  assert.deepStrictEqual(L.incomeStatement(j, { from: '2026-01-06', to: '2026-01-31' }), {
    USD: { income: 100000, expenses: 6225, net: 93775 },
  });
  assert.deepStrictEqual(L.incomeStatement(j, { from: '2026-03-01' }), {});
});

test('ledger files: errors carry the right line', () => {
  const at = (text, message, line) =>
    assert.throws(
      () => L.parseLedger(text),
      (err) => isLedgerError(message)(err) && err.line === line,
      `${message} @ ${line}`,
    );
  at('2026-01-01 a\n    Expenses:X  1.234 USD\n    Assets:Y\n', 'Invalid amount: 1.234 USD', 2);
  at('2026-01-01 a\n    Expenses:X  1.00 USD\n    Bank:Y\n', 'Invalid account: Bank:Y', 3);
  at(
    '; c\n\n2026-13-01 a\n    Expenses:X  1.00 USD\n    Assets:Y\n',
    'Invalid date: 2026-13-01',
    3,
  );
  at(
    '2026-01-01 ok\n  Expenses:X  1.00 USD\n  Assets:Y\n\n2026-01-02 bad\n  Expenses:X  1.00 USD\n  Assets:Y  -2.00 USD\n',
    'Unbalanced transaction',
    5,
  );
  at('2026-01-01 lonely\n    Expenses:X  1.00 USD\n', 'A transaction needs at least 2 postings', 1);
  at('    Expenses:X  1.00 USD\n', 'Posting outside a transaction', 1);
});

test('ledger files: parse details and round trip', () => {
  const j = L.parseLedger('2026-04-01\n    Expenses:X  1.00 USD\n    Assets:Y\n');
  assert.strictEqual(j.transactions()[0].memo, '');
  const original = L.parseLedger(SAMPLE);
  const text = L.formatLedger(original);
  assert.ok(!/\n {2,}Assets:Cash\s*\n/.test(text), 'every amount is written explicitly');
  const back = L.parseLedger(text);
  const plain = (jj) =>
    jj.transactions().map(({ date, memo, postings }) => ({ date, memo, postings }));
  assert.deepStrictEqual(plain(back), plain(original));
});

test('CLI: balance and register', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-cli-'));
  const file = join(dir, 'books.ledger');
  writeFileSync(file, SAMPLE);
  const cli = join(process.cwd(), 'cli.js');
  assert.ok(existsSync(cli), 'cli.js exists');
  const run = (...args) => execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  assert.deepStrictEqual(run('balance', file, '--depth', '1').trim().split('\n'), [
    'Assets  -200.00 EUR',
    'Assets  933.25 USD',
    'Expenses  200.00 EUR',
    'Expenses  66.75 USD',
    'Income  -1,000.00 USD',
  ]);
  assert.deepStrictEqual(
    run('register', file, 'account:assets:bank', 'date:..2026-01-31').trim().split('\n'),
    [
      '2026-01-06  Pay  Assets:Bank  1,000.00 USD  1,000.00 USD',
      '2026-01-20  Groceries  Assets:Bank  -62.25 USD  937.75 USD',
    ],
  );
});

test('CLI: errors and usage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-cli-'));
  const bad = join(dir, 'bad.ledger');
  writeFileSync(bad, '2026-01-01 a\n    Expenses:X  1.00 USD\n    Assets:Y  -2.00 USD\n');
  const cli = join(process.cwd(), 'cli.js');
  const r = spawnSync(process.execPath, [cli, 'balance', bad], { encoding: 'utf8' });
  assert.strictEqual(r.status, 1);
  assert.strictEqual(r.stderr.trim(), 'error: Unbalanced transaction (line 1)');
  const u = spawnSync(process.execPath, [cli, 'frobnicate', bad], { encoding: 'utf8' });
  assert.strictEqual(u.status, 2);
  assert.ok(u.stderr.trim().length > 0);
  assert.strictEqual(spawnSync(process.execPath, [cli], { encoding: 'utf8' }).status, 2);
});
