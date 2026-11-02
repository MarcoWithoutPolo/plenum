import test from 'node:test';
import assert from 'node:assert';
import {
  addCard,
  emptyBoard,
  load,
  loadTheme,
  moveCard,
  removeCard,
  save,
  saveTheme,
  toCsv,
} from '../src/board.js';

test('adds trimmed cards to To do and ignores empty text', () => {
  let b = addCard(emptyBoard(), '  a  ', '1');
  b = addCard(b, '   ', '2');
  assert.deepStrictEqual(b.todo, [{ id: '1', text: 'a' }]);
});

test('moves cards and stops at the ends', () => {
  let b = addCard(emptyBoard(), 'a', '1');
  assert.strictEqual(moveCard(b, '1', 'left'), b);
  b = moveCard(moveCard(b, '1', 'right'), '1', 'right');
  assert.deepStrictEqual(b.done, [{ id: '1', text: 'a' }]);
  assert.strictEqual(moveCard(b, '1', 'right'), b);
});

test('removes cards and saves and loads', () => {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const b = removeCard(addCard(addCard(emptyBoard(), 'a', '1'), 'b', '2'), '1');
  save(storage, b);
  assert.deepStrictEqual(load(storage), b);
});

test('exports CSV with a header and the cards in board order', () => {
  let b = addCard(addCard(addCard(emptyBoard(), 'a', '1'), 'b', '2'), 'c', '3');
  b = moveCard(moveCard(b, '1', 'right'), '1', 'right');
  b = moveCard(b, '3', 'right');
  assert.strictEqual(toCsv(b), 'column,text\r\nTo do,b\r\nDoing,c\r\nDone,a\r\n');
  assert.strictEqual(toCsv(emptyBoard()), 'column,text\r\n');
});

test('quotes CSV values with commas, quotes or line breaks', () => {
  const b = addCard(emptyBoard(), 'Say "hi", then go', '1');
  assert.strictEqual(toCsv(b), 'column,text\r\nTo do,"Say ""hi"", then go"\r\n');
  const multi = { ...emptyBoard(), done: [{ id: '2', text: 'two\nlines' }] };
  assert.strictEqual(toCsv(multi), 'column,text\r\nDone,"two\nlines"\r\n');
});

test('saves and loads the theme, defaulting to system', () => {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  assert.strictEqual(loadTheme(storage), 'system');
  saveTheme(storage, 'dark');
  assert.strictEqual(loadTheme(storage), 'dark');
  store.set('kanban-theme', 'purple');
  assert.strictEqual(loadTheme(storage), 'system');
});
