// Drawing Emberlight on a canvas. Purely visual: nothing here changes the game.
import { MAX_HEAT, PLAYER, WORLD, lightRadius } from '../src/game.js';

const TAU = Math.PI * 2;

/** Visual-only effects that live between frames: drifting soot, embers' trail, floating text. */
export function createEffects() {
  const soot = Array.from({ length: 40 }, () => ({
    x: Math.random() * WORLD.width,
    y: Math.random() * WORLD.height,
    s: 0.4 + Math.random() * 1.4,
    v: 20 + Math.random() * 50,
  }));
  return { soot, trail: [], bursts: [], texts: [], shake: 0, scroll: 0 };
}

/** Turn game events into effects. */
export function react(fx, events, reducedMotion) {
  for (const e of events) {
    if (e.type === 'spark') {
      for (let i = 0; i < 14; i++) {
        const a = Math.random() * TAU;
        const v = 40 + Math.random() * 120;
        fx.bursts.push({
          x: e.x,
          y: e.y,
          vx: Math.cos(a) * v,
          vy: Math.sin(a) * v,
          life: 0.6,
          max: 0.6,
          hue: 38,
        });
      }
      fx.texts.push({
        x: e.x,
        y: e.y - 14,
        text: e.combo > 1 ? `+${25 * e.combo} ×${e.combo}` : '+25',
        life: 0.9,
      });
    } else if (e.type === 'frost') {
      for (let i = 0; i < 18; i++) {
        const a = Math.random() * TAU;
        const v = 60 + Math.random() * 140;
        fx.bursts.push({
          x: e.x,
          y: e.y,
          vx: Math.cos(a) * v,
          vy: Math.sin(a) * v,
          life: 0.7,
          max: 0.7,
          hue: 200,
        });
      }
      if (!reducedMotion) fx.shake = 0.35;
    }
  }
}

function updateEffects(fx, dt, state, moving) {
  fx.scroll = (fx.scroll + dt * (moving ? 140 + state.time * 3 : 18)) % 48;
  for (const p of fx.soot) {
    p.y += p.v * dt * (moving ? 1.6 : 0.4);
    if (p.y > WORLD.height) {
      p.y = -4;
      p.x = Math.random() * WORLD.width;
    }
  }
  if (moving) fx.trail.push({ x: state.x + (Math.random() - 0.5) * 6, y: PLAYER.y + 6, life: 0.5 });
  for (const t of fx.trail) {
    t.life -= dt;
    t.y += 90 * dt;
  }
  fx.trail = fx.trail.filter((t) => t.life > 0);
  for (const b of fx.bursts) {
    b.life -= dt;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.vx *= 0.96;
    b.vy *= 0.96;
  }
  fx.bursts = fx.bursts.filter((b) => b.life > 0);
  for (const t of fx.texts) {
    t.life -= dt;
    t.y -= 40 * dt;
  }
  fx.texts = fx.texts.filter((t) => t.life > 0);
  fx.shake = Math.max(0, fx.shake - dt);
}

function background(ctx, fx) {
  const g = ctx.createLinearGradient(0, 0, 0, WORLD.height);
  g.addColorStop(0, '#0b0816');
  g.addColorStop(0.6, '#1a1030');
  g.addColorStop(1, '#2a1530');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, WORLD.width, WORLD.height);

  // Chimney bricks down both sides, scrolling past as the ember rises.
  ctx.fillStyle = 'rgba(255,255,255,0.045)';
  for (let y = -48 + fx.scroll; y < WORLD.height; y += 24) {
    const row = Math.round((y - fx.scroll) / 24) % 2 === 0;
    for (const side of [0, WORLD.width - 26]) {
      ctx.fillRect(side + (row ? 0 : 6), y, 20, 20);
    }
  }
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  for (const p of fx.soot) {
    ctx.globalAlpha = 0.15 + p.s * 0.15;
    ctx.fillRect(p.x, p.y, p.s, p.s * 3);
  }
  ctx.globalAlpha = 1;
}

function frost(ctx, o, t) {
  ctx.save();
  ctx.translate(o.x, o.y);
  ctx.rotate(o.spin * t);
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU;
    ctx.lineTo(Math.cos(a) * o.r, Math.sin(a) * o.r);
  }
  ctx.closePath();
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, o.r);
  g.addColorStop(0, '#e9f8ff');
  g.addColorStop(0.5, '#8fd3ff');
  g.addColorStop(1, '#3a7bd5');
  ctx.fillStyle = g;
  ctx.fill();
  ctx.strokeStyle = 'rgba(233,248,255,0.8)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI;
    ctx.moveTo(Math.cos(a) * o.r * 0.8, Math.sin(a) * o.r * 0.8);
    ctx.lineTo(-Math.cos(a) * o.r * 0.8, -Math.sin(a) * o.r * 0.8);
  }
  ctx.stroke();
  ctx.restore();
}

