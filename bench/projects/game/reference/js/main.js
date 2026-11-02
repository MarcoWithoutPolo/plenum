// Emberlight in the page: the loop, the controls, the screens and the high scores.
import { WORLD, addScore, best, newGame, shownScore, step } from '../src/game.js';
import { createEffects, draw, react } from './render.js';

const SCORES_KEY = 'emberlight.scores';

const body = document.body;
const canvas = document.querySelector('#game');
const ctx = canvas.getContext('2d');
const screen = document.querySelector('.screen');
const scoreEl = document.querySelector('[data-score]');
const bestEl = document.querySelector('[data-best]');
const pauseBtn = document.querySelector('[data-pause]');
const startBtn = document.querySelector('[data-start]');
const kicker = document.querySelector('[data-kicker]');
const headline = document.querySelector('[data-headline]');
const message = document.querySelector('[data-message]');
const table = document.querySelector('[data-table]');
const tableList = document.querySelector('[data-scores]');
const announce = document.querySelector('[data-announce]');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

let mode = 'ready';
let game = newGame(1);
let fx = createEffects();
let scores = loadScores();
let scale = 1;
const held = { left: false, right: false, keyLeft: false, keyRight: false };

/* ---------- High scores ---------- */

function loadScores() {
  try {
    return addScore(JSON.parse(localStorage.getItem(SCORES_KEY) ?? '[]'), 0).filter((n) => n > 0);
  } catch {
    return [];
  }
}

function saveScores() {
  try {
    localStorage.setItem(SCORES_KEY, JSON.stringify(scores));
  } catch {
    // Storage blocked: scores last for this visit.
  }
}

function renderTable(latest) {
  table.hidden = scores.length === 0;
  let marked = false;
  tableList.replaceChildren(
    ...scores.map((n) => {
      const li = document.createElement('li');
      const value = document.createElement('span');
      value.textContent = String(n);
      li.append(value);
      if (!marked && n === latest) {
        li.className = 'latest';
        marked = true;
      }
      return li;
    }),
  );
}

/* ---------- States ---------- */

function setMode(next) {
  mode = next;
  body.dataset.state = next;
  pauseBtn.disabled = next !== 'playing' && next !== 'paused';
  pauseBtn.setAttribute('aria-pressed', String(next === 'paused'));
  if (next !== 'playing') releaseAll();
}

function start() {
  if (mode !== 'ready' && mode !== 'over') return;
  game = newGame((Date.now() ^ (Math.random() * 0x7fffffff)) | 0);
  fx = createEffects();
  scoreEl.textContent = '0';
  setMode('playing');
  announce.textContent = 'Game started.';
  if (document.activeElement === startBtn) startBtn.blur();
}

function togglePause() {
  if (mode === 'playing') {
    setMode('paused');
    announce.textContent = 'Paused.';
  } else if (mode === 'paused') {
    setMode('playing');
    announce.textContent = 'Playing.';
  }
}

function gameOver() {
  const final = shownScore(game);
  const previous = best(scores);
  scores = addScore(scores, final).filter((n) => n > 0);
  saveScores();
  bestEl.textContent = String(best(scores));
  scoreEl.textContent = String(final);
  const record = final > previous;
  kicker.textContent = record ? 'New best!' : 'The ember went out';
  headline.textContent = `${final} points`;
  message.textContent = record
    ? `You beat your best by ${final - previous}. Can you keep it burning even longer?`
    : `Your best is ${best(scores)}. Sparks in a row are worth more.`;
  renderTable(final);
  setMode('over');
  announce.textContent = `Game over. ${final} points.${record ? ' New best!' : ''}`;
  startBtn.focus({ preventScroll: true });
}

/* ---------- Input ---------- */

function releaseAll() {
  held.left = held.right = held.keyLeft = held.keyRight = false;
  for (const b of document.querySelectorAll('[data-move]')) b.classList.remove('held');
}

const input = () => ({ left: held.left || held.keyLeft, right: held.right || held.keyRight });

