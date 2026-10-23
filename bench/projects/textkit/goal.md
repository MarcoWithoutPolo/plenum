Build **textkit**, a small dependency-free Node.js package (CommonJS, no build step).

`index.js` exports three functions:

1. `slugify(text, options)`:
   - Lowercase the text, strip accents (`é` → `e`), turn every run of characters other than `a-z` and `0-9` into a single `-`, and trim `-` from both ends.
   - `options.maxLength` (optional): the slug is at most that many characters and never ends with `-`.
   - A non-string `text` throws a `TypeError`.
   - Example: `slugify('  Héllo, Wörld!  ')` is `'hello-world'`.

2. `wordCount(text)`, which returns `{ words, lines, chars }`:
   - `words` is the number of whitespace-separated, non-empty tokens.
   - `lines` is the number of lines separated by `\n`. `''` has 0 lines, and a trailing `\n` doesn't start a new line.
   - `chars` is `text.length`.

3. `truncate(text, max, options)`:
   - If `text.length <= max`, return `text` unchanged.
   - Otherwise, return at most `max` characters in total, ending with `options.ellipsis` (default `'…'`).
   - Cut at a word boundary: if the cut lands inside a word and there is an earlier space, drop that partial word. Trim trailing spaces before adding the ellipsis. With no space to cut at, cut hard.
   - `max < 1` throws a `RangeError`.
   - Examples: `truncate('hello world', 8)` is `'hello…'`; `truncate('abcdefghij', 5)` is `'abcd…'`.

Also a CLI, `cli.js`:

- `node cli.js slugify <words...>` prints the slug of the words joined by spaces.
- `node cli.js count <file>` prints `words lines chars` (space-separated) for that file.
- Anything else prints a usage line to stderr and exits with code 1.

Add tests that run with `npm test` (use `node --test`).
