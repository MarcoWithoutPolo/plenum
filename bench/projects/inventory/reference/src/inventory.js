class Inventory {
  #items = new Map();

  add(sku, name, qty, price) {
    if (!(qty > 0)) throw new RangeError('qty must be positive');
    if (price < 0) throw new RangeError('price must not be negative');
    const item = this.#items.get(sku);
    if (item) item.qty += qty;
    else this.#items.set(sku, { sku, name, qty, price });
  }

  remove(sku, qty) {
    const item = this.#items.get(sku);
    if (!item) throw new Error(`Unknown SKU: ${sku}`);
    if (qty > item.qty) throw new RangeError('Not enough stock');
    item.qty -= qty;
  }

  total() {
    let t = 0;
    for (const i of this.#items.values()) t += i.qty * i.price;
    return Math.round((t + Number.EPSILON) * 100) / 100;
  }

  #sorted(filter) {
    return [...this.#items.values()]
      .filter(filter)
      .sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0))
      .map((i) => ({ ...i }));
  }

  find(query) {
    const q = String(query).toLowerCase();
    return this.#sorted((i) => i.name.toLowerCase().includes(q));
  }

  lowStock(threshold) {
    return this.#sorted((i) => i.qty < threshold).sort((a, b) => a.qty - b.qty);
  }
}

module.exports = { Inventory };
