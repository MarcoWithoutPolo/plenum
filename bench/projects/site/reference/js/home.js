import { loadProducts, productCard, showError } from './common.js';

const list = document.querySelector('[data-featured]');
const FEATURED = ['yirgacheffe-sunrise', 'huila-daybreak', 'northwind-espresso', 'bonfire-reserve'];

loadProducts()
  .then((products) => {
    const picks = FEATURED.map((id) => products.find((p) => p.id === id)).filter(Boolean);
    list.replaceChildren(...picks.map((p) => productCard(p)));
  })
  .catch(() => showError(list, 'Our coffees could not be loaded. Please try again in a moment.'));
