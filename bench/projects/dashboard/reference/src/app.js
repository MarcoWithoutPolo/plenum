import { byCategory, byMonth, filterRows, parseCsv, summarize, toCsv } from './data.js';
import { barChart } from './charts.js';

const $ = (id) => document.getElementById(id);
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const count = new Intl.NumberFormat('en-US');
let rows = [];

const current = () => ({
  region: $('region').value,
  category: $('category').value,
  from: $('from').value,
  to: $('to').value,
});

function fillOptions(select, values) {
  for (const v of [...new Set(values)].sort()) select.append(new Option(v, v));
}

function render() {
  const shown = filterRows(rows, current());
  const t = summarize(shown);
  document.querySelector('[data-total-revenue]').textContent = money.format(t.revenue);
  document.querySelector('[data-total-units]').textContent = count.format(t.units);
  document.querySelector('[data-total-orders]').textContent = count.format(t.orders);
  barChart(
    document.querySelector('[data-chart="month"]'),
    byMonth(shown).map((m) => ({ label: m.month, value: m.revenue })),
    'Revenue by month',
  );
  barChart(
    document.querySelector('[data-chart="category"]'),
    byCategory(shown).map((c) => ({ label: c.category, value: c.revenue })),
    'Revenue by category',
  );
}

function exportCsv() {
  const blob = new Blob([toCsv(filterRows(rows, current()))], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'sales-filtered.csv';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function main() {
  const res = await fetch('data/sales.csv');
  if (!res.ok) throw new Error(`Could not load data/sales.csv (${res.status})`);
  rows = parseCsv(await res.text());
  fillOptions(
    $('region'),
    rows.map((r) => r.region),
  );
  fillOptions(
    $('category'),
    rows.map((r) => r.category),
  );
  for (const id of ['region', 'category', 'from', 'to']) {
    $(id).addEventListener('input', render);
    $(id).addEventListener('change', render);
  }
  $('filters').addEventListener('submit', (e) => e.preventDefault());
  $('export').addEventListener('click', exportCsv);
  render();
}

main().catch((e) => {
  $('status').textContent = e.message;
});
