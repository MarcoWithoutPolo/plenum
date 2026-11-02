/** Pure board logic: a board is { todo: Card[], doing: Card[], done: Card[] }, a card { id, text }. */
export const COLUMNS = ['todo', 'doing', 'done'];

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
