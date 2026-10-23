const { readFileSync } = require('node:fs');
const { slugify, wordCount } = require('./index.js');

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'slugify' && rest.length) {
  console.log(slugify(rest.join(' ')));
} else if (cmd === 'count' && rest[0]) {
  const { words, lines, chars } = wordCount(readFileSync(rest[0], 'utf8'));
  console.log(`${words} ${lines} ${chars}`);
} else {
  console.error('usage: cli.js slugify <words...> | count <file>');
  process.exit(1);
}
