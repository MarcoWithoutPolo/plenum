// Hidden acceptance tests for textkit. Never shown to any agent.
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');
const { writeFileSync, mkdtempSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const root = process.cwd();
const { slugify, wordCount, truncate } = require(join(root, 'index.js'));

test('slugify: basics and accents', () => {
  assert.strictEqual(slugify('  Héllo, Wörld!  '), 'hello-world');
  assert.strictEqual(slugify('Crème Brûlée'), 'creme-brulee');
  assert.strictEqual(slugify('a__b--c  d'), 'a-b-c-d');
  assert.strictEqual(slugify('---'), '');
  assert.strictEqual(slugify('ABC123'), 'abc123');
});

test('slugify: maxLength never ends with a dash', () => {
  assert.strictEqual(slugify('hello world', { maxLength: 6 }), 'hello');
  assert.strictEqual(slugify('hello world', { maxLength: 5 }), 'hello');
  assert.strictEqual(slugify('hello world', { maxLength: 7 }), 'hello-w');
  assert.ok(slugify('a b c d e f', { maxLength: 4 }).length <= 4);
  assert.ok(!slugify('a b c d e f', { maxLength: 4 }).endsWith('-'));
});

test('slugify: non-string throws TypeError', () => {
  assert.throws(() => slugify(42), TypeError);
  assert.throws(() => slugify(null), TypeError);
});

test('wordCount', () => {
  assert.deepStrictEqual(wordCount(''), { words: 0, lines: 0, chars: 0 });
  assert.deepStrictEqual(wordCount('one'), { words: 1, lines: 1, chars: 3 });
  assert.deepStrictEqual(wordCount('a b\nc'), { words: 3, lines: 2, chars: 5 });
  assert.deepStrictEqual(wordCount('a b\n'), { words: 2, lines: 1, chars: 4 });
  assert.deepStrictEqual(wordCount('  spaced   out  '), { words: 2, lines: 1, chars: 16 });
  assert.deepStrictEqual(wordCount('x\n\ny'), { words: 2, lines: 3, chars: 4 });
});

test('truncate', () => {
  assert.strictEqual(truncate('short', 10), 'short');
  assert.strictEqual(truncate('hello world', 11), 'hello world');
  assert.strictEqual(truncate('hello world', 8), 'hello…');
  assert.strictEqual(truncate('hello world foo', 12), 'hello world…');
  assert.strictEqual(truncate('abcdefghij', 5), 'abcd…');
  assert.strictEqual(truncate('hello world', 9, { ellipsis: '...' }), 'hello...');
  assert.ok(truncate('the quick brown fox jumps', 14).length <= 14);
  assert.throws(() => truncate('x', 0), RangeError);
});

test('cli: slugify and count', () => {
  const out = execFileSync(process.execPath, [join(root, 'cli.js'), 'slugify', 'Hello', 'World!'], {
    encoding: 'utf8',
  });
  assert.strictEqual(out.trim(), 'hello-world');
  const dir = mkdtempSync(join(tmpdir(), 'textkit-'));
  const file = join(dir, 'f.txt');
  writeFileSync(file, 'a b\nc d e\n');
  const count = execFileSync(process.execPath, [join(root, 'cli.js'), 'count', file], {
    encoding: 'utf8',
  });
  assert.strictEqual(count.trim(), '5 2 10');
});

test('cli: unknown command exits 1 with usage on stderr', () => {
  const r = spawnSync(process.execPath, [join(root, 'cli.js'), 'nope'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 1);
  assert.ok(r.stderr.trim().length > 0);
});
