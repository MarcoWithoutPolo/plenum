import { addItem, MAX_QTY } from '../src/cart.js';
import { findProduct, formatPrice, imageFor, related, ROAST_LABELS } from '../src/catalog.js';
import { el, getCart, loadProducts, productCard, setCart, showError } from './common.js';

const root = document.querySelector('#product-root');
const id = new URLSearchParams(location.search).get('id');

function notFound() {
  document.title = 'Coffee not found · Northwind Roasters';
  root.replaceChildren(
    el(
      'div',
      { class: 'page-head' },
      el('h1', {}, 'Product not found'),
      el(
        'p',
        { class: 'lede' },
        'We couldn’t find that coffee. It may have sold out for the season.',
      ),
      el('a', { class: 'btn btn-primary', href: 'shop.html' }, 'Browse all coffees'),
    ),
  );
}

function render(p, products) {
  document.title = `${p.name} · Northwind Roasters`;
  const qty = el('input', {
    id: 'qty',
    type: 'number',
    inputmode: 'numeric',
    min: 1,
    max: MAX_QTY,
    value: 1,
    name: 'qty',
  });
  const status = el('p', { class: 'status', role: 'status' });
  let timer;
  const form = el(
    'form',
    {
      class: 'buy',
      onsubmit: (e) => {
        e.preventDefault();
        const n = Math.min(MAX_QTY, Math.max(1, Math.floor(Number(qty.value) || 1)));
        qty.value = String(n);
        setCart(addItem(getCart(), p.id, n), { bump: true });
        status.textContent = `Added ${n} × ${p.name} to your cart.`;
        clearTimeout(timer);
        timer = setTimeout(() => (status.textContent = ''), 5000);
      },
    },
    el('div', { class: 'field' }, el('label', { for: 'qty' }, 'Quantity'), qty),
    el('button', { type: 'submit', class: 'btn btn-primary' }, 'Add to cart'),
  );

  root.replaceChildren(
    el(
      'nav',
      { class: 'crumbs', 'aria-label': 'Breadcrumb' },
      el(
        'ol',
        {},
        el('li', {}, el('a', { href: 'index.html' }, 'Home')),
        el('li', {}, el('a', { href: 'shop.html' }, 'Shop')),
        el('li', {}, el('span', { 'aria-current': 'page' }, p.name)),
      ),
    ),
    el(
      'article',
      { class: 'product', dataset: { productDetail: '', id: p.id } },
      el(
        'div',
        { class: 'product-media' },
        el('img', {
          src: imageFor(p),
          alt: `Bag of ${p.name}, ${ROAST_LABELS[p.roast].toLowerCase()} coffee from ${p.origin}`,
          width: 400,
          height: 400,
        }),
      ),
      el(
        'div',
        { class: 'product-info' },
        el('span', { class: 'eyebrow' }, ROAST_LABELS[p.roast]),
        el('h1', {}, p.name),
        el('p', { class: 'price', dataset: { price: p.price } }, formatPrice(p.price)),
        el(
          'ul',
          { class: 'notes', 'aria-label': 'Tasting notes' },
          p.notes.map((n) => el('li', { class: 'badge' }, n)),
        ),
        el('p', { class: 'lede' }, p.description),
        form,
        status,
        el(
          'dl',
          { class: 'facts' },
          el('dt', {}, 'Origin'),
          el('dd', {}, p.origin),
          el('dt', {}, 'Process'),
          el('dd', {}, p.process),
          el('dt', {}, 'Roast'),
          el('dd', {}, ROAST_LABELS[p.roast]),
          el('dt', {}, 'Bag'),
          el('dd', {}, '340 g whole bean, roasted to order'),
        ),
      ),
    ),
    el(
      'section',
      { class: 'section', 'aria-labelledby': 'related-title' },
      el(
        'div',
        { class: 'section-head' },
        el('h2', { id: 'related-title' }, 'You might also like'),
      ),
      el(
        'ul',
        { class: 'product-grid' },
        related(products, p.id, 4).map((r) => productCard(r)),
      ),
    ),
  );
}

loadProducts()
  .then((products) => {
    const p = id && findProduct(products, id);
    if (p) render(p, products);
    else notFound();
  })
  .catch(() => showError(root, 'This coffee could not be loaded. Please try again in a moment.'));
