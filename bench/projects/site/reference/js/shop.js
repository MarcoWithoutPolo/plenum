import { browse, readOptions } from '../src/catalog.js';
import { el, loadProducts, productCard, showError } from './common.js';

const form = document.querySelector('#filters');
const list = document.querySelector('[data-product-list]');
const count = document.querySelector('[data-result-count]');
const fields = Object.fromEntries(
  ['roast', 'price', 'sort'].map((n) => [n, form.elements.namedItem(n)]),
);

let products = [];
let options = readOptions(new URLSearchParams(location.search));
for (const [k, field] of Object.entries(fields)) field.value = options[k];

function render() {
  const shown = browse(products, options);
  count.textContent =
    shown.length === products.length
      ? `Showing all ${shown.length} coffees`
      : `Showing ${shown.length} of ${products.length} coffees`;
  if (!shown.length) {
    list.replaceChildren(
      el(
        'li',
        { class: 'empty' },
        el('p', {}, 'No coffees match those filters.'),
        el('button', { type: 'button', class: 'btn btn-ghost', onclick: reset }, 'Clear filters'),
      ),
    );
    return;
  }
  list.replaceChildren(...shown.map((p) => productCard(p, { headingLevel: 'h2' })));
}

/** Keep the filters in the address bar, so a filtered shop can be shared or bookmarked. */
function syncUrl() {
  const q = new URLSearchParams();
  if (options.roast !== 'all') q.set('roast', options.roast);
  if (options.price !== 'any') q.set('price', options.price);
  if (options.sort !== 'featured') q.set('sort', options.sort);
  const query = q.toString();
  history.replaceState(null, '', query ? `?${query}` : location.pathname);
}

function reset() {
  options = readOptions(new URLSearchParams());
  for (const [k, field] of Object.entries(fields)) field.value = options[k];
  syncUrl();
  render();
  fields.roast.focus();
}

form.addEventListener('change', () => {
  options = readOptions(new URLSearchParams(new FormData(form)));
  syncUrl();
  render();
});
form.addEventListener('submit', (e) => e.preventDefault());

loadProducts()
  .then((data) => {
    products = data;
    render();
  })
  .catch(() => showError(list, 'Our coffees could not be loaded. Please try again in a moment.'));
