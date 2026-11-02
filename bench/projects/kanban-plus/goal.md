This repository is my little kanban board (plain HTML, CSS and JavaScript, no build step, no dependencies; open
`index.html` through any static web server). I use it every day and it works well. I'd like three additions, and
everything that works today has to keep working exactly as it does: the columns, adding, moving and deleting cards,
saving in `localStorage`, the layout on phones and desktops, and the accessibility (readable contrast, 44 × 44 px tap
targets on phones). Keep the code style and structure of what's there.

**1. A theme switch**

Right now the board always follows the system's light or dark setting. Add a control labelled "Theme" with three
choices: System, Light and Dark. Either a `<select>` labelled "Theme" with those three options, or a button labelled
"Theme" that opens the three choices as buttons or menu items named System, Light and Dark.

- System follows the operating system's setting, as the board does today. Light and Dark override it.
- The choice is saved in `localStorage` and applied when the page loads, without a flash of the wrong theme.
- Text stays readable (contrast at least 4.5:1) in every theme.

**2. Keyboard shortcuts**

- `N` puts the cursor in the "New card" field (without typing an "n" into it).
- `?` opens a dialog (`role="dialog"`, e.g. a `<dialog>`) that lists all the shortcuts. `Escape` closes it.
- Cards can take keyboard focus: the card element itself (the one with `data-card`) is focusable, so Tab reaches each
  card. With a card focused:
  - `ArrowLeft` / `ArrowRight` move it to the neighbouring column, the same as its Move left / Move right buttons
    (nothing happens at the ends). The moved card keeps focus, so pressing the key again moves it on.
  - `Delete` removes it, the same as its Delete button.
- Shortcuts never get in the way of typing: while the cursor is in a text field, every key types as usual (an `n` or
  `?` goes into the field, `Delete` deletes text).

**3. Export to CSV**

A button "Export CSV" downloads the board as a `.csv` file (e.g. `kanban.csv`):

- The first line is the header `column,text`, then one line per card: To do first, then Doing, then Done, each in the
  order shown on the board.
- `column` is the column's name as shown: `To do`, `Doing` or `Done`. `text` is the card's text.
- Standard CSV quoting: a value that contains a comma, a double quote or a line break is wrapped in double quotes, with
  any double quote inside doubled (`Say "hi", then go` → `"Say ""hi"", then go"`). The file is UTF-8.
- With no cards, the file has just the header line.

**Code**

Keep the board logic pure and in `src/board.js` (the CSV text belongs there too), and add tests for what you add.
`npm test` (`node --test`) must stay green.
