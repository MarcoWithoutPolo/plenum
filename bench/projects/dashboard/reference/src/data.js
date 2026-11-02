// Pure data logic for the sales dashboard. No DOM, no I/O.

const COLUMNS = ['date', 'region', 'category', 'product', 'units', 'revenue'];
const NUMERIC = new Set(['units', 'revenue']);

const cents = (x) => Math.round(x * 100) / 100;

/** Split CSV text into records of raw string fields (RFC 4180, plus \n line endings). */
function records(text) {
  const out = [];
  let row = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const endRow = () => {
    row.push(field);
    field = '';
    if (!(row.length === 1 && row[0] === '')) out.push(row);
    row = [];
  };
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else field += c;
      i++;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') endRow();
    else if (c === '\r') {
      if (text[i + 1] === '\n') i++;
      endRow();
    } else field += c;
    i++;
  }
  if (field !== '' || row.length) endRow();
  return out;
}

export function parseCsv(text) {
  const [header, ...lines] = records(String(text).replace(/^﻿/, ''));
  if (!header) return [];
  const keys = header.map((h) => h.trim());
  return lines.map((fields) => {
    const obj = {};
    keys.forEach((k, j) => {
      const v = fields[j] ?? '';
      obj[k] = NUMERIC.has(k) ? Number(v) : v;
    });
    return obj;
  });
}

const set = (v) => v !== undefined && v !== null && v !== '';

export function filterRows(rows, filters = {}) {
  const { region, category, from, to } = filters ?? {};
  return rows.filter(
    (r) =>
      (!set(region) || r.region === region) &&
      (!set(category) || r.category === category) &&
      (!set(from) || r.date >= from) &&
      (!set(to) || r.date <= to),
  );
}

export function summarize(rows) {
  let revenue = 0;
  let units = 0;
  for (const r of rows) {
    revenue += r.revenue;
    units += r.units;
  }
  return { revenue: cents(revenue), units, orders: rows.length };
}

function totalsBy(rows, keyOf) {
  const m = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    m.set(k, (m.get(k) ?? 0) + r.revenue);
  }
  return m;
}

export function byMonth(rows) {
  return [...totalsBy(rows, (r) => r.date.slice(0, 7))]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([month, revenue]) => ({ month, revenue: cents(revenue) }));
}

export function byCategory(rows) {
  return [...totalsBy(rows, (r) => r.category)]
    .map(([category, revenue]) => ({ category, revenue: cents(revenue) }))
    .sort(
      (a, b) =>
        b.revenue - a.revenue || (a.category < b.category ? -1 : a.category > b.category ? 1 : 0),
    );
}

const quote = (v) => {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(rows) {
  const lines = [COLUMNS.join(','), ...rows.map((r) => COLUMNS.map((k) => quote(r[k])).join(','))];
  return `${lines.join('\n')}\n`;
}
