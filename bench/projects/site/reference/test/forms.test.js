import test from 'node:test';
import assert from 'node:assert';
import { validateContact } from '../src/validate.js';
import { resolveTheme, toggled } from '../src/theme.js';

test('every field is required', () => {
  assert.deepStrictEqual(Object.keys(validateContact({})).sort(), ['email', 'message', 'name']);
  assert.deepStrictEqual(
    Object.keys(validateContact({ name: '  ', email: ' ', message: '   ' })).sort(),
    ['email', 'message', 'name'],
  );
});

test('checks the email format', () => {
  for (const email of ['nope', 'a@b', 'a b@c.de', '@x.io'])
    assert.ok(validateContact({ name: 'A', email, message: 'Hello there!' }).email, email);
  assert.deepStrictEqual(
    validateContact({ name: 'Ana', email: ' ana@example.com ', message: 'Hello there!' }),
    {},
  );
});

test('wants a message of at least 10 characters', () => {
  assert.match(
    validateContact({ name: 'A', email: 'a@b.co', message: 'Hi' }).message,
    /at least 10/,
  );
});

test('the theme follows the system unless overridden', () => {
  assert.strictEqual(resolveTheme(null, true), 'dark');
  assert.strictEqual(resolveTheme(null, false), 'light');
  assert.strictEqual(resolveTheme('light', true), 'light');
  assert.strictEqual(resolveTheme('dark', false), 'dark');
  assert.strictEqual(resolveTheme('purple', false), 'light');
  assert.strictEqual(toggled('dark'), 'light');
  assert.strictEqual(toggled('light'), 'dark');
});
