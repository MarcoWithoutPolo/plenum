import { lines, MAX_QTY, removeItem, setQuantity, shippingFor, subtotal } from '../src/cart.js';
import { formatPrice, imageFor } from '../src/catalog.js';
import { el, getCart, loadProducts, setCart, showError } from './common.js';

const root = document.querySelector('#cart-root');
const announce = document.querySelector('[data-cart-announce]');
let products = [];

function summary(cart) {
  const sub = subtotal(cart, products);
  const ship = shippingFor(sub);
  return el(
    'aside',
    { class: 'summary', 'aria-labelledby': 'summary-title' },
    el('h2', { id: 'summary-title' }, 'Order summary'),
    el(
      'dl',
      {},
      el('dt', {}, 'Subtotal'),
      el('dd', { dataset: { cartSubtotal: '' } }, formatPrice(sub)),
      el('dt', {}, 'Shipping'),
      el('dd', {}, ship ? formatPrice(ship) : 'Free'),
      el('dt', { class: 'total' }, 'Total'),
      el('dd', { class: 'total' }, formatPrice(sub + ship)),
    ),
    el('a', { class: 'btn btn-primary', href: 'contact.html?topic=order' }, 'Request an order'),
    el(
      'p',
      { class: 'hint' },
      ship ? `Add ${formatPrice(40 - sub)} more for free shipping.` : 'Your order ships free.',
    ),
  );
}

function update(cart, message, focusId) {
  setCart(cart);
  render(focusId);
  if (message) announce.textContent = message;
}

function item(line) {
  const { product: p, qty } = line;
  const qtyId = `qty-${p.id}`;
  const input = el('input', {
    id: qtyId,
    type: 'number',
    inputmode: 'numeric',
    min: 1,
    max: MAX_QTY,
    value: qty,
    'aria-label': `Quantity for ${p.name}`,
    onchange: (e) => {
      const n = Math.floor(Number(e.target.value));
      if (!Number.isFinite(n) || e.target.value === '') return render();
      update(setQuantity(getCart(), p.id, n), `${p.name}: quantity ${n}.`, qtyId);
    },
  });
  const step = (delta, label, text) =>
    el(
      'button',
      {
        type: 'button',
        'aria-label': `${label} ${p.name}`,
        disabled: delta < 0 ? qty <= 1 : qty >= MAX_QTY,
        onclick: () =>
          update(
            setQuantity(getCart(), p.id, qty + delta),
            `${p.name}: quantity ${qty + delta}.`,
            qtyId,
          ),
      },
      text,
    );
  return el(
    'li',
    { class: 'cart-item', dataset: { cartItem: '', id: p.id } },
    el('img', { src: imageFor(p), alt: `Bag of ${p.name}`, width: 96, height: 96 }),
    el(
      'div',
      {},
      el('h2', {}, el('a', { href: `product.html?id=${encodeURIComponent(p.id)}` }, p.name)),
      el('p', { class: 'unit' }, `${formatPrice(p.price)} each · 340 g`),
    ),
    el('p', { class: 'line-total', dataset: { lineTotal: '' } }, formatPrice(line.total)),
    el(
      'div',
      { class: 'cart-controls' },
      el('div', { class: 'stepper' }, step(-1, 'One fewer', '−'), input, step(1, 'One more', '+')),
      el(
        'button',
        {
          type: 'button',
          class: 'link-btn',
          'aria-label': `Remove ${p.name}`,
          onclick: () => update(removeItem(getCart(), p.id), `${p.name} removed from your cart.`),
        },
        'Remove',
      ),
    ),
  );
}

function render(focusId) {
  const cart = getCart();
  const ls = lines(cart, products);
  if (!ls.length) {
    root.replaceChildren(
      el(
        'div',
        { class: 'empty', dataset: { cartEmpty: '' } },
        el('p', {}, 'Your cart is empty. Fresh coffee is a few clicks away.'),
        el('a', { class: 'btn btn-primary', href: 'shop.html' }, 'Shop coffee'),
      ),
    );
    return;
  }
  root.replaceChildren(
    el(
      'div',
      { class: 'cart-layout' },
      el('ul', { class: 'cart-list', 'aria-label': 'Items in your cart' }, ls.map(item)),
      summary(cart),
    ),
  );
  if (focusId) document.getElementById(focusId)?.focus();
}

loadProducts()
  .then((data) => {
    products = data;
    render();
    // The cart changed in another tab.
    window.addEventListener('storage', () => render());
  })
  .catch(() => showError(root, 'Your cart could not be loaded. Please try again in a moment.'));
