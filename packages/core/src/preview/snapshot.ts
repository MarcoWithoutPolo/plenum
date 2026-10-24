/**
 * Screenshots and the free visual checks (v0.8 C2, C4). One capture routine speaks the Chrome
 * DevTools Protocol, so the desktop app (Electron's own Chromium) and the CLI (a headless Chrome
 * or Edge) share it; only the connection differs.
 */

import { inflateSync } from 'node:zlib';

export interface View {
  width: number;
  height: number;
  scheme: 'light' | 'dark';
}

/** What the page itself reported, measured in the page after it loaded. */
export interface PageMetrics {
  scrollWidth: number;
  innerWidth: number;
  scrollHeight: number;
  textLength: number;
  images: number;
  /** Visible text below WCAG AA contrast (4.5:1, or 3:1 for large text) against its background. */
  lowContrast: { el: string; ratio: number; needed: number }[];
  /** Visible buttons and links smaller than 44 × 44 px. */
  smallTargets: { el: string; width: number; height: number }[];
}

export interface Snapshot {
  png: Buffer;
  consoleErrors: string[];
  failedRequests: string[];
  metrics: PageMetrics;
}

export interface Snapshotter {
  capture(url: string, view: View): Promise<Snapshot>;
  close?(): Promise<void>;
}

/** A DevTools Protocol connection to one page: Electron's debugger or a Chrome tab's WebSocket. */
export interface CdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  on(event: string, handler: (params: Record<string, unknown>) => void): () => void;
}

/** Runs in the page. Kept dependency-free and self-contained: it is sent as a string. */
export const PAGE_PROBE = `(() => {
  const parse = (c) => { const m = /rgba?\\(([^)]+)\\)/.exec(c || ''); if (!m) return [0, 0, 0, 0]; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p[3] === undefined ? 1 : p[3]]; };
  const over = (top, under) => { const a = top[3]; return [0, 1, 2].map((i) => top[i] * a + under[i] * (1 - a)).concat(1); };
  const dark = matchMedia('(prefers-color-scheme: dark)').matches && /dark/.test(getComputedStyle(document.documentElement).colorScheme);
  const canvas = dark ? [18, 18, 18, 1] : [255, 255, 255, 1];
  const bgOf = (el) => { const chain = []; for (let e = el; e; e = e.parentElement) chain.push(parse(getComputedStyle(e).backgroundColor)); let c = canvas; for (const b of chain.reverse()) if (b[3] > 0) c = over(b, c); return c; };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const visible = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0 && !e.closest('[hidden],[aria-hidden="true"]'); };
  const name = (e) => { const t = (e.getAttribute('aria-label') || e.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40); const id = e.id ? '#' + e.id : e.classList[0] ? '.' + e.classList[0] : ''; return e.tagName.toLowerCase() + id + (t ? ' "' + t + '"' : ''); };
  const lowContrast = [];
  for (const e of document.querySelectorAll('body *')) {
    if (lowContrast.length >= 20) break;
    if (e.disabled || !visible(e)) continue;
    if (![...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    const s = getComputedStyle(e);
    const size = parseFloat(s.fontSize);
    const large = size >= 24 || (size >= 18.66 && Number(s.fontWeight) >= 700);
    const needed = large ? 3 : 4.5;
    const bg = bgOf(e);
    const r = ratio(over(parse(s.color), bg), bg);
    if (r < needed) lowContrast.push({ el: name(e), ratio: Math.round(r * 100) / 100, needed });
  }
  const smallTargets = [];
  for (const e of document.querySelectorAll('button, a[href], input[type=button], input[type=submit], input[type=checkbox], input[type=radio], [role=button], select')) {
    if (smallTargets.length >= 20) break;
    if (e.disabled || !visible(e)) continue;
    const r = e.getBoundingClientRect();
    if (r.width < 43.5 || r.height < 43.5) smallTargets.push({ el: name(e), width: Math.round(r.width), height: Math.round(r.height) });
  }
  return {
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    scrollHeight: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0),
    textLength: document.body ? document.body.innerText.trim().length : 0,
    images: document.images.length,
    lowContrast,
    smallTargets,
  };
})()`;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Load `url` at a size and color scheme in a DevTools session, then report what it showed:
 * a PNG (the full page, up to 2400 px tall), console errors, failed same-origin requests and the
 * page's own measurements. Animations are off (prefers-reduced-motion) so shots compare well.
 */
