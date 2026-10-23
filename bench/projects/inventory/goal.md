This repository has a small inventory module, `inventory.js`, with every function in one file and shared global state. Users have reported bugs. Refactor it and fix them. Stay dependency-free and CommonJS.

**Refactor**

- Move the code into `src/`, with a class `Inventory`. `index.js` at the root exports `{ Inventory }`.
- Each `new Inventory()` has its own items, with no shared global state.
- Methods: `add(sku, name, qty, price)`, `remove(sku, qty)`, `total()`, `find(query)` and `lowStock(threshold)`.
- Items are plain objects `{ sku, name, qty, price }`.
- Update the existing tests to the new API and keep them passing. `npm test` runs them with `node --test`.

**Bugs to fix**

1. `remove` doesn't validate:
   - Removing more than is in stock must throw a `RangeError` with message `'Not enough stock'` and change nothing.
   - Removing an unknown SKU must throw an `Error` with message `'Unknown SKU: <sku>'`.
   - When an item's stock reaches 0, the item stays listed with `qty: 0`.
2. `total()` rounds to whole numbers; it must round to cents. For example, a total of 7.505 returns 7.51 (a number, not a string).
3. `find` only matches the exact name. It must match a case-insensitive substring of the name, and return an array of every matching item, sorted by SKU (empty array if none).

**Validation and a new feature**

- `add` with `qty <= 0`, or with a negative `price`, throws a `RangeError` and changes nothing.
- Adding an existing SKU adds to its quantity, and keeps the first name and price.
- New: `lowStock(threshold)` returns the items with `qty < threshold`, sorted by `qty` ascending, then by SKU.
