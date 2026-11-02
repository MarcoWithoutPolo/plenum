import test from 'node:test';
import assert from 'node:assert';
import {
  FROST_HEAT,
  MAX_HEAT,
  PLAYER,
  SPARK_HEAT,
  SPARK_POINTS,
  WORLD,
  addScore,
  best,
  circlesTouch,
  drainRate,
  lightRadius,
  moveX,
  newGame,
  next,
  shownScore,
  step,
} from '../src/game.js';

const run = (s, seconds, input = {}) => {
  for (let t = 0; t < seconds - 1e-9 && !s.over; t += 1 / 60) s = step(s, 1 / 60, input);
  return s;
};

/** A game with nothing falling for a while, so a test can place objects itself. */
const quiet = (extra = {}) => ({ ...newGame(7), nextSpawn: 100, ...extra });

test('a new game starts centred, full of heat, with no score', () => {
  const s = newGame(3);
  assert.strictEqual(s.x, WORLD.width / 2);
  assert.strictEqual(s.heat, MAX_HEAT);
  assert.strictEqual(shownScore(s), 0);
  assert.strictEqual(s.over, false);
});

test('the random generator is deterministic', () => {
  assert.deepStrictEqual(next(42), next(42));
  assert.notStrictEqual(next(42)[0], next(43)[0]);
  let seed = 1;
  for (let i = 0; i < 1000; i++) {
    let r;
    [r, seed] = next(seed);
    assert.ok(r >= 0 && r < 1);
  }
});

test('surviving scores points and drains heat, faster as time goes on', () => {
  const s = run(quiet(), 2);
  assert.ok(Math.abs(s.score - 20) < 0.5, `about 10 points a second (${s.score})`);
  assert.ok(s.heat < MAX_HEAT);
  assert.ok(drainRate(30) > drainRate(0));
});

test('step is pure: the old state is untouched', () => {
  const a = newGame(5);
  const copy = structuredClone(a);
  const b = step(a, 0.5, { left: true });
  assert.deepStrictEqual(a, copy);
  assert.notStrictEqual(a, b);
  assert.deepStrictEqual(step(a, 0.5, { left: true }), b, 'same input, same result');
});

test('moving left and right, stopping at the walls', () => {
  assert.ok(moveX(100, -1, 0.1) < 100);
  assert.ok(moveX(100, 1, 0.1) > 100);
  assert.strictEqual(moveX(100, 0, 0.1), 100);
  assert.strictEqual(moveX(5, -1, 1), PLAYER.radius);
  assert.strictEqual(moveX(WORLD.width, 1, 1), WORLD.width - PLAYER.radius);
  const s = run(quiet(), 0.5, { left: true });
  assert.ok(s.x < WORLD.width / 2);
  assert.strictEqual(run(quiet(), 0.5, { left: true, right: true }).x, WORLD.width / 2);
});

test('circles touch when their distance is at most the sum of radii', () => {
  assert.ok(circlesTouch(0, 0, 5, 8, 0, 3));
  assert.ok(!circlesTouch(0, 0, 5, 8.1, 0, 3));
});

test('catching a spark warms the ember and scores, with a growing combo', () => {
  const spark = (id, y) => ({ id, kind: 'spark', x: WORLD.width / 2, y, r: 7, spin: 0, speed: 0 });
  let s = quiet({ heat: 50, objects: [spark(1, PLAYER.y)] });
  s = step(s, 1 / 60, {});
  assert.deepStrictEqual(s.objects, []);
  assert.ok(s.heat > 50 + SPARK_HEAT - 1);
  assert.ok(s.score >= SPARK_POINTS);
  assert.deepStrictEqual(
    s.events.map((e) => e.type),
    ['spark'],
  );
  const before = s.score;
  s = step({ ...s, objects: [spark(2, PLAYER.y)] }, 1 / 60, {});
  assert.ok(s.score - before >= 2 * SPARK_POINTS, 'second spark in a row scores double');
  assert.strictEqual(step({ ...s, heat: 99 }, 1 / 60, {}).heat <= MAX_HEAT, true);
});

test('frost steals heat once, then the ember is briefly protected', () => {
  const frost = (id) => ({
    id,
    kind: 'frost',
    x: WORLD.width / 2,
    y: PLAYER.y,
    r: 14,
    spin: 0,
    speed: 0,
  });
  let s = quiet({ heat: 80, objects: [frost(1)] });
  s = step(s, 1 / 60, {});
  assert.ok(s.heat < 80 - FROST_HEAT + 1);
  assert.deepStrictEqual(
    s.events.map((e) => e.type),
    ['frost'],
  );
  const heat = s.heat;
  s = step({ ...s, objects: [frost(2)] }, 1 / 60, {});
  assert.ok(s.heat > heat - 1, 'no second hit while protected');
});

test('the game ends when the heat runs out, and then stops changing', () => {
  let s = step(quiet({ heat: 0.01 }), 1 / 60, {});
  assert.strictEqual(s.over, true);
  assert.strictEqual(s.heat, 0);
  assert.deepStrictEqual(
    s.events.map((e) => e.type),
    ['over'],
  );
  const later = step(s, 1, { left: true });
  assert.strictEqual(later.score, s.score);
  assert.strictEqual(later.x, s.x);
});

test('a player who does nothing loses within 60 seconds, whatever falls', () => {
  for (let seed = 1; seed <= 150; seed++) {
    const s = run(newGame(seed), 60);
    assert.ok(s.over, `seed ${seed} still alight after 60 s`);
  }
});

test('long frames are split up, so nothing tunnels through the ember', () => {
  const frost = {
    id: 1,
    kind: 'frost',
    x: WORLD.width / 2,
    y: PLAYER.y - 40,
    r: 14,
    spin: 0,
    speed: 600,
  };
  const s = step(quiet({ objects: [frost] }), 0.2, {});
  assert.ok(s.events.some((e) => e.type === 'frost'));
});

test('light shrinks as the ember cools', () => {
  assert.ok(lightRadius(100) > lightRadius(20));
  assert.ok(lightRadius(0) > 0);
});

test('high scores keep the best five, best first', () => {
  let t = [];
  for (const n of [10, 50.7, 30, 5, 80, 20, 1]) t = addScore(t, n);
  assert.deepStrictEqual(t, [80, 50, 30, 20, 10]);
  assert.strictEqual(best(t), 80);
  assert.strictEqual(best([]), 0);
  assert.deepStrictEqual(addScore('junk', 3), [3]);
  assert.deepStrictEqual(addScore([4, 'x', -1, NaN], 3), [4, 3]);
});
