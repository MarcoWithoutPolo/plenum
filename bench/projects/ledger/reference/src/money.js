const { LedgerError } = require('./errors');

const AMOUNT = /^(-)?(\$)?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(?: ([A-Z]{3}))?$/;

function parseAmount(text) {
  const m = AMOUNT.exec(String(text).trim());
  if (!m) throw new LedgerError(`Invalid amount: ${text}`);
  const [, minus, dollar, whole, frac = '', code] = m;
  if (dollar ? code : !code) throw new LedgerError(`Invalid amount: ${text}`);
  const cents = Number(whole.replace(/,/g, '')) * 100 + Number(frac.padEnd(2, '0'));
  return { cents: minus ? -cents : cents, currency: dollar ? 'USD' : code };
}

function formatAmount({ cents, currency }) {
  const abs = Math.abs(cents);
  const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = String(abs % 100).padStart(2, '0');
  return `${cents < 0 ? '-' : ''}${whole}.${frac} ${currency}`;
}

function allocate(cents, ratios) {
  const total = ratios.reduce((a, b) => a + b, 0);
  const shares = ratios.map((r) => Math.trunc((cents * r) / total));
  let left = cents - shares.reduce((a, b) => a + b, 0);
  const step = Math.sign(left);
  for (let i = 0; left !== 0; i = (i + 1) % shares.length) {
    shares[i] += step;
    left -= step;
  }
  return shares;
}

module.exports = { parseAmount, formatAmount, allocate };
