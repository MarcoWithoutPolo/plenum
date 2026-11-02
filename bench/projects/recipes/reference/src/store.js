// Recipe storage on SQLite (node:sqlite). Lists are kept as JSON text; photos as BLOBs.
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS recipes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    ingredients TEXT NOT NULL DEFAULT '[]',
    steps TEXT NOT NULL DEFAULT '[]',
    tags TEXT NOT NULL DEFAULT '[]',
    minutes INTEGER,
    photo BLOB,
    photo_type TEXT
  );
`;

const COLUMNS = 'id, title, ingredients, steps, tags, minutes, photo_type';

function toRecipe(row) {
  return {
    id: Number(row.id),
    title: row.title,
    ingredients: JSON.parse(row.ingredients),
    steps: JSON.parse(row.steps),
    tags: JSON.parse(row.tags),
    minutes: row.minutes === null ? null : Number(row.minutes),
    hasPhoto: row.photo_type !== null,
  };
}

export function openStore(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  const q = {
    all: db.prepare(`SELECT ${COLUMNS} FROM recipes ORDER BY id`),
    get: db.prepare(`SELECT ${COLUMNS} FROM recipes WHERE id = ?`),
    insert: db.prepare(
      'INSERT INTO recipes (title, ingredients, steps, tags, minutes) VALUES (?, ?, ?, ?, ?)',
    ),
    update: db.prepare(
      'UPDATE recipes SET title = ?, ingredients = ?, steps = ?, tags = ?, minutes = ? WHERE id = ?',
    ),
    remove: db.prepare('DELETE FROM recipes WHERE id = ?'),
    setPhoto: db.prepare('UPDATE recipes SET photo = ?, photo_type = ? WHERE id = ?'),
    getPhoto: db.prepare('SELECT photo, photo_type FROM recipes WHERE id = ?'),
  };
  const fields = (r) => [
    r.title,
    JSON.stringify(r.ingredients),
    JSON.stringify(r.steps),
    JSON.stringify(r.tags),
    r.minutes,
  ];

  return {
    list({ q: text, tag } = {}) {
      let all = q.all.all().map(toRecipe);
      if (text) {
        const needle = text.toLowerCase();
        all = all.filter(
          (r) =>
            r.title.toLowerCase().includes(needle) ||
            r.ingredients.some((i) => i.toLowerCase().includes(needle)),
        );
      }
      if (tag) {
        const t = tag.toLowerCase();
        all = all.filter((r) => r.tags.some((x) => x.toLowerCase() === t));
      }
      return all;
    },
    get(id) {
      const row = q.get.get(id);
      return row ? toRecipe(row) : null;
    },
    create(recipe) {
      const { lastInsertRowid } = q.insert.run(...fields(recipe));
      return this.get(Number(lastInsertRowid));
    },
    update(id, recipe) {
      const { changes } = q.update.run(...fields(recipe), id);
      return changes ? this.get(id) : null;
    },
    remove(id) {
      return q.remove.run(id).changes > 0;
    },
    setPhoto(id, bytes, type) {
      return q.setPhoto.run(bytes, type, id).changes > 0 ? this.get(id) : null;
    },
    getPhoto(id) {
      const row = q.getPhoto.get(id);
      return row && row.photo_type ? { bytes: Buffer.from(row.photo), type: row.photo_type } : null;
    },
    close() {
      db.close();
    },
  };
}
