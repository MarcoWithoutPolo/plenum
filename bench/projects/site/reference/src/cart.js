// Pure cart logic. A cart is an array of { id, qty } lines; every function returns a new cart.

export const MAX_QTY = 99;
export const STORAGE_KEY = 'northwind.cart';
export const FREE_SHIPPING_FROM = 40;

const clamp = (n) => Math.min(MAX_QTY, Math.max(0, Math.floor(n)));

export function addItem(cart, id, qty = 1) {
  const n = clamp(Number(qty));
  if (!id || !n) return cart;
  const line = cart.find((l) => l.id === id);
  if (!line) return [...cart, { id, qty: n }];
  return cart.map((l) => (l.id === id ? { id, qty: clamp(l.qty + n) } : l));
}

/** Set a line's quantity (clamped to MAX_QTY). Zero or less removes it; nonsense is ignored. */
export function setQuantity(cart, id, qty) {
  const n = Number(qty);
  if (!Number.isFinite(n)) return cart;
  if (n < 1) return removeItem(cart, id);
  return cart.map((l) => (l.id === id ? { id, qty: clamp(n) } : l));
}

export function removeItem(cart, id) {
  return cart.filter((l) => l.id !== id);
}

export function itemCount(cart) {
  return cart.reduce((sum, l) => sum + l.qty, 0);
}

/** Cart lines joined with their products; lines for unknown products are dropped. */
export function lines(cart, products) {
  return cart.flatMap((l) => {
    const product = products.find((p) => p.id === l.id);
    return product ? [{ ...l, product, total: Math.round(product.price * l.qty * 100) / 100 }] : [];
  });
}

export function subtotal(cart, products) {
  const cents = lines(cart, products).reduce((sum, l) => sum + Math.round(l.total * 100), 0);
  return cents / 100;
}

export function shippingFor(amount) {
  return amount === 0 || amount >= FREE_SHIPPING_FROM ? 0 : 5;
}

/** Only well-formed lines survive: anything else in storage is ignored. */
export function sanitize(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const l of value) {
    if (!l || typeof l.id !== 'string' || !Number.isFinite(l.qty)) continue;
    const qty = clamp(l.qty);
    if (qty && !out.some((o) => o.id === l.id)) out.push({ id: l.id, qty });
  }
  return out;
}

export function loadCart(storage) {
  try {
    return sanitize(JSON.parse(storage.getItem(STORAGE_KEY) ?? '[]'));
  } catch {
    return [];
  }
}

export function saveCart(storage, cart) {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(cart));
  } catch {
    // Storage full or blocked: the cart still works for this page view.
  }
}
