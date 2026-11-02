I keep my recipes in a mess of notes and screenshots. I'd like a small recipe book I can run on my own machine: a
Node.js server with a JSON API and a SQLite database, plus a simple web page to browse, search, add and edit recipes,
with a photo for each one if I have one.

Keep it dependency-free: no npm packages at all. Use Node's built-in `node:http` and `node:sqlite` (Node 22.13 or
newer). `node server.js` (also `npm start`) starts it.

**Running it**

- The server listens on `process.env.PORT`, or 3000 if it isn't set.
- It keeps its data in the SQLite file `process.env.DATA_FILE`, or `./recipes.db` if it isn't set, creating it if
  needed. Everything, photos included, survives stopping and starting the server again.

**Recipes**

A recipe is returned as JSON like this:

```json
{
  "id": 1,
  "title": "Pancakes",
  "ingredients": ["2 eggs", "250 g flour"],
  "steps": ["Mix", "Fry"],
  "tags": ["breakfast"],
  "minutes": 20,
  "hasPhoto": false
}
```

- `id`: a positive integer chosen by the server.
- `title`: required, a string that is not empty after trimming; stored trimmed.
- `ingredients`, `steps`, `tags`: optional arrays of strings, `[]` when not given.
- `minutes`: optional, a positive whole number (`1`, `45`; not `0`, `-5`, `2.5` or `"10"`), `null` when not given.
- `hasPhoto`: whether the recipe has a photo (set by the server, ignored in requests).

Other fields in a request are ignored.

**API**

All request and response bodies are JSON (except photo downloads). Every error response has a JSON body
`{ "error": "<a message for people>" }` and the status below.

| Request                       | Success                                                                                                                                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/recipes`            | `200`, an array of recipes, oldest (lowest `id`) first                                                                                                                                                                   |
| `POST /api/recipes`           | `201`, the new recipe                                                                                                                                                                                                    |
| `GET /api/recipes/:id`        | `200`, the recipe                                                                                                                                                                                                        |
| `PUT /api/recipes/:id`        | `200`, the updated recipe. The body is a whole recipe, validated like `POST`; it replaces `title`, `ingredients`, `steps`, `tags` and `minutes` (left-out optional fields go back to their defaults). The photo is kept. |
| `DELETE /api/recipes/:id`     | `204`, no body; the photo goes too                                                                                                                                                                                       |
| `POST /api/recipes/:id/photo` | `200`, the recipe (now `"hasPhoto": true`). Replaces any earlier photo.                                                                                                                                                  |
| `GET /api/recipes/:id/photo`  | `200`, the image bytes with `Content-Type: image/png` or `image/jpeg`                                                                                                                                                    |

- **Validation**: a body that isn't valid JSON, or a recipe that breaks the rules above (missing or empty title,
  title not a string, `minutes` not a positive whole number, `ingredients`/`steps`/`tags` not an array of strings)
  gets `400` and changes nothing.
- **Not found**: an unknown recipe id (including ids that aren't numbers) gets `404`, for every route above. So does a
  `GET /api/recipes/:id/photo` for a recipe without a photo, and any other path under `/api/`.
- **Search**: `GET /api/recipes?q=<text>` returns only recipes whose title or any ingredient contains the text,
  ignoring case. `GET /api/recipes?tag=<tag>` returns only recipes that have that tag (ignoring case). Both can be
  combined, and the results stay oldest first.
- **Photos**: `POST /api/recipes/:id/photo` takes `{ "dataUrl": "data:image/png;base64,iVBORw0..." }`. Only
  `image/png` and `image/jpeg` data URLs in base64 are accepted; another type or a malformed data URL gets `400`.
  The decoded image may be at most 2 MB (2 × 1024 × 1024 bytes, exactly 2 MB is fine); a larger one gets `413`.

**The web page**

The same server serves the web page at `/` (static HTML, CSS and JavaScript, no frameworks, no build step). It talks
to the API.

- It lists the recipes; each one in the list is an element with a `data-recipe` attribute that shows its title.
- A text field labelled "Search" narrows the list as I type (title and ingredients).
- A form adds a recipe, with fields labelled "Title", "Ingredients" (one per line), "Steps" (one per line),
  "Tags" (comma-separated) and "Minutes", and a button "Save recipe". Blank lines and blank tags are dropped and each
  entry is trimmed. After saving, the new recipe shows in the list and the form is cleared. Saving without a title
  shows a message instead and adds nothing.
- Clicking a recipe in the list shows it in full (title, ingredients, steps, tags, minutes) in an element with a
  `data-recipe-detail` attribute, including its photo as an `<img>` when it has one.
- The details have a button "Edit" that loads the recipe into the form; "Save recipe" then updates that recipe
  instead of adding a new one.
- Uploading a photo from the page (for example a file field labelled "Photo") is welcome but optional.

It should be pleasant on a phone and on a desktop, and the page should load and work without errors in the browser
console.

**Code and tests**

Write your own tests with `node --test`; `npm test` runs them.