window.addEventListener('keydown', (e) => {
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  const k = e.key;
  if (k === 'ArrowLeft' || k === 'a' || k === 'A') {
    held.keyLeft = mode === 'playing';
    e.preventDefault();
  } else if (k === 'ArrowRight' || k === 'd' || k === 'D') {
    held.keyRight = mode === 'playing';
    e.preventDefault();
  } else if (k === ' ' || k === 'Spacebar') {
    // A focused button handles Space itself.
    if (e.target instanceof Element && e.target.closest('button')) return;
    e.preventDefault();
    if (!e.repeat) start();
  } else if (k === 'p' || k === 'P') {
    if (!e.repeat) togglePause();
  } else if (k === 'Escape') {
    if (mode === 'playing') togglePause();
  }
});

window.addEventListener('keyup', (e) => {
  if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') held.keyLeft = false;
  if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') held.keyRight = false;
});

window.addEventListener('blur', releaseAll);
document.addEventListener('visibilitychange', () => {
  if (document.hidden && mode === 'playing') togglePause();
});

startBtn.addEventListener('click', start);
pauseBtn.addEventListener('click', togglePause);

// On-screen buttons: hold to move. They work with touch, a mouse or a pen.
for (const b of document.querySelectorAll('[data-move]')) {
  const dir = b.dataset.move;
  const press = (on) => {
    held[dir] = on && mode === 'playing';
    b.classList.toggle('held', held[dir]);
  };
  b.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    b.setPointerCapture?.(e.pointerId);
    press(true);
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'])
    b.addEventListener(type, () => press(false));
  b.addEventListener('contextmenu', (e) => e.preventDefault());
  // Keyboard activation of the on-screen buttons: a short nudge.
  b.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      press(true);
    }
  });
  b.addEventListener('keyup', (e) => {
    if (e.key === 'Enter' || e.key === ' ') press(false);
  });
}
// Keep keyboard focus off the HUD button after a mouse click, so Space keeps meaning "start".
pauseBtn.addEventListener('pointerdown', (e) => e.preventDefault());

/* ---------- Layout ---------- */

function fit() {
  const stage = screen.parentElement;
  const narrow = window.matchMedia('(max-width: 699px)').matches;
  const app = document.querySelector('.app');
  const appStyle = getComputedStyle(app);
  const padX = parseFloat(appStyle.paddingLeft) + parseFloat(appStyle.paddingRight);
  const touches = [...document.querySelectorAll('.touch')];
  const touchW = touches.reduce((w, t) => w + t.offsetWidth, 0) + 40;
  const touchH = Math.max(...touches.map((t) => t.offsetHeight)) + 12;
  const hud = document.querySelector('.hud').offsetHeight;
  const availW =
    Math.min(stage.clientWidth || window.innerWidth - padX, window.innerWidth - padX) -
    (narrow ? 0 : touchW);
  const availH = window.innerHeight - hud - 36 - (narrow ? touchH : 0);
  scale = Math.max(0.5, Math.min(availW / WORLD.width, availH / WORLD.height));
  const w = Math.floor(WORLD.width * scale);
  const h = Math.floor(WORLD.height * scale);
  screen.style.width = `${w}px`;
  screen.style.height = `${h}px`;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  scale = (w * dpr) / WORLD.width;
}

window.addEventListener('resize', fit);
fit();

/* ---------- Loop ---------- */

let last = performance.now();
let clock = 0;
let shownX = '';

function frame(now) {
  const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
  last = now;
  if (mode !== 'paused') clock += dt;
  if (mode === 'playing') {
    game = step(game, dt, input());
    react(fx, game.events, reducedMotion.matches);
    const s = String(shownScore(game));
    if (scoreEl.textContent !== s) scoreEl.textContent = s;
    if (game.over) gameOver();
  }
  const x = game.x.toFixed(1);
  if (x !== shownX) {
    canvas.dataset.playerX = x;
    shownX = x;
  }
  draw(ctx, game, fx, {
    scale,
    dt: mode === 'paused' ? 0 : dt,
    t: clock,
    moving: mode === 'playing',
  });
  requestAnimationFrame(frame);
}

bestEl.textContent = String(best(scores));
renderTable();
setMode('ready');
requestAnimationFrame(frame);
