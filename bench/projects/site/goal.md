I run a small coffee roaster, Northwind Roasters (it's fictional, so make up the details), and I want a proper
website for it: something that looks like a high-end independent brand, not a template. It has to be plain HTML, CSS and
JavaScript in this repository, with no frameworks, no build step and no dependencies, and it must work when the folder is
served by any static web server (ES modules and `fetch` of local files are fine). Nothing may load from the internet.

**Pages**

- `index.html`, the home page, opens with a striking animated hero: an element with `data-hero` that holds the main
  heading. While motion is allowed, the hero has at least one looping (continuously running) CSS or Web Animations
  animation. Below it, whatever a good coffee home page needs.
- `shop.html` lists the coffees, with filters and sorting (below).
- `product.html?id=<id>` shows one coffee.
- `cart.html` shows the cart.
- `contact.html` has a contact form.

**Every page**

- A header with links to the other pages and, inside it, an element with `data-cart-count` showing the number of items
  in the cart: the sum of the quantities, `0` when the cart is empty.
- A dark mode. With no choice made, the page follows the system's light or dark setting, including when that setting
  changes while the page is open. A button with the accessible name "Dark mode" and `aria-pressed` (`"true"` when dark
  is showing) switches between light and dark; that choice overrides the system, is saved in `localStorage` and applies
  on every page and after a reload. The `<html>` element always has `data-theme="light"` or `data-theme="dark"`,
  whichever is showing.
- When the system asks for reduced motion (`prefers-reduced-motion: reduce`), nothing on the page animates: once the
  page has loaded, `document.getAnimations()` has no running animations.
- Loads without errors in the console, works at any width from 375 px up without sideways scrolling, and meets common
  accessibility guidelines (no serious or critical problems in an automated audit such as axe), in light and dark.
- Every image has a text alternative (`alt`); product images have a non-empty one that names the coffee.

**The products**

- The coffees live in a data file, `data/products.json`: an array of at least 8 products, each with at least `id` (a
  URL-safe string), `name`, `roast` (`"light"`, `"medium"` or `"dark"`) and `price` (a number in US dollars). Add
  whatever else makes the pages good.
- Prices are shown as dollars with two decimals, like `$18.50`.

**The shop**

- Each listed product is an element with `data-product`, `data-id` (its id), `data-roast` and `data-price` (its price
  as a number), showing its name and price and linking to its product page. Only listed products are in the page.
- Three select menus, which apply as soon as they change (no button to press):
  - "Roast" with option values `all`, `light`, `medium`, `dark`.
  - "Price" with option values `any`, `under-15` (less than $15), `15-20` ($15 to $20, both included) and `over-20`
    (more than $20).
  - "Sort by" with option values `featured` (the order of the data file), `price-asc`, `price-desc` and `name`
    (A to Z).
- Filters combine. When nothing matches, say so.

**A product page**

- `product.html?id=<id>` shows that product: its name in the page's `h1`, its price, and anything else that sells it.
- A number field labelled "Quantity" (1 by default) and a button "Add to cart" add that many to the cart.
- An unknown id shows a "not found" message in the `h1` instead.

**The cart**

- The cart is saved in `localStorage`, so it survives reloads and is shared by every page.
- `cart.html` shows each product in the cart as an element with `data-cart-item` and `data-id`, containing a number
  field for its quantity (accessible name starting with "Quantity") and a button whose accessible name starts with
  "Remove". Changing the quantity field (a `change` event) updates the cart; Remove takes the product out.
- An element with `data-cart-subtotal` shows the sum of price × quantity, formatted as above.
- An empty cart shows a message saying so.

**The contact form**

- Fields labelled "Name", "Email" and "Message", and a button "Send message". All three are required; the email must
  look like an email address (`something@domain.tld`); the message needs at least 10 characters.
- Validate in JavaScript with your own messages (not the browser's built-in bubbles). When the visitor sends the form
  with problems, each invalid field gets `aria-invalid="true"` and a visible message right next to it, linked to it with
  `aria-describedby`.
- When everything is valid, show a thank-you message in an element with `data-form-success`, and don't send anything
  over the network: there is no backend.

**Code**

Keep the logic that doesn't need a page in pure functions in `src/*.js`, separate from the DOM code: at least filtering
and sorting products and the cart's arithmetic (adding, removing, changing quantities, counting, totals). Test them with
`node --test`. `npm test` runs the tests.
