// Hidden acceptance tests for calc. Never shown to any agent.
const test = require('node:test');
const assert = require('node:assert');
const { join } = require('node:path');
const { evaluate, format, Calculator, CalcError } = require(join(process.cwd(), 'calc.js'));

test('evaluate: precedence and associativity', () => {
  assert.strictEqual(evaluate('2+3*4'), 14);
  assert.strictEqual(evaluate('(2+3)*4'), 20);
  assert.strictEqual(evaluate('2^3^2'), 512);
  assert.strictEqual(evaluate('10-4-3'), 3);
  assert.strictEqual(evaluate('100/10/5'), 2);
  assert.strictEqual(evaluate('2*3^2'), 18);
});

test('evaluate: unary minus, decimals, whitespace', () => {
  assert.strictEqual(evaluate('-3'), -3);
  assert.strictEqual(evaluate('-(2+1)'), -3);
  assert.strictEqual(evaluate('2*-3'), -6);
  assert.strictEqual(evaluate('-2^2'), -4);
  assert.strictEqual(evaluate('.5+1.25'), 1.75);
  assert.strictEqual(evaluate('  1 +\t2 '), 3);
  assert.strictEqual(evaluate('--2'), 2);
});

test('evaluate: errors', () => {
  const invalid = ['', '2+', '(1+2', '1+2)', '2**3', 'abc', '1.2.3', '()', '*2'];
  for (const e of invalid) {
    assert.throws(
      () => evaluate(e),
      (err) => err instanceof CalcError && err.message === 'Invalid expression',
      e,
    );
  }
  assert.throws(
    () => evaluate('1/0'),
    (err) => err instanceof CalcError && err.message === 'Division by zero',
  );
  assert.throws(
    () => evaluate('5/(2-2)'),
    (err) => err instanceof CalcError && err.message === 'Division by zero',
  );
  assert.ok(new CalcError('x') instanceof Error);
});

test('format', () => {
  assert.strictEqual(format(1 / 3), '0.3333333333');
  assert.strictEqual(format(2.5), '2.5');
  assert.strictEqual(format(10), '10');
  assert.strictEqual(format(0.1 + 0.2), '0.3');
  assert.strictEqual(format(-0), '0');
  assert.strictEqual(format(0), '0');
  assert.strictEqual(format(1.5e20), '1.5e+20');
  assert.strictEqual(format(1e-7), '1e-7');
  assert.strictEqual(format(1234567890.5), '1234567891');
  assert.strictEqual(format(-2.75), '-2.75');
});

const run = (keys) => {
  const c = new Calculator();
  for (const k of keys) c.press(k);
  return c.display;
};

test('Calculator: typing and equals', () => {
  assert.strictEqual(new Calculator().display, '');
  assert.strictEqual(run(['1', '2', '+', '3']), '12+3');
  assert.strictEqual(run(['1', '2', '+', '3', '=']), '15');
  assert.strictEqual(run(['1', '/', '3', '=']), '0.3333333333');
  assert.strictEqual(run(['1', '/', '0', '=']), 'Error');
});

test('Calculator: after a result', () => {
  assert.strictEqual(run(['2', '+', '3', '=', '+', '1']), '5+1');
  assert.strictEqual(run(['2', '+', '3', '=', '7']), '7');
  assert.strictEqual(run(['2', '+', '3', '=', '(']), '(');
  assert.strictEqual(run(['1', '/', '0', '=', '4']), '4');
});

test('Calculator: C and Backspace', () => {
  assert.strictEqual(run(['1', '2', 'Backspace']), '1');
  assert.strictEqual(run(['1', '2', 'C']), '');
  assert.strictEqual(run(['2', '+', '3', '=', 'Backspace']), '');
});
