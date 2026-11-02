// Shared helpers for the hidden dashboard checks: an independent CSV reader and the expected filter.
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

function readCsv(text) {
  const records = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.length > 1 || row[0] !== '') records.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    records.push(row);
  }
  const [header, ...rest] = records;
  return rest.map((f) => {
    const o = {};
    header.forEach((h, j) => {
      o[h] = h === 'units' || h === 'revenue' ? Number(f[j]) : f[j];
    });
    return o;
  });
}

const canonical = () => readCsv(readFileSync(join(__dirname, 'sales.csv'), 'utf8'));
const cents = (x) => Math.round(x * 100) / 100;
const set = (v) => v !== undefined && v !== null && v !== '';
const filter = (rows, f) =>
  rows.filter(
    (r) =>
      (!set(f.region) || r.region === f.region) &&
      (!set(f.category) || r.category === f.category) &&
      (!set(f.from) || r.date >= f.from) &&
      (!set(f.to) || r.date <= f.to),
  );
const totals = (rows) => ({
  revenue: cents(rows.reduce((n, r) => n + r.revenue, 0)),
  units: rows.reduce((n, r) => n + r.units, 0),
  orders: rows.length,
});

module.exports = { readCsv, canonical, cents, filter, totals };
