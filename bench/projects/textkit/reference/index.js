function slugify(text, options = {}) {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  let s = text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (options.maxLength !== undefined) s = s.slice(0, options.maxLength).replace(/-+$/, '');
  return s;
}

function wordCount(text) {
  const words = text.split(/\s+/).filter(Boolean).length;
  let lines = text === '' ? 0 : text.split('\n').length;
  if (text.endsWith('\n')) lines -= 1;
  return { words, lines, chars: text.length };
}

function truncate(text, max, options = {}) {
  if (max < 1) throw new RangeError('max must be at least 1');
  if (text.length <= max) return text;
  const ellipsis = options.ellipsis ?? '…';
  const room = Math.max(0, max - ellipsis.length);
  let cut = text.slice(0, room);
  if (text[room] !== ' ' && cut.includes(' ')) cut = cut.slice(0, cut.lastIndexOf(' '));
  return cut.trimEnd() + ellipsis;
}

module.exports = { slugify, wordCount, truncate };