export async function captureWithCdp(
  session: CdpSession,
  url: string,
  view: View,
): Promise<Snapshot> {
  const origin = new URL(url).origin;
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  const requests = new Map<string, string>();
  const off = [
    session.on('Runtime.exceptionThrown', (p) => {
      const d = p.exceptionDetails as { text?: string; exception?: { description?: string } };
      consoleErrors.push((d.exception?.description ?? d.text ?? 'Uncaught error').split('\n')[0]!);
    }),
    session.on('Runtime.consoleAPICalled', (p) => {
      if (p.type !== 'error') return;
      const args = (p.args as { value?: unknown; description?: string }[]) ?? [];
      consoleErrors.push(
        args
          .map((a) => a.description ?? String(a.value ?? ''))
          .join(' ')
          .slice(0, 300),
      );
    }),
    session.on('Network.requestWillBeSent', (p) => {
      requests.set(p.requestId as string, (p.request as { url: string }).url);
    }),
    session.on('Network.responseReceived', (p) => {
      const r = p.response as { url: string; status: number };
      // Browsers ask for /favicon.ico on their own; a missing one isn't the page's problem.
      if (r.url.endsWith('/favicon.ico')) return;
      if (r.status >= 400 && r.url.startsWith(origin))
        failedRequests.push(`${r.status} ${r.url.slice(origin.length) || '/'}`);
    }),
    session.on('Network.loadingFailed', (p) => {
      const u = requests.get(p.requestId as string) ?? '';
      if (!p.canceled && u.startsWith(origin))
        failedRequests.push(`${p.errorText as string} ${u.slice(origin.length) || '/'}`);
    }),
  ];
  try {
    await session.send('Page.enable');
    await session.send('Runtime.enable');
    await session.send('Network.enable');
    await session.send('Network.setCacheDisabled', { cacheDisabled: true });
    const metricsFor = (height: number) => ({
      width: view.width,
      height,
      deviceScaleFactor: 1,
      mobile: view.width < 600,
    });
    await session.send('Emulation.setDeviceMetricsOverride', metricsFor(view.height));
    await session.send('Emulation.setEmulatedMedia', {
      features: [
        { name: 'prefers-color-scheme', value: view.scheme },
        { name: 'prefers-reduced-motion', value: 'reduce' },
      ],
    });
    const loaded = new Promise<void>((ok) => {
      const stop = session.on('Page.loadEventFired', () => {
        stop();
        ok();
      });
    });
    await session.send('Page.navigate', { url });
    await Promise.race([loaded, wait(15_000)]);
    await wait(300);
    const evaluated = await session.send('Runtime.evaluate', {
      expression: PAGE_PROBE,
      returnByValue: true,
    });
    const metrics = (evaluated.result as { value: PageMetrics }).value;
    const tall = Math.min(Math.max(metrics.scrollHeight, view.height), 2400);
    if (tall > view.height) {
      await session.send('Emulation.setDeviceMetricsOverride', metricsFor(tall));
      await wait(150);
    }
    const shot = await session.send('Page.captureScreenshot', { format: 'png' });
    return {
      png: Buffer.from(shot.data as string, 'base64'),
      consoleErrors: [...new Set(consoleErrors)],
      failedRequests: [...new Set(failedRequests)],
      metrics,
    };
  } finally {
    for (const f of off) f();
  }
}

/* ── Sets of shots, compared and checked ─────────────────────────────── */

/** One screenshot in a set, saved as a PNG under Conclave's data folder (never in your repo). */
export interface Shot {
  /** e.g. "home-phone-dark": the page, the size and the scheme. */
  name: string;
  page: string;
  size: 'desktop' | 'phone';
  view: View;
  path: string;
  consoleErrors: string[];
  failedRequests: string[];
  metrics: PageMetrics;
}

export interface ShotDiff {
  name: string;
  /** Share of pixels that changed, 0 to 1. */
  changed: number;
  /** Up to five regions that changed, [x1, y1, x2, y2]. */
  boxes: [number, number, number, number][];
}

