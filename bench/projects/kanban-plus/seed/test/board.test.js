import test from 'node:test';
import assert from 'node:assert';
import { addCard, emptyBoard, load, moveCard, removeCard, save } from '../src/board.js';

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
