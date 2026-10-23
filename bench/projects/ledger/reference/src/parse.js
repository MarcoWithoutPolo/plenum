const { LedgerError } = require('./errors');
const { Journal, checkAccount } = require('./journal');
const { parseAmount, formatAmount } = require('./money');

const POSTING = /^[ \t]+(.+?)(?:(?:\t| {2,})[ \t]*(.+?))?[ \t]*$/;

function parseLedger(text) {
  const journal = new Journal();
  let current = null;
  const flush = () => {
    if (!current) return;
    try {
      journal.post(current);
    } catch (err) {
      if (err instanceof LedgerError && err.line === undefined) err.line = current.line;
      throw err;
    }
    current = null;
  };
  String(text)
    .split(/\r?\n/)
    .forEach((raw, i) => {
      const line = i + 1;
      const trimmed = raw.trim();
      if (trimmed === '' || trimmed.startsWith(';')) return;
      if (/^[ \t]/.test(raw)) {
        if (!current) throw new LedgerError('Posting outside a transaction', line);
        const [, account, amount] = POSTING.exec(raw);
        try {
          checkAccount(account);
          current.postings.push({
            account,
            amount: amount === undefined ? null : parseAmount(amount),
          });
        } catch (err) {
          if (err instanceof LedgerError) err.line = line;
          throw err;
        }
        return;
      }
      flush();
      const space = raw.indexOf(' ');
      current = {
        line,
        date: space < 0 ? raw : raw.slice(0, space),
        memo: space < 0 ? '' : raw.slice(space + 1).trim(),
        postings: [],
      };
    });
  flush();
  return journal;
}

function formatLedger(journal) {
  const blocks = journal
    .transactions()
    .map((t) =>
      [
        t.memo ? `${t.date} ${t.memo}` : t.date,
        ...t.postings.map((p) => `    ${p.account}  ${formatAmount(p.amount)}`),
      ].join('\n'),
    );
  return `${blocks.join('\n\n')}\n`;
}

module.exports = { parseLedger, formatLedger };
