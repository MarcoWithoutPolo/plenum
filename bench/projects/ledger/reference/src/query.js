const { LedgerError } = require('./errors');

const memo = (text) => (_p, t) => t.memo.toLowerCase().includes(text.toLowerCase());

const COMPARE = {
  '>': (a, n) => a > n,
  '>=': (a, n) => a >= n,
  '<': (a, n) => a < n,
  '<=': (a, n) => a <= n,
  '=': (a, n) => a === n,
};

function term(token) {
  const i = token.indexOf(':');
  if (i <= 0) return memo(token);
  const field = token.slice(0, i);
  const value = token.slice(i + 1);
  switch (field) {
    case 'account': {
      const want = value.toLowerCase();
      return (p) => {
        const a = p.account.toLowerCase();
        return a === want || a.startsWith(`${want}:`);
      };
    }
    case 'date': {
      const [from, to] = value.includes('..') ? value.split('..') : [value, value];
      return (_p, t) => (!from || t.date >= from) && (!to || t.date <= to);
    }
    case 'amount': {
      const m = /^(>=|<=|>|<|=)(\d+(?:\.\d+)?)$/.exec(value);
      if (!m) throw new LedgerError(`Invalid query: ${token}`);
      const n = Math.round(Number(m[2]) * 100);
      return (p) => COMPARE[m[1]](Math.abs(p.amount.cents), n);
    }
    case 'memo':
      return memo(value);
    default:
      throw new LedgerError(`Unknown query field: ${field}`);
  }
}

function parseQuery(text = '') {
  const terms = String(text).split(/\s+/).filter(Boolean).map(term);
  return (posting, txn) => terms.every((f) => f(posting, txn));
}

module.exports = { parseQuery };
