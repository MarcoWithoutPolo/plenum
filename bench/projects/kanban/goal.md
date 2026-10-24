Build a small kanban board as a static web app in this repository: `index.html`, CSS and JavaScript only, with no
frameworks, no build step and no dependencies. It must work when the folder is served by any static web server, so ES
modules are fine.

**The board**

- Three columns, in this order: To do, Doing, Done. Each column is an element with `data-column="todo"`,
  `data-column="doing"` or `data-column="done"`. It has a heading with the column's name and, inside it, an element
  with `data-count` showing how many cards the column has.
- Each card is an element with `data-card`, showing the card's text.

**Using it**

- A text field labelled "New card" and a button "Add card" add a card to To do. Pressing Enter in the field adds it
  too. Text is trimmed. Empty or whitespace-only text adds nothing. The field is cleared after adding.
- Each card has three buttons, with these accessible names: "Move left", "Move right" and "Delete".
  - Move left and Move right move the card to the neighbouring column, at the end of that column.
  - In To do there's nowhere left to go, so Move left is disabled or absent. In Done, Move right is disabled or absent.
  - Delete removes the card.
- The board is saved in `localStorage`, so the cards and their columns survive a page reload.

**How it must look**

- **Dark mode:** follows the system setting (`prefers-color-scheme`), with a dark background in dark mode and a light
  one in light mode.
- **Readable:** all text, including button labels, has a contrast ratio of at least 4.5:1 against its background, in
  both themes.
- **Phones:** at 390 px wide, the columns are stacked vertically and the page never scrolls sideways. On desktop
  (1280 px), the columns sit side by side.
- **Touch-friendly:** every button is at least 44 × 44 px on phones.
- **No errors:** the page loads with no JavaScript errors in the console.

**Code**

Keep the board logic (adding, moving, removing cards) in pure functions in `src/board.js`, separate from the DOM code,
and test them with `node --test`. `npm test` runs the tests.
