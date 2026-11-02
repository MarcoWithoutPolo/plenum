# kanban

A small kanban board that runs in the browser: three columns (To do, Doing, Done), cards you add, move and delete,
saved in `localStorage`. Plain HTML, CSS and JavaScript (ES modules), no build step and no dependencies; serve the
folder with any static web server and open `index.html`.

- `index.html`, `style.css`: the page.
- `src/board.js`: the board logic, as pure functions.
- `src/app.js`: the DOM code.
- `test/`: unit tests for the board logic. `npm test` runs them (`node --test`).
