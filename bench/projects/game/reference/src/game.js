// Emberlight: the game's rules, as pure functions. No DOM, no clock, no Math.random.
//
// You are an ember rising up a cold chimney at night. Your heat drains all the time, and faster
// the longer you last. Catch falling sparks to stay alight; dodge frost shards, which steal heat.
// Your light shrinks as you cool, so the colder you get, the less of the chimney you can see.

export const WORLD = { width: 360, height: 560 };
export const PLAYER = { y: 470, radius: 11, speed: 240 };
export const MAX_HEAT = 100;

export const SPARK_HEAT = 16;
export const FROST_HEAT = 28;
export const SURVIVAL_POINTS = 10; // per second
export const SPARK_POINTS = 25; // times the combo
export const MAX_COMBO = 5;
const COMBO_WINDOW = 2.2; // seconds to catch the next spark and keep the combo
const INVULNERABLE = 1; // seconds after a frost hit
const MAX_STEP = 1 / 60;

/** Heat lost per second, t seconds into the game. */
export const drainRate = (t) => 5 + 0.12 * t;
/** How fast things fall, in world units per second. */
export const fallSpeed = (t) => 130 + 3.5 * Math.min(t, 90);
/** Seconds between spawns. */
export const spawnInterval = (t) => Math.max(0.32, 0.85 - 0.012 * t);
/** Share of spawns that are frost rather than sparks. */
export const frostChance = (t) => Math.min(0.72, 0.45 + 0.006 * t);
/** How far the ember's light reaches, from its heat. */
export const lightRadius = (heat) => 70 + 2.1 * Math.max(0, heat);

/** A small seeded generator (mulberry32): `next(seed)` gives [value in [0, 1), next seed]. */
export function next(seed) {
  let t = (seed + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, (seed + 0x6d2b79f5) | 0];
}

export function newGame(seed = 1) {
  return {
    time: 0,
    heat: MAX_HEAT,
    score: 0,
    x: WORLD.width / 2,
    objects: [],
    nextSpawn: 0.9,
    nextId: 1,
    combo: 0,
    comboTimer: 0,
    invulnerable: 0,
    over: false,
    seed: seed | 0,
    events: [],
  };
}

export function circlesTouch(ax, ay, ar, bx, by, br) {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy <= (ar + br) * (ar + br);
}

/** The ember's new x after moving `dir` (-1, 0 or 1) for dt seconds, kept inside the walls. */
export function moveX(x, dir, dt) {
  const min = PLAYER.radius;
  const max = WORLD.width - PLAYER.radius;
  return Math.min(max, Math.max(min, x + Math.sign(dir) * PLAYER.speed * dt));
}

export function direction(input = {}) {
  return (input.right ? 1 : 0) - (input.left ? 1 : 0);
}

function spawn(s) {
  let r;
  [r, s.seed] = next(s.seed);
  const frost = r < frostChance(s.time);
  [r, s.seed] = next(s.seed);
  const radius = frost ? 12 + r * 10 : 7;
  [r, s.seed] = next(s.seed);
  const x = radius + r * (WORLD.width - 2 * radius);
  [r, s.seed] = next(s.seed);
  s.objects.push({
    id: s.nextId++,
    kind: frost ? 'frost' : 'spark',
    x,
    y: -radius,
    r: radius,
    spin: (r - 0.5) * 3,
    speed: fallSpeed(s.time) * (frost ? 1 : 0.85),
  });
}

function tick(s, dt, dir) {
  s.time += dt;
  s.x = moveX(s.x, dir, dt);
  s.score += SURVIVAL_POINTS * dt;
  s.heat -= drainRate(s.time) * dt;
  s.invulnerable = Math.max(0, s.invulnerable - dt);
  s.comboTimer = Math.max(0, s.comboTimer - dt);
  if (!s.comboTimer) s.combo = 0;

  s.nextSpawn -= dt;
  while (s.nextSpawn <= 0) {
    spawn(s);
    s.nextSpawn += spawnInterval(s.time);
  }

  const kept = [];
  for (const o of s.objects) {
    const y = o.y + o.speed * dt;
    const moved = { ...o, y };
    if (
      circlesTouch(s.x, PLAYER.y, PLAYER.radius, o.x, y, o.r * (o.kind === 'frost' ? 0.8 : 1.4))
    ) {
      if (o.kind === 'spark') {
        s.combo = Math.min(MAX_COMBO, s.combo + 1);
        s.comboTimer = COMBO_WINDOW;
        s.heat = Math.min(MAX_HEAT, s.heat + SPARK_HEAT);
        s.score += SPARK_POINTS * s.combo;
        s.events.push({ type: 'spark', x: o.x, y, combo: s.combo });
        continue;
      }
      if (!s.invulnerable) {
        s.heat -= FROST_HEAT;
        s.invulnerable = INVULNERABLE;
        s.combo = 0;
        s.comboTimer = 0;
        s.events.push({ type: 'frost', x: o.x, y });
        continue;
      }
    }
    if (y - o.r <= WORLD.height) kept.push(moved);
  }
  s.objects = kept;

  if (s.heat <= 0) {
    s.heat = 0;
    s.over = true;
    s.events.push({ type: 'over', score: Math.floor(s.score) });
  }
}

/**
 * Advance the game by dt seconds with the given input ({ left, right }). Returns a new state; the
 * old one is untouched. `events` lists what happened during this step, for effects.
 */
export function step(state, dt, input) {
  if (state.over || !(dt > 0)) return { ...state, events: [] };
  const s = { ...state, objects: [...state.objects], events: [] };
  const dir = direction(input);
  let left = Math.min(dt, 0.25);
  while (left > 1e-9 && !s.over) {
    const d = Math.min(MAX_STEP, left);
    tick(s, d, dir);
    left -= d;
  }
  return s;
}

export const shownScore = (state) => Math.floor(state.score);

/** The high-score table after a game: best first, at most `keep` entries. */
export function addScore(table, score, keep = 5) {
  const clean = (Array.isArray(table) ? table : []).filter((n) => Number.isFinite(n) && n >= 0);
  return [...clean, Math.floor(score)].sort((a, b) => b - a).slice(0, keep);
}

export const best = (table) => (table.length ? table[0] : 0);
