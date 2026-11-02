// Pure catalog logic: filtering, sorting and formatting products. No DOM here.

export const ROASTS = ['light', 'medium', 'dark'];

/** Price bands offered by the shop's Price filter, keyed by the option value. */
export const PRICE_BANDS = {
  any: () => true,
  'under-15': (p) => p < 15,
  '15-20': (p) => p >= 15 && p <= 20,
  'over-20': (p) => p > 20,
};

export const SORTS = ['featured', 'price-asc', 'price-desc', 'name'];

/** Products matching a roast ('all' or a roast) and a price band (a key of PRICE_BANDS). */
export function filterProducts(products, { roast = 'all', price = 'any' } = {}) {
  const inBand = PRICE_BANDS[price] ?? PRICE_BANDS.any;
  return products.filter((p) => (roast === 'all' || p.roast === roast) && inBand(p.price));
}

const byName = (a, b) => a.name.localeCompare(b.name, 'en');

/** A sorted copy. 'featured' keeps the catalog order; price ties are broken by name. */
export function sortProducts(products, sort = 'featured') {
  const list = [...products];
  if (sort === 'price-asc') return list.sort((a, b) => a.price - b.price || byName(a, b));
  if (sort === 'price-desc') return list.sort((a, b) => b.price - a.price || byName(a, b));
  if (sort === 'name') return list.sort(byName);
  return list;
}

/** Filter, then sort. */
export function browse(products, { roast, price, sort } = {}) {
  return sortProducts(filterProducts(products, { roast, price }), sort);
}

/** Valid shop options from untrusted input (a URL's query string), with defaults. */
export function readOptions(params) {
  const get = (k) => (params && typeof params.get === 'function' ? params.get(k) : undefined);
  const roast = get('roast');
  const price = get('price');
  const sort = get('sort');
  return {
    roast: ROASTS.includes(roast) ? roast : 'all',
    price: Object.hasOwn(PRICE_BANDS, price) ? price : 'any',
    sort: SORTS.includes(sort) ? sort : 'featured',
  };
}

export function findProduct(products, id) {
  return products.find((p) => p.id === id);
}

/** Up to `n` other products, same roast first. */
export function related(products, id, n = 3) {
  const self = findProduct(products, id);
  if (!self) return [];
  const others = products.filter((p) => p.id !== id);
  const same = others.filter((p) => p.roast === self.roast);
  const rest = others.filter((p) => p.roast !== self.roast);
  return [...same, ...rest].slice(0, n);
}

export function formatPrice(amount) {
  return `$${(Math.round(amount * 100) / 100).toFixed(2)}`;
}

export function imageFor(product) {
  return `img/products/${product.id}.svg`;
}

export const ROAST_LABELS = { light: 'Light roast', medium: 'Medium roast', dark: 'Dark roast' };