function spark(ctx, o, t) {
  const pulse = 1 + Math.sin(t * 9 + o.id) * 0.18;
  const glow = ctx.createRadialGradient(o.x, o.y, 0, o.x, o.y, o.r * 3.2 * pulse);
  glow.addColorStop(0, 'rgba(255,230,160,0.95)');
  glow.addColorStop(0.3, 'rgba(255,177,92,0.55)');
  glow.addColorStop(1, 'rgba(255,138,61,0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(o.x, o.y, o.r * 3.2 * pulse, 0, TAU);
  ctx.fill();
  ctx.fillStyle = '#fff6dc';
  ctx.beginPath();
  ctx.arc(o.x, o.y, o.r * 0.55, 0, TAU);
  ctx.fill();
}

function ember(ctx, state, fx, t) {
  for (const p of fx.trail) {
    ctx.globalAlpha = p.life * 1.4;
    ctx.fillStyle = '#ff8a3d';
    ctx.beginPath();
    ctx.arc(p.x, p.y, 1 + p.life * 4, 0, TAU);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  if (state.invulnerable && Math.floor(t * 14) % 2) return;
  const warm = state.heat / MAX_HEAT;
  const flicker = 1 + Math.sin(t * 23) * 0.06 + Math.sin(t * 7) * 0.05;
  const r = PLAYER.radius * flicker;
  const glow = ctx.createRadialGradient(state.x, PLAYER.y, 0, state.x, PLAYER.y, r * 3.4);
  glow.addColorStop(0, 'rgba(255,240,200,1)');
  glow.addColorStop(0.3, `rgba(255,${Math.round(120 + 70 * warm)},60,0.9)`);
  glow.addColorStop(1, 'rgba(255,90,40,0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(state.x, PLAYER.y, r * 3.4, 0, TAU);
  ctx.fill();
  ctx.fillStyle = '#fff4d6';
  ctx.beginPath();
  ctx.arc(state.x, PLAYER.y, r * 0.55, 0, TAU);
  ctx.fill();
}

function darkness(ctx, state) {
  const R = lightRadius(state.heat);
  const g = ctx.createRadialGradient(state.x, PLAYER.y, R * 0.25, state.x, PLAYER.y, R);
  g.addColorStop(0, 'rgba(6,4,14,0)');
  g.addColorStop(0.55, 'rgba(6,4,14,0.25)');
  g.addColorStop(1, 'rgba(6,4,14,0.93)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, WORLD.width, WORLD.height);
}

function heatBar(ctx, state) {
  const w = WORLD.width - 32;
  const x = 16;
  const y = 14;
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  roundRect(ctx, x, y, w, 8, 4);
  ctx.fill();
  const g = ctx.createLinearGradient(x, 0, x + w, 0);
  g.addColorStop(0, '#8fd3ff');
  g.addColorStop(0.35, '#ff8a3d');
  g.addColorStop(1, '#ffe6a0');
  ctx.fillStyle = g;
  roundRect(ctx, x, y, Math.max(0, (w * state.heat) / MAX_HEAT), 8, 4);
  ctx.fill();
  ctx.fillStyle = 'rgba(246,238,230,0.75)';
  ctx.font = '600 10px system-ui, sans-serif';
  ctx.textBaseline = 'top';
  ctx.fillText('HEAT', x, y + 13);
  if (state.combo > 1) {
    ctx.textAlign = 'right';
    ctx.fillStyle = '#ffb15c';
    ctx.fillText(`COMBO ×${state.combo}`, x + w, y + 13);
    ctx.textAlign = 'left';
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Draw one frame. `scale` maps world units to canvas pixels; `t` is a free-running clock for
 * flicker; `moving` is whether the game is running (so the world scrolls).
 */
export function draw(ctx, state, fx, { scale, dt, t, moving }) {
  updateEffects(fx, dt, state, moving);
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  if (fx.shake) {
    const k = fx.shake * 14;
    ctx.translate((Math.random() - 0.5) * k, (Math.random() - 0.5) * k);
  }
  background(ctx, fx);
  for (const o of state.objects) if (o.kind === 'frost') frost(ctx, o, state.time);
  darkness(ctx, state);
  // Sparks glow through the dark; frost hides in it.
  for (const o of state.objects) if (o.kind === 'spark') spark(ctx, o, t);
  ember(ctx, state, fx, t);
  for (const b of fx.bursts) {
    ctx.globalAlpha = b.life / b.max;
    ctx.fillStyle = b.hue > 100 ? '#cdeeff' : '#ffd08a';
    ctx.fillRect(b.x - 1.5, b.y - 1.5, 3, 3);
  }
  ctx.globalAlpha = 1;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '800 14px system-ui, sans-serif';
  for (const tx of fx.texts) {
    ctx.globalAlpha = Math.min(1, tx.life * 1.6);
    ctx.fillStyle = '#ffe1a8';
    ctx.fillText(tx.text, tx.x, tx.y);
  }
  ctx.globalAlpha = 1;
  ctx.textAlign = 'left';
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  heatBar(ctx, state);
}
