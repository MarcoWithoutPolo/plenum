class CalcError extends Error {}

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
    } else if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      const text = src.slice(i, j);
      if ((text.match(/\./g) || []).length > 1 || text === '.')
        throw new CalcError('Invalid expression');
      tokens.push({ type: 'num', value: Number(text) });
      i = j;
    } else if ('+-*/^()'.includes(ch)) {
      tokens.push({ type: ch });
      i++;
    } else {
      throw new CalcError('Invalid expression');
    }
  }
  return tokens;
}

function evaluate(expression) {
  const tokens = tokenize(String(expression));
  let pos = 0;
  const peek = () => tokens[pos]?.type;
  const fail = () => {
    throw new CalcError('Invalid expression');
  };
  // expr := term (('+'|'-') term)*
  function expr() {
    let v = term();
    while (peek() === '+' || peek() === '-') {
      const op = tokens[pos++].type;
      const r = term();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }
  // term := unary (('*'|'/') unary)*
  function term() {
    let v = unary();
    while (peek() === '*' || peek() === '/') {
      const op = tokens[pos++].type;
      const r = unary();
      if (op === '/') {
        if (r === 0) throw new CalcError('Division by zero');
        v = v / r;
      } else v = v * r;
    }
    return v;
  }
  // unary := '-' unary | power
  function unary() {
    if (peek() === '-') {
      pos++;
      return -unary();
    }
    return power();
  }
  // power := primary ('^' unary)?   (right-associative)
  function power() {
    const base = primary();
    if (peek() === '^') {
      pos++;
      return base ** unary();
    }
    return base;
  }
  function primary() {
    const t = tokens[pos];
    if (!t) fail();
    if (t.type === 'num') {
      pos++;
      return t.value;
    }
    if (t.type === '(') {
      pos++;
      const v = expr();
      if (peek() !== ')') fail();
      pos++;
      return v;
    }
    return fail();
  }
  if (tokens.length === 0) fail();
  const value = expr();
  if (pos !== tokens.length) fail();
  return value;
}

function format(value) {
  if (Object.is(value, -0) || value === 0) return '0';
  const abs = Math.abs(value);
  if (abs >= 1e-6 && abs < 1e12) {
    const s = Number(value.toPrecision(10)).toString();
    return s;
  }
  return Number(value.toPrecision(10))
    .toExponential()
    .replace(/\.?0+e/, 'e');
}

class Calculator {
  #text = '';
  #result = null; // string shown after '=' (a number or 'Error')

  get display() {
    return this.#result ?? this.#text;
  }

  press(key) {
    if (key === 'C') {
      this.#text = '';
      this.#result = null;
      return;
    }
    if (this.#result !== null) {
      const shown = this.#result;
      this.#result = null;
      if (key === 'Backspace') {
        this.#text = '';
        return;
      }
      if (shown === 'Error' || /[0-9.(]/.test(key)) this.#text = '';
      else this.#text = shown;
    }
    if (key === 'Backspace') {
      this.#text = this.#text.slice(0, -1);
    } else if (key === '=') {
      try {
        this.#result = format(evaluate(this.#text));
      } catch (err) {
        if (!(err instanceof CalcError)) throw err;
        this.#result = 'Error';
      }
    } else {
      this.#text += key;
    }
  }
}

module.exports = { evaluate, format, Calculator, CalcError };
