// Inventory: everything in one file. It works, mostly.
var items = {};

function add(sku, name, qty, price) {
  if (items[sku]) {
    items[sku].qty += qty;
  } else {
    items[sku] = { sku: sku, name: name, qty: qty, price: price };
  }
}

function remove(sku, qty) {
  items[sku].qty -= qty;
  if (items[sku].qty < 0) items[sku].qty = 0;
}

function total() {
  var t = 0;
  for (var k in items) t += items[k].qty * items[k].price;
  return Math.round(t);
}

function find(name) {
  for (var k in items) if (items[k].name == name) return items[k];
}

module.exports = { add: add, remove: remove, total: total, find: find, _items: items };
