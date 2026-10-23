Build the engine of a calculator app as a dependency-free Node.js module, `calc.js` (CommonJS, no build step). It must export the following.

1. `evaluate(expression)`, which returns a number:
   - Operators: `+`, `-`, `*`, `/`, and `^` for power. `^` is right-associative: `2^3^2` is `512`.
   - Parentheses.
   - Unary minus: `-3`, `-(2+1)`, `2*-3`. Unary minus binds looser than `^`, so `-2^2` is `-4`.
   - Decimals, including `.5` and `1.25`. Whitespace is allowed anywhere.
   - Usual precedence: `2+3*4` is `14`.
   - Errors throw a `CalcError` (exported, extends `Error`):
     - message `'Division by zero'` for division by zero;
     - message `'Invalid expression'` for anything malformed: empty input, unbalanced parentheses, a trailing operator such as `'2+'`, `'2**3'`, letters, two dots in one number.

2. `format(value)`, which returns a string:
   - At most 10 significant digits, with no trailing zeros: `format(1/3)` is `'0.3333333333'`, and `format(2.5)` is `'2.5'`.
   - Plain notation when `1e-6 <= |value| < 1e12` (or `value` is 0); otherwise exponential notation like `'1.5e+20'`.
   - `-0` formats as `'0'`.

3. `class Calculator`, the state behind the keypad:
   - `press(key)` accepts `'0'`–`'9'`, `'.'`, `'+'`, `'-'`, `'*'`, `'/'`, `'^'`, `'('`, `')'`, `'='`, `'C'` and `'Backspace'`.
   - The `display` getter returns the expression typed so far (initially `''`). After `'='`, it returns the formatted result, or `'Error'` if evaluating threw a `CalcError`.
   - After a result: a digit, `'.'` or `'('` starts a new expression, while an operator continues from the result (pressing `'+'` after a result of `5` gives `'5+'`). After `'Error'`, any key except `'C'` starts fresh.
   - `'C'` clears to `''`. `'Backspace'` removes the last character, and clears a shown result.

Add tests that run with `npm test` (use `node --test`).
