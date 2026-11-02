/** Pure board logic: a board is { todo: Card[], doing: Card[], done: Card[] }, a card { id, text }. */
export const COLUMNS = ['todo', 'doing', 'done'];

/** Column names as shown on the board. */
export const COLUMN_NAMES = { todo: 'To do', doing: 'Doing', done: 'Done' };

export const THEMES = ['system', 'light', 'dark'];

export const emptyBoard = () => ({ todo: [], doing: [], done: [] });

export function addCard(board, text, id = String(Date.now() + Math.random())) {
  const clean = String(text ?? '').trim();
  if (!clean) return board;
  return { ...board, todo: [...board.todo, { id, text: clean }] };
}

export function moveCard(board, id, direction) {
  const from = COLUMNS.find((c) => board[c].some((card) => card.id === id));
  if (!from) return board;
  const to = COLUMNS[COLUMNS.indexOf(from) + (direction === 'left' ? -1 : 1)];
  if (!to) return board;
  const card = board[from].find((c) => c.id === id);
  return { ...board, [from]: board[from].filter((c) => c.id !== id), [to]: [...board[to], card] };
}

export function removeCard(board, id) {
  return Object.fromEntries(COLUMNS.map((c) => [c, board[c].filter((card) => card.id !== id)]));
}

export function load(storage) {
  try {
    const data = JSON.parse(storage.getItem('kanban') ?? 'null');
    if (data && COLUMNS.every((c) => Array.isArray(data[c]))) return data;
  } catch {
    // a damaged save starts a fresh board
  }
  return emptyBoard();
}

export function save(storage, board) {
  storage.setItem('kanban', JSON.stringify(board));
}

/** One CSV field, quoted when it holds a comma, a double quote or a line break (RFC 4180). */
function csvField(value) {
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/** The board as CSV: a `column,text` header, then one line per card in board order. */
export function toCsv(board) {
  const rows = [['column', 'text']];
  for (const c of COLUMNS) for (const card of board[c]) rows.push([COLUMN_NAMES[c], card.text]);
  return rows.map((row) => row.map(csvField).join(',')).join('\r\n') + '\r\n';
}

/** The saved theme choice: 'system', 'light' or 'dark'. */
export function loadTheme(storage) {
  try {
    const theme = storage.getItem('kanban-theme');
    return THEMES.includes(theme) ? theme : 'system';
  } catch {
    return 'system';
  }
}

export function saveTheme(storage, theme) {
  storage.setItem('kanban-theme', THEMES.includes(theme) ? theme : 'system');
}