export const SIZES = {
  desktop: { width: 1280, height: 800 },
  phone: { width: 390, height: 844 },
} as const;

/** "home" for "/", "settings" for "/settings", "a-b" for "/a/b". */
export function pageSlug(page: string): string {
  return (
    page
      .replace(/^\/+|\/+$/g, '')
      .replace(/[^a-z0-9]+/gi, '-')
      .toLowerCase() || 'home'
  );
}

/** Every page at both sizes in both schemes, at most 20 shots. */
export function shotPlan(
  pages: string[],
): { name: string; page: string; size: 'desktop' | 'phone'; view: View }[] {
  const out = [];
  for (const page of pages)
    for (const size of ['desktop', 'phone'] as const)
      for (const scheme of ['light', 'dark'] as const)
        out.push({
          name: `${pageSlug(page)}-${size}-${scheme}`,
          page,
          size,
          view: { ...SIZES[size], scheme },
        });
  return out.slice(0, 20);
}

/** Decode an 8-bit RGB or RGBA, non-interlaced PNG (what Chromium's screenshots are). */
export function decodePng(png: Buffer): { width: number; height: number; rgba: Buffer } {
  if (png.readUInt32BE(0) !== 0x89504e47) throw new Error('Not a PNG');
  let at = 8;
  let width = 0;
  let height = 0;
  let type = 0;
  const idat: Buffer[] = [];
  while (at < png.length) {
    const len = png.readUInt32BE(at);
    const kind = png.toString('latin1', at + 4, at + 8);
    const data = png.subarray(at + 8, at + 8 + len);
    if (kind === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      type = data[9]!;
      if (data[8] !== 8 || (type !== 2 && type !== 6) || data[12] !== 0) {
        throw new Error('Only 8-bit RGB or RGBA PNGs without interlacing are supported');
      }
    } else if (kind === 'IDAT') idat.push(data);
    else if (kind === 'IEND') break;
    at += 12 + len;
  }
  const bpp = type === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = Buffer.alloc(width * height * 4);
  const prev = Buffer.alloc(stride);
  const line = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    raw.copy(line, 0, y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp]! : 0;
      const b = prev[i]!;
      const c = i >= bpp ? prev[i - bpp]! : 0;
      let v = line[i]!;
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[i] = v & 0xff;
    }
    line.copy(prev);
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      out[o] = line[x * bpp]!;
      out[o + 1] = line[x * bpp + 1]!;
      out[o + 2] = line[x * bpp + 2]!;
      out[o + 3] = bpp === 4 ? line[x * bpp + 3]! : 255;
    }
  }
  return { width, height, rgba: out };
}

const CELL = 16;

/**
 * How much each shot changed between two sets (same names), with the changed regions grouped
 * into at most five boxes. Small anti-aliasing differences are ignored. A shot that changed size
 * counts as fully changed.
 */
