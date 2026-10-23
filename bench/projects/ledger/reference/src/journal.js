const { LedgerError } = require('./errors');
const { parseAmount } = require('./money');

const ROOTS = new Set(['Assets', 'Liabilities', 'Equity', 'Income', 'Expenses']);

function checkDate(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date));
  const d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (
    !m ||
    d.getUTCFullYear() !== +m[1] ||
    d.getUTCMonth() !== +m[2] - 1 ||
    d.getUTCDate() !== +m[3]
  ) {
    throw new LedgerError(`Invalid date: ${date}`);
  }
  return date;
}

function checkAccount(account) {
  const parts = String(account).split(':');
  if (!ROOTS.has(parts[0]) || parts.some((p) => p.trim() === '' || p !== p.trim())) {
    throw new LedgerError(`Invalid account: ${account}`);
  }
  return account;
}

function toAmount(amount) {
  if (amount === null || amount === undefined) return null;
  if (typeof amount === 'string') return parseAmount(amount);
  if (Number.isInteger(amount.cents) && /^[A-Z]{3}$/.test(amount.currency)) {
    return { cents: amount.cents, currency: amount.currency };
  }
  throw new LedgerError(`Invalid amount: ${JSON.stringify(amount)}`);
}

class Journal {
  #txns = [];

  post({ date, memo = '', postings = [] }) {
    checkDate(date);
    if (postings.length < 2) throw new LedgerError('A transaction needs at least 2 postings');
    const lines = postings.map((p) => ({
      account: checkAccount(p.account),
      amount: toAmount(p.amount),
    }));
    const open = lines.filter((p) => p.amount === null);
    if (open.length > 1) throw new LedgerError('Only one posting may omit its amount');
    const sums = new Map();
    for (const p of lines) {
      if (p.amount)
        sums.set(p.amount.currency, (sums.get(p.amount.currency) ?? 0) + p.amount.cents);
    }
    if (open.length === 1) {
      if (sums.size !== 1) throw new LedgerError('Unbalanced transaction');
      const [[currency, sum]] = [...sums];
      open[0].amount = { cents: -sum, currency };
      sums.set(currency, 0);
    }
    if ([...sums.values()].some((v) => v !== 0)) throw new LedgerError('Unbalanced transaction');
    const txn = { id: this.#txns.length + 1, date, memo, postings: lines };
    this.#txns.push(txn);
    return txn;
  }

  transactions() {
    return [...this.#txns].sort((a, b) =>
      a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id,
    );
  }
}

module.exports = { Journal, checkAccount, checkDate };
