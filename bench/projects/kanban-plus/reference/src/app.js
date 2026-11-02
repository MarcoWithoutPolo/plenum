import {
  COLUMNS,
  COLUMN_NAMES,
  addCard,
  load,
  loadTheme,
  moveCard,
  removeCard,
  save,
  saveTheme,
  toCsv,
} from './board.js';

let board = load(localStorage);

const boardEl = document.querySelector('#board');
const form = document.querySelector('#add');
const input = document.querySelector('#new-card');
const themeSelect = document.querySelector('#theme');
const exportButton = document.querySelector('#export');
const shortcuts = document.querySelector('#shortcuts');
const showShortcuts = document.querySelector('#show-shortcuts');

function button(label, text, disabled, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.setAttribute('aria-label', label);
  b.textContent = text;
  b.disabled = disabled;
  b.addEventListener('click', onClick);
  return b;
}

function update(next) {
  board = next;
  save(localStorage, board);
  render();
}

const cardEl = (id) => boardEl.querySelector(`[data-card][data-id="${CSS.escape(id)}"]`);

function render() {
  boardEl.replaceChildren(
    ...COLUMNS.map((name, i) => {
      const section = document.createElement('section');
      section.className = 'column';
      section.dataset.column = name;
      const h2 = document.createElement('h2');
      const count = document.createElement('span');
      count.className = 'count';
      count.dataset.count = '';
      count.textContent = String(board[name].length);
      h2.append(COLUMN_NAMES[name], ' ', count);
      const list = document.createElement('ul');
      for (const card of board[name]) {
        const li = document.createElement('li');
        li.className = 'card';
        li.dataset.card = '';
        li.dataset.id = card.id;
        li.tabIndex = 0;
        li.setAttribute('aria-keyshortcuts', 'ArrowLeft ArrowRight Delete');
        const text = document.createElement('p');
        text.textContent = card.text;
        const actions = document.createElement('div');
        actions.className = 'actions';
        actions.append(
          button('Move left', '←', i === 0, () => update(moveCard(board, card.id, 'left'))),
          button('Move right', '→', i === COLUMNS.length - 1, () =>
            update(moveCard(board, card.id, 'right')),
          ),
          button('Delete', '✕', false, () => update(removeCard(board, card.id))),
        );
        li.append(text, actions);
        list.append(li);
      }
      section.append(h2, list);
      return section;
    }),
  );
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  if (input.value.trim()) update(addCard(board, input.value));
  input.value = '';
});

// --- Theme ---

function applyTheme(theme) {
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  themeSelect.value = theme;
}

themeSelect.addEventListener('change', () => {
  saveTheme(localStorage, themeSelect.value);
  applyTheme(themeSelect.value);
});

// --- Export ---

exportButton.addEventListener('click', () => {
  // A byte-order mark so spreadsheet apps read the file as UTF-8.
  const blob = new Blob(['\uFEFF', toCsv(board)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'kanban.csv';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

// --- Keyboard ---

showShortcuts.addEventListener('click', () => shortcuts.showModal());

const isTyping = (el) =>
  el instanceof HTMLElement &&
  (el.isContentEditable || el.closest('input, textarea, select') !== null);

/** Move the focused card and keep focus on it. */
function moveFocused(id, direction) {
  const next = moveCard(board, id, direction);
  if (next === board) return;
  update(next);
  cardEl(id)?.focus();
}

/** Delete the focused card and move focus to its neighbour, or to the New card field. */
function deleteFocused(id) {
  const column = COLUMNS.find((c) => board[c].some((card) => card.id === id));
  const index = board[column].findIndex((card) => card.id === id);
  update(removeCard(board, id));
  const rest = board[column];
  const neighbour = rest[Math.min(index, rest.length - 1)];
  if (neighbour) cardEl(neighbour.id)?.focus();
  else input.focus();
}

document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
  if (shortcuts.open || isTyping(e.target)) return;
  const card = e.target instanceof HTMLElement && e.target.matches('[data-card]') ? e.target : null;
  if (card && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    e.preventDefault();
    moveFocused(card.dataset.id, e.key === 'ArrowLeft' ? 'left' : 'right');
  } else if (card && e.key === 'Delete') {
    e.preventDefault();
    deleteFocused(card.dataset.id);
  } else if (e.key === 'n' || e.key === 'N') {
    e.preventDefault();
    input.focus();
  } else if (e.key === '?') {
    e.preventDefault();
    shortcuts.showModal();
  }
});

applyTheme(loadTheme(localStorage));
render();