export function diffShots(
  before: Shot[],
  after: Shot[],
  read: (path: string) => Buffer,
): ShotDiff[] {
  const out: ShotDiff[] = [];
  for (const a of after) {
    const b = before.find((s) => s.name === a.name);
    if (!b) continue;
    let pa: ReturnType<typeof decodePng>;
    let pb: ReturnType<typeof decodePng>;
    try {
      pa = decodePng(read(a.path));
      pb = decodePng(read(b.path));
    } catch {
      continue;
    }
    if (pa.width !== pb.width || pa.height !== pb.height) {
      out.push({ name: a.name, changed: 1, boxes: [[0, 0, pa.width, pa.height]] });
      continue;
    }
    const cols = Math.ceil(pa.width / CELL);
    const rows = Math.ceil(pa.height / CELL);
    const cells = new Uint8Array(cols * rows);
    let changed = 0;
    for (let i = 0; i < pa.rgba.length; i += 4) {
      const d = Math.max(
        Math.abs(pa.rgba[i]! - pb.rgba[i]!),
        Math.abs(pa.rgba[i + 1]! - pb.rgba[i + 1]!),
        Math.abs(pa.rgba[i + 2]! - pb.rgba[i + 2]!),
      );
      if (d > 24) {
        changed++;
        const p = i / 4;
        cells[
          Math.floor(Math.floor(p / pa.width) / CELL) * cols + Math.floor((p % pa.width) / CELL)
        ] = 1;
      }
    }
    // Group neighbouring changed cells into regions.
    const boxes: [number, number, number, number][] = [];
    const seen = new Uint8Array(cells.length);
    for (let start = 0; start < cells.length; start++) {
      if (!cells[start] || seen[start]) continue;
      let x1 = Infinity;
      let y1 = Infinity;
      let x2 = -1;
      let y2 = -1;
      const stack = [start];
      seen[start] = 1;
      while (stack.length) {
        const c = stack.pop()!;
        const cx = c % cols;
        const cy = Math.floor(c / cols);
        x1 = Math.min(x1, cx);
        y1 = Math.min(y1, cy);
        x2 = Math.max(x2, cx);
        y2 = Math.max(y2, cy);
        for (const [nx, ny] of [
          [cx + 1, cy],
          [cx - 1, cy],
          [cx, cy + 1],
          [cx, cy - 1],
        ] as const) {
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const n = ny * cols + nx;
          if (cells[n] && !seen[n]) {
            seen[n] = 1;
            stack.push(n);
          }
        }
      }
      boxes.push([
        x1 * CELL,
        y1 * CELL,
        Math.min((x2 + 1) * CELL, pa.width),
        Math.min((y2 + 1) * CELL, pa.height),
      ]);
    }
    boxes.sort((p, q) => (q[2] - q[0]) * (q[3] - q[1]) - (p[2] - p[0]) * (p[3] - p[1]));
    out.push({ name: a.name, changed: changed / (pa.width * pa.height), boxes: boxes.slice(0, 5) });
  }
  return out;
}

const where = (s: Shot) => `${s.page} (${s.size}, ${s.view.scheme})`;

/**
 * The free visual checks: no AI, no tokens. Problems this change introduced are sent back like
 * failing tests (a problem already there before doesn't count against it); sideways scrolling on
 * phones goes to the reviewer as a note, since a few layouts scroll sideways on purpose.
 */
export function visualChecks(
  after: Shot[],
  before: Shot[] = [],
): { sendBack: string[]; notes: string[] } {
  const was = (name: string) => before.find((s) => s.name === name);
  const sendBack = new Set<string>();
  const notes = new Set<string>();
  for (const s of after) {
    const b = was(s.name);
    for (const e of s.consoleErrors) {
      if (!b?.consoleErrors.includes(e)) sendBack.add(`Console error on ${where(s)}: ${e}`);
    }
    for (const r of s.failedRequests) {
      if (!b?.failedRequests.includes(r)) sendBack.add(`Failed request on ${s.page}: ${r}`);
    }
    if (s.metrics.textLength < 20 && s.metrics.images === 0 && !(b && b.metrics.textLength < 20)) {
      sendBack.add(`${where(s)} looks blank: almost no text and no images`);
    }
    const oldLow = new Set(b?.metrics.lowContrast.map((l) => l.el));
    for (const l of s.metrics.lowContrast) {
      if (!oldLow.has(l.el)) {
        sendBack.add(
          `Low contrast in ${s.view.scheme} mode on ${s.page}: ${l.el} is ${l.ratio}:1, needs ${l.needed}:1 (WCAG AA)`,
        );
      }
    }
    if (s.size === 'phone') {
      const oldSmall = new Set(b?.metrics.smallTargets.map((t) => t.el));
      for (const t of s.metrics.smallTargets) {
        if (!oldSmall.has(t.el)) {
          sendBack.add(
            `Too small to tap on phones (${s.page}): ${t.el} is ${t.width}×${t.height} px, needs 44×44`,
          );
        }
      }
      if (s.metrics.scrollWidth > s.metrics.innerWidth + 1) {
        notes.add(
          `${where(s)} scrolls sideways by ${s.metrics.scrollWidth - s.metrics.innerWidth} px`,
        );
      }
    }
  }
  return { sendBack: [...sendBack].slice(0, 12), notes: [...notes].slice(0, 6) };
}
