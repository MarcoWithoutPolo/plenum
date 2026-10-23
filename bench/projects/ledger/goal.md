Build `ledger`, a small double-entry accounting toolkit, in this empty repository. Plain Node.js, CommonJS, no
dependencies. Put the code in `src/`, one module per area below. `index.js` at the root exports
`{ LedgerError, parseAmount, formatAmount, allocate, Journal, balances, register, incomeStatement, parseQuery, parseLedger, formatLedger }`.
Write tests for every module. `npm test` runs them with `node --test`.

**Errors**

- `LedgerError extends Error`. It has an optional `line` property (a 1-based line number) when it comes from parsing a file.

**Money**

Amounts are `{ cents, currency }`: `cents` is an integer in minor units, and `currency` is 3 uppercase letters. Never use
floating point for money.

- `parseAmount(text)` accepts:
  - an optional leading `-`;
  - digits with optional thousands commas;
  - an optional `.` followed by 1 or 2 digits;
  - then a space and the currency, as in `"-1,234.5 EUR"` → `{ cents: -123450, currency: 'EUR' }`.

  `"$12.50"` and `"-$3"` mean USD. Anything else, including more than 2 decimals or misplaced commas, throws
  `LedgerError('Invalid amount: <text>')`.

- `formatAmount({ cents, currency })` → `"1,234.50 EUR"` or `"-3.00 USD"`: always 2 decimals, with thousands commas.
- `allocate(cents, ratios)` splits an integer amount by positive ratios into integers that sum exactly to `cents`.
  Each share is floored toward zero, and the cents left over go one each to the first shares.
  - `allocate(100, [1, 1, 1])` → `[34, 33, 33]`
  - `allocate(-100, [1, 1, 1])` → `[-34, -33, -33]`
  - `allocate(5, [3, 1])` → `[4, 1]`

**Journal**

- `new Journal()`.
- `post({ date, memo, postings })` adds a transaction and returns it as `{ id, date, memo, postings }`. `id` counts
  from 1. Each returned posting is `{ account, amount: { cents, currency } }`.
- `date` is a real calendar date written `YYYY-MM-DD`. Otherwise it throws `LedgerError('Invalid date: <date>')`.
- Each posting is `{ account, amount }`. The amount is a string for `parseAmount`, an amount object, or `null`.
- An account is colon-separated, non-empty segments, and its first segment is one of `Assets`, `Liabilities`,
  `Equity`, `Income` or `Expenses`. Otherwise it throws `LedgerError('Invalid account: <account>')`.
- A transaction has at least 2 postings, or it throws `LedgerError('A transaction needs at least 2 postings')`.
- At most one posting may have a `null` amount. It gets the amount that balances the rest, which needs the rest to be
  in a single currency. More than one `null` throws `LedgerError('Only one posting may omit its amount')`.
- The postings must sum to zero in every currency, or it throws `LedgerError('Unbalanced transaction')`.
- A transaction that throws is not added.
- `transactions()` returns every transaction sorted by date, then by the order it was posted.

**Reports**

- `balances(journal, { asOf, depth } = {})` returns an array of `{ account, currency, cents }`:
  - one row per account and currency, for every account used and every parent account (`Expenses:Food:Coffee` also
    counts toward `Expenses:Food` and `Expenses`);
  - `asOf` (a date, inclusive) leaves out later transactions;
  - `depth` keeps only accounts with at most that many segments;
  - rows whose total is 0 are left out;
  - sorted by account, then by currency (plain string order).
- `register(journal, query = '')` returns `{ date, memo, account, amount, running }` for each posting the query matches
  (see Query), in `transactions()` order. `running` is the running total in cents of the matched postings in the same
  currency.
- `incomeStatement(journal, { from, to } = {})` covers transactions with dates in the inclusive range (either end
  optional). It returns an object keyed by currency, each value `{ income, expenses, net }` in cents:
  - `income` is the negated sum of the `Income` postings, so earning is positive;
  - `expenses` is the sum of the `Expenses` postings;
  - `net` is `income - expenses`.

  Currencies with neither are left out.

**Query**

`parseQuery(text)` returns a predicate `(posting, transaction) => boolean`. Terms are separated by whitespace, and
every term must match:

- `account:X`: the account is X or below it, by whole segments and ignoring case (`account:expenses:food` matches
  `Expenses:Food` and `Expenses:Food:Coffee`, not `Expenses:Foodstuff`).
- `date:A..B`: inclusive; either end may be left out (`date:..2026-01-31`). `date:A` alone means that one day.
- `amount:>N`, `>=`, `<`, `<=`, `=`: compares the posting's absolute amount in whole units (`amount:>100` means more
  than 100.00).
- `memo:X`, or a bare word: a case-insensitive substring of the transaction memo.
- An empty query matches everything. Any other field throws `LedgerError('Unknown query field: <field>')`.

**Ledger files**

`parseLedger(text)` returns a `Journal`. The format:

```
; a comment line
2026-01-05 Coffee with Sam
    Expenses:Food:Coffee    4.50 USD
    Assets:Cash

2026-01-06 Pay
    Assets:Bank  1,000.00 USD
    Income:Salary  -1,000.00 USD
```

- A transaction starts with a header line at column 0: a date, then a space and the memo. The memo may be empty.
- Postings are indented lines: the account, then two or more spaces or a tab, then the amount. An amount may be left
  out.
- Blank lines and lines starting with `;` are ignored.
- Errors are `LedgerError` with `line` set:
  - a bad amount or account: the line of that posting;
  - a bad date: the header line;
  - unbalanced, or too few postings: the header line;
  - an indented line before any header: `LedgerError('Posting outside a transaction')` on that line.
- `formatLedger(journal)` writes text in this format that `parseLedger` reads back to the same transactions. Write
  every amount explicitly.

**CLI**

`node cli.js <command> <file> [args]`:

- `balance <file> [--depth N]` prints one line per `balances` row: `<account>  <formatted amount>` (two spaces).
- `register <file> [query terms...]` prints one line per `register` row:
  `<date>  <memo>  <account>  <formatted amount>  <formatted running total>` (two spaces between fields).
- On a `LedgerError`, it prints `error: <message>` to stderr, followed by ` (line N)` when there is a line, and exits 1.
- On a missing or unknown command, it prints a usage line to stderr and exits 2.
