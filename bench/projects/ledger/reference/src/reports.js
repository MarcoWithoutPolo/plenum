const { parseQuery } = require('./query');

const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function balances(journal, { asOf, depth } = {}) {
  const totals = new Map();
  for (const t of journal.transactions()) {
    if (asOf && t.date > asOf) continue;
    for (const p of t.postings) {
      const parts = p.account.split(':');
      for (let n = 1; n <= parts.length; n++) {
        const key = `${parts.slice(0, n).join(':')}\u0000${p.amount.currency}`;
        totals.set(key, (totals.get(key) ?? 0) + p.amount.cents);
      }
    }
  }
  return [...totals]
    .map(([key, cents]) => {
      const [account, currency] = key.split('\u0000');
      return { account, currency, cents };
    })
    .filter((r) => r.cents !== 0 && (!depth || r.account.split(':').length <= depth))
    .sort((a, b) => order(a.account, b.account) || order(a.currency, b.currency));
}

function register(journal, query = '') {
  const match = parseQuery(query);
  const running = new Map();
  const rows = [];
  for (const t of journal.transactions()) {
    for (const p of t.postings) {
      if (!match(p, t)) continue;
      const total = (running.get(p.amount.currency) ?? 0) + p.amount.cents;
      running.set(p.amount.currency, total);
      rows.push({
        date: t.date,
        memo: t.memo,
        account: p.account,
        amount: p.amount,
        running: total,
      });
    }
  }
  return rows;
}

function incomeStatement(journal, { from, to } = {}) {
  const out = {};
  for (const t of journal.transactions()) {
    if ((from && t.date < from) || (to && t.date > to)) continue;
    for (const p of t.postings) {
      const root = p.account.split(':')[0];
      if (root !== 'Income' && root !== 'Expenses') continue;
      const row = (out[p.amount.currency] ??= { income: 0, expenses: 0, net: 0 });
      if (root === 'Income') row.income -= p.amount.cents;
      else row.expenses += p.amount.cents;
      row.net = row.income - row.expenses;
    }
  }
  return out;
}

module.exports = { balances, register, incomeStatement };
