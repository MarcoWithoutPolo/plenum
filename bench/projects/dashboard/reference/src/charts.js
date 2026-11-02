// A small responsive SVG bar chart.
const NS = 'http://www.w3.org/2000/svg';
const short = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

function el(name, attrs = {}, text) {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Draw vertical bars for `items` ({ label, value }) into `host`, replacing what was there. */
export function barChart(host, items, title) {
  const W = 600;
  const H = 300;
  const pad = { top: 16, right: 8, bottom: 48, left: 48 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': title });
  const max = Math.max(0, ...items.map((i) => i.value));
  svg.append(
    el('line', {
      class: 'axis',
      x1: pad.left,
      x2: W - pad.right,
      y1: H - pad.bottom,
      y2: H - pad.bottom,
    }),
  );
  if (!items.length || max === 0) {
    svg.append(el('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle' }, 'No orders match'));
  } else {
    for (const f of [0, 0.5, 1]) {
      const y = pad.top + plotH * (1 - f);
      svg.append(
        el('text', { x: pad.left - 6, y: y + 4, 'text-anchor': 'end' }, short.format(max * f)),
      );
    }
    const slot = plotW / items.length;
    const bw = Math.max(2, slot * 0.7);
    items.forEach((it, i) => {
      const h = (it.value / max) * plotH;
      const x = pad.left + i * slot + (slot - bw) / 2;
      const bar = el('rect', { class: 'bar', x, y: pad.top + plotH - h, width: bw, height: h });
      bar.append(el('title', {}, `${it.label}: ${it.value.toFixed(2)}`));
      svg.append(bar);
      const label = items.length > 6 ? it.label.slice(5) : it.label;
      svg.append(
        el('text', { x: x + bw / 2, y: H - pad.bottom + 16, 'text-anchor': 'middle' }, label),
      );
    });
  }
  host.replaceChildren(svg);
}
