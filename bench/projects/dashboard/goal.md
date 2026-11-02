We sell office gear in four regions and I want a sales dashboard I can open in a browser and play with. The data is
in `data/sales.csv` (one row per order). Build it as a static web app in this repository: `index.html`, CSS and
JavaScript only, with no frameworks, no build step and no dependencies. It must work when the folder is served by any
static web server, so ES modules are fine. The page loads `data/sales.csv` itself.

**The data**

`data/sales.csv` has a header row and these columns: `date` (`YYYY-MM-DD`), `region`, `category`, `product`, `units`
(whole number) and `revenue` (a decimal amount). Fields that contain a comma or a double quote are wrapped in double
quotes, with any double quote inside doubled (`"Monitor 27"""`), as in standard CSV.

**Data logic: `src/data.js`**

Keep the data logic in pure functions in `src/data.js`, an ES module with these named exports. None of them changes
its arguments. Money amounts are rounded to the cent (`Math.round(x * 100) / 100`).

- `parseCsv(text)` returns an array of row objects, one per data line, keyed by the header's column names:
  `{ date: '2025-01-02', region: 'North', category: 'Furniture', product: 'Desk Lamp, LED', units: 6, revenue: 208.5 }`.
  `units` and `revenue` are numbers; every other field is a string. It handles quoted fields (with commas and doubled
  quotes inside), `\n` and `\r\n` line endings, a trailing newline, and skips blank lines. Text with only a header
  gives `[]`.
- `filterRows(rows, filters)` returns a new array with the rows that match, in their original order. `filters` is
  `{ region, category, from, to }`; every key is optional, and a missing, `undefined`, `null` or empty-string value
  means "don't filter on this". `region` and `category` match exactly. `from` and `to` are `YYYY-MM-DD` dates and are
  inclusive. `filterRows(rows, {})` returns all rows.
- `summarize(rows)` returns `{ revenue, units, orders }`: total revenue (rounded to the cent), total units and the
  number of rows. For no rows it returns `{ revenue: 0, units: 0, orders: 0 }`.
- `byMonth(rows)` returns `[{ month: '2025-01', revenue }, ...]`: one entry per calendar month that has rows, oldest
  first, revenue rounded to the cent. For no rows, `[]`.
- `byCategory(rows)` returns `[{ category, revenue }, ...]`: one entry per category that has rows, highest revenue
  first (ties by category name, A to Z), revenue rounded to the cent. For no rows, `[]`.
- `toCsv(rows)` turns rows back into CSV text: the header `date,region,category,product,units,revenue`, then one line
  per row in that column order, lines separated by `\n` and ending with a `\n`. Fields with a comma, a double quote or
  a line break are quoted as described above; numbers are written as `String(n)`. `parseCsv(toCsv(rows))` gives back
  `rows`.

Test them with `node --test`. `npm test` runs the tests.

**The page**

- Filters, each with a visible label:
  - a select labelled "Region" whose first option is "All regions" (value `""`), then each region in the data;
  - a select labelled "Category", first option "All categories" (value `""`), then each category in the data;
  - two date inputs (`type="date"`) labelled "From" and "To" (inclusive; empty means no limit).
    Changing any filter updates everything below straight away. On load no filter is set, so the page shows all orders.
- Totals for the rows that match the current filters, in elements with these attributes: `data-total-revenue`
  (revenue, to the cent), `data-total-units` and `data-total-orders`. Formatting such as `$12,345.67` or `1,234` is
  fine. When nothing matches, they show zero.
- Two charts for the filtered rows: revenue by month and revenue by category, each drawn as an SVG or on a canvas
  (your choice), inside an element with `data-chart="month"` and `data-chart="category"` respectively.
- A button "Export CSV" that downloads the filtered rows as a `.csv` file in the `toCsv` format.

**How it should look**

Clean and readable on a phone (375 px wide), a tablet and a desktop: the charts are always visible, fit the screen,
and the page never scrolls sideways. The page should load without errors.
