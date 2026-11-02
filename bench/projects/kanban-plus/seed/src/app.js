import { COLUMNS, addCard, load, moveCard, removeCard, save } from './board.js';

const NAMES = { todo: 'To do', doing: 'Doing', done: 'Done' };
let board = load(localStorage);

const boardEl = document.querySelector('#board');
const form = document.querySelector('#add');
const input = document.querySelector('#new-card');

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
      h2.append(NAMES[name], ' ', count);
      const list = document.createElement('ul');
      for (const card of board[name]) {
        const li = document.createElement('li');
        li.className = 'card';
        li.dataset.card = '';
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

render();
