// The recipe book page: list, search, details, and the add/edit form.
const $ = (id) => document.getElementById(id);
const state = { recipes: [], selected: null, editing: null };

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
  });
  const body = res.status === 204 ? null : await res.json();
  if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
  return body;
}

const lines = (text) =>
  text
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  Object.assign(e, props);
  e.append(...children.filter((c) => c !== null && c !== undefined));
  return e;
}

async function refresh() {
  const q = $('search').value.trim();
  state.recipes = await api(`/api/recipes${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  renderList();
}

function renderList() {
  const list = $('list');
  list.replaceChildren(
    ...state.recipes.map((r) => {
      const button = el(
        'button',
        { type: 'button', className: 'item' },
        el('span', { textContent: r.title }),
      );
      if (r.minutes)
        button.append(el('span', { className: 'muted', textContent: `${r.minutes} min` }));
      button.addEventListener('click', () => show(r.id));
      const li = el('li', {}, button);
      li.dataset.recipe = String(r.id);
      if (state.selected === r.id) li.classList.add('selected');
      return li;
    }),
  );
  $('empty').hidden = state.recipes.length > 0;
  $('empty').textContent = $('search').value.trim() ? 'No recipes match.' : 'No recipes yet.';
}

function section(title, items, ordered = false) {
  if (!items.length) return null;
  return el(
    'section',
    {},
    el('h3', { textContent: title }),
    el(ordered ? 'ol' : 'ul', {}, ...items.map((t) => el('li', { textContent: t }))),
  );
}

async function show(id) {
  const r = await api(`/api/recipes/${id}`);
  state.selected = id;
  const detail = document.querySelector('[data-recipe-detail]');
  const meta = [r.minutes ? `${r.minutes} minutes` : null, r.tags.length ? r.tags.join(', ') : null]
    .filter(Boolean)
    .join(' · ');
  const edit = el('button', { type: 'button', textContent: 'Edit' });
  edit.addEventListener('click', () => startEdit(r));
  const remove = el('button', { type: 'button', className: 'secondary', textContent: 'Delete' });
  remove.addEventListener('click', async () => {
    await api(`/api/recipes/${r.id}`, { method: 'DELETE' });
    state.selected = null;
    detail.hidden = true;
    await refresh();
  });
  detail.replaceChildren(
    el('h2', { textContent: r.title }),
    meta ? el('p', { className: 'muted', textContent: meta }) : null,
    r.hasPhoto
      ? el('img', { src: `/api/recipes/${r.id}/photo?v=${Date.now()}`, alt: r.title })
      : null,
    section('Ingredients', r.ingredients),
    section('Steps', r.steps, true),
    el('div', { className: 'actions' }, edit, remove),
  );
  detail.hidden = false;
  renderList();
}

function startEdit(r) {
  state.editing = r.id;
  $('form-heading').textContent = `Edit “${r.title}”`;
  $('title').value = r.title;
  $('ingredients').value = r.ingredients.join('\n');
  $('steps').value = r.steps.join('\n');
  $('tags').value = r.tags.join(', ');
  $('minutes').value = r.minutes ?? '';
  $('cancel').hidden = false;
  $('message').textContent = '';
  $('title').focus();
}

function resetForm() {
  state.editing = null;
  $('form').reset();
  $('form-heading').textContent = 'New recipe';
  $('cancel').hidden = true;
}

const readFile = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

async function save(event) {
  event.preventDefault();
  const message = $('message');
  message.textContent = '';
  const title = $('title').value.trim();
  if (!title) {
    message.textContent = 'Please give the recipe a title.';
    $('title').focus();
    return;
  }
  const minutesText = $('minutes').value.trim();
  const minutes = minutesText ? Number(minutesText) : null;
  if (minutes !== null && !(Number.isInteger(minutes) && minutes > 0)) {
    message.textContent = 'Minutes must be a whole number above 0.';
    return;
  }
  const recipe = {
    title,
    ingredients: lines($('ingredients').value),
    steps: lines($('steps').value),
    tags: $('tags')
      .value.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    minutes,
  };
  try {
    const saved = state.editing
      ? await api(`/api/recipes/${state.editing}`, { method: 'PUT', body: JSON.stringify(recipe) })
      : await api('/api/recipes', { method: 'POST', body: JSON.stringify(recipe) });
    const file = $('photo').files[0];
    if (file) {
      if (file.size > 2 * 1024 * 1024) throw new Error('The photo is larger than 2 MB.');
      await api(`/api/recipes/${saved.id}/photo`, {
        method: 'POST',
        body: JSON.stringify({ dataUrl: await readFile(file) }),
      });
    }
    resetForm();
    await refresh();
    if (state.selected === saved.id || file) await show(saved.id);
  } catch (e) {
    message.textContent = e.message;
  }
}

let timer;
$('search').addEventListener('input', () => {
  clearTimeout(timer);
  timer = setTimeout(() => refresh().catch((e) => ($('message').textContent = e.message)), 120);
});
$('form').addEventListener('submit', save);
$('cancel').addEventListener('click', resetForm);
refresh().catch((e) => ($('message').textContent = e.message));
