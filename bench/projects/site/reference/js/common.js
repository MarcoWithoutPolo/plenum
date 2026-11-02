// Shared page chrome: theme, cart count, product data and small DOM helpers.
import { itemCount, loadCart, saveCart, STORAGE_KEY } from '../src/cart.js';
import { formatPrice, imageFor, ROAST_LABELS } from '../src/catalog.js';
import { resolveTheme, THEME_KEY, toggled } from '../src/theme.js';

const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

function storedTheme() {
  try {
    return localStorage.getItem(THEME_KEY);
  } catch {
    return null;
  }
}

/** The user's choice ('light' or 'dark'), or null to follow the system. */
let override = storedTheme();

function applyTheme() {
  const theme = resolveTheme(override, systemDark.matches);
  document.documentElement.dataset.theme = theme;
  for (const b of document.querySelectorAll('[data-theme-toggle]'))
    b.setAttribute('aria-pressed', String(theme === 'dark'));
}

function initTheme() {
  applyTheme();
  systemDark.addEventListener('change', applyTheme);
  for (const b of document.querySelectorAll('[data-theme-toggle]')) {
    b.addEventListener('click', () => {
      override = toggled(document.documentElement.dataset.theme);
      try {
        localStorage.setItem(THEME_KEY, override);
      } catch {
        // Storage blocked: the choice lasts for this page view.
      }
      applyTheme();
    });
  }
}

/* ---------- Cart ---------- */

export function getCart() {
  return loadCart(localStorage);
}

/** Save a new cart and refresh the header count. */
export function setCart(cart, { bump = false } = {}) {
  saveCart(localStorage, cart);
  renderCount(bump);
}

function renderCount(bump = false) {
  const n = itemCount(getCart());
  for (const el of document.querySelectorAll('[data-cart-count]')) {
    el.textContent = String(n);
    if (bump) {
      el.classList.remove('bump');
      void el.offsetWidth;
      el.classList.add('bump');
    }
  }
  for (const el of document.querySelectorAll('[data-cart-label]'))
    el.textContent = n === 1 ? 'item' : 'items';
}

/* ---------- Products ---------- */

let products;
export function loadProducts() {
  products ??= fetch(new URL('../data/products.json', import.meta.url)).then((r) => {
    if (!r.ok) throw new Error(`Could not load products (${r.status})`);
    return r.json();
  });
  return products;
}

/* ---------- DOM helpers ---------- */

/** Create an element: el('p', { class: 'x', dataset: { id: 1 } }, 'text', child). */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  node.append(...children.flat().filter((c) => c !== undefined && c !== null && c !== false));
  return node;
}

export function productCard(p, { headingLevel = 'h3' } = {}) {
  return el(
    'li',
    {},
    el(
      'article',
      { class: 'card', dataset: { product: '', id: p.id, price: p.price, roast: p.roast } },
      el(
        'div',
        { class: 'card-media' },
        el('img', {
          src: imageFor(p),
          alt: `Bag of ${p.name}, ${ROAST_LABELS[p.roast].toLowerCase()} coffee`,
          width: 400,
          height: 400,
          loading: 'lazy',
        }),
      ),
      el(
        'div',
        { class: 'card-body' },
        el(
          headingLevel,
          {},
          el('a', { href: `product.html?id=${encodeURIComponent(p.id)}` }, p.name),
        ),
        el('p', { class: 'card-meta' }, `${p.origin} · ${p.notes.slice(0, 2).join(', ')}`),
        el(
          'div',
          { class: 'card-foot' },
          el('span', { class: 'price' }, formatPrice(p.price)),
          el('span', { class: 'badge' }, ROAST_LABELS[p.roast]),
        ),
      ),
    ),
  );
}

/** Show a friendly message when something fails, instead of an empty page. */
export function showError(container, message) {
  container.replaceChildren(el('div', { class: 'empty', role: 'alert' }, el('p', {}, message)));
}

initTheme();
renderCount();
// Another tab changed the cart or the theme.
window.addEventListener('storage', (e) => {
  if (e.key === STORAGE_KEY || e.key === null) renderCount();
  if (e.key === THEME_KEY || e.key === null) {
    override = storedTheme();
    applyTheme();
  }
});
// Coming back through the back/forward cache: the cart may have changed meanwhile.
window.addEventListener('pageshow', (e) => e.persisted && renderCount());
