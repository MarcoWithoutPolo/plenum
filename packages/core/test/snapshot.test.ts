import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { parseShotsFile, parseVisualIssue, visualIssueLine, type ShotStep } from '@plenum/shared';
import {
  Brain,
  ChromeSnapshotter,
  FakeAdapter,
  PreviewServer,
  Store,
  adapterMap,
  createProject,
  decodePng,
  diffShots,
  findChrome,
  imageTokens,
  parseReview,
  pickReviewShots,
  pageSlug,
  STEP_SCRIPT,
  shotPlan,
  snapshotTask,
  visualChecks,
  type PageMetrics,
  type RunRequest,
  type Shot,
  type Snapshot,
  type Snapshotter,
  type SnapshotSet,
  type View,
} from '../src/index.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'plenum-shots-'));
  dirs.push(d);
  return d;
};

/** A PNG of `w`×`h` from a pixel function; rows use filters 0–4 in turn so the decoder sees them all. */
function png(
  w: number,
  h: number,
  pixel: (x: number, y: number) => number[],
  alpha = true,
): Buffer {
  const bpp = alpha ? 4 : 3;
  const rows: Buffer[] = [];
  let prev = Buffer.alloc(w * bpp);
  for (let y = 0; y < h; y++) {
    const line = Buffer.alloc(w * bpp);
    for (let x = 0; x < w; x++)
      pixel(x, y)
        .slice(0, bpp)
        .forEach((v, i) => (line[x * bpp + i] = v));
    const filter = y % 5;
    const out = Buffer.alloc(w * bpp + 1);
    out[0] = filter;
    for (let i = 0; i < line.length; i++) {
      const a = i >= bpp ? line[i - bpp]! : 0;
      const b = prev[i]!;
      const c = i >= bpp ? prev[i - bpp]! : 0;
      const p = a + b - c;
      const paeth =
        Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c)
          ? a
          : Math.abs(p - b) <= Math.abs(p - c)
            ? b
            : c;
      const pred = [0, a, b, (a + b) >> 1, paeth][filter]!;
      out[i + 1] = (line[i]! - pred) & 0xff;
    }
    rows.push(out);
    prev = line;
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = alpha ? 6 : 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const metrics = (over: Partial<PageMetrics> = {}): PageMetrics => ({
  scrollWidth: 390,
  innerWidth: 390,
  scrollHeight: 844,
  textLength: 200,
  images: 0,
  lowContrast: [],
  smallTargets: [],
  ...over,
});
const shot = (name: string, over: Partial<Shot> = {}): Shot => {
  const [, size = 'desktop', scheme = 'light'] = name.split('-');
  return {
    name,
    page: '/',
    size: size as 'desktop' | 'phone',
    view: { width: size === 'phone' ? 390 : 1280, height: 800, scheme: scheme as 'light' | 'dark' },
    path: '',
    consoleErrors: [],
    failedRequests: [],
    metrics: metrics(),
    ...over,
  };
};

describe('PNG and diffs', () => {
  it('decodes RGB and RGBA with every row filter', () => {
    const colour = (x: number, y: number) => [
      (x * 37) % 256,
      (y * 53) % 256,
      (x * y) % 256,
      255 - x,
    ];
    for (const alpha of [true, false]) {
      const d = decodePng(png(7, 11, colour, alpha));
      expect([d.width, d.height]).toEqual([7, 11]);
      for (const [x, y] of [
        [0, 0],
        [6, 10],
        [3, 4],
      ] as const) {
        const o = (y * 7 + x) * 4;
        expect([...d.rgba.subarray(o, o + 4)]).toEqual([
          ...colour(x, y).slice(0, 3),
          alpha ? 255 - x : 255,
        ]);
      }
    }
  });

  it('finds the region that changed, and treats a new size as all changed', () => {
    const dir = temp();
    const write = (name: string, buf: Buffer) => {
      const p = join(dir, name);
      writeFileSync(p, buf);
      return p;
    };
    const white = () => [255, 255, 255, 255];
    const before = write('b.png', png(200, 100, white));
    const after = write(
      'a.png',
      png(200, 100, (x, y) =>
        x >= 40 && x < 60 && y >= 20 && y < 40 ? [200, 0, 0, 255] : white(),
      ),
    );
    const bigger = write('c.png', png(200, 120, white));
    const [d] = diffShots(
      [shot('home-desktop-light', { path: before })],
      [shot('home-desktop-light', { path: after })],
      (p) => readFileSync(p),
    );
    expect(d!.changed).toBeCloseTo(400 / 20_000, 4);
    expect(d!.boxes).toEqual([[32, 16, 64, 48]]);
    const [s] = diffShots(
      [shot('home-desktop-light', { path: before })],
      [shot('home-desktop-light', { path: bigger })],
      (p) => readFileSync(p),
    );
    expect(s).toEqual({ name: 'home-desktop-light', changed: 1, boxes: [[0, 0, 200, 120]] });
  });

  it('plans every page at both sizes in both schemes, at most 20', () => {
    expect(shotPlan(['/', '/settings']).map((s) => s.name)).toEqual([
      'home-desktop-light',
      'home-desktop-dark',
      'home-phone-light',
      'home-phone-dark',
      'settings-desktop-light',
      'settings-desktop-dark',
      'settings-phone-light',
      'settings-phone-dark',
    ]);
    expect(shotPlan(['/a', '/b', '/c', '/d', '/e', '/f'])).toHaveLength(20);
    expect([pageSlug('/'), pageSlug('/docs/Getting Started/')]).toEqual([
      'home',
      'docs-getting-started',
    ]);
  });
});

describe('Free visual checks', () => {
  it('sends back problems this change introduced, and only those', () => {
    const before = [
      shot('home-phone-dark', {
        consoleErrors: ['Old warning as error'],
        metrics: metrics({ lowContrast: [{ el: 'span.count "0"', ratio: 2, needed: 4.5 }] }),
      }),
    ];
    const after = [
      shot('home-phone-dark', {
        consoleErrors: ['Old warning as error', 'TypeError: board is undefined'],
        failedRequests: ['404 /style.css'],
        metrics: metrics({
          lowContrast: [
            { el: 'span.count "0"', ratio: 2, needed: 4.5 },
            { el: 'button "Add card"', ratio: 1.6, needed: 4.5 },
          ],
          smallTargets: [{ el: 'button "Delete"', width: 30, height: 30 }],
          scrollWidth: 412,
        }),
      }),
      shot('home-desktop-light', {
        metrics: metrics({ smallTargets: [{ el: 'a "Docs"', width: 40, height: 20 }] }),
      }),
    ];
    expect(visualChecks(after, before)).toEqual({
      sendBack: [
        'Console error on / (phone, dark): TypeError: board is undefined',
        'Failed request on /: 404 /style.css',
        'Low contrast in dark mode on /: button "Add card" is 1.6:1, needs 4.5:1 (WCAG AA)',
        'Too small to tap on phones (/): button "Delete" is 30×30 px, needs 44×44',
      ],
      notes: ['/ (phone, dark) scrolls sideways by 22 px'],
    });
  });

  it('calls a page blank when it shows almost nothing', () => {
    expect(
      visualChecks([shot('home-desktop-light', { metrics: metrics({ textLength: 3 }) })]).sendBack,
    ).toEqual(['/ (desktop, light) looks blank: almost no text, images or controls']);
    // A small page with something to press is a page.
    expect(
      visualChecks([
        shot('home-desktop-light', { metrics: metrics({ textLength: 17, controls: 1 }) }),
      ]).sendBack,
    ).toEqual([]);
  });
});

/** Snapshots from a script: what each URL "looks like" and reports. */
class FakeSnapshotter implements Snapshotter {
  calls: { url: string; view: View; steps?: ShotStep[] }[] = [];
  constructor(
    private readonly report: (
      url: string,
      view: View,
      n: number,
    ) => Partial<Snapshot> | Promise<never>,
  ) {}
  async capture(url: string, view: View, steps?: ShotStep[]): Promise<Snapshot> {
    this.calls.push({ url, view, ...(steps && { steps }) });
    const r = await this.report(url, view, this.calls.length);
    return {
      png: png(64, 64, () => [255, 255, 255, 255]),
      consoleErrors: [],
      failedRequests: [],
      metrics: metrics(),
      ...r,
    };
  }
}

describe('snapshotTask', () => {
  async function project(files: Record<string, string>) {
    const dir = temp();
    for (const [p, b] of Object.entries(files)) {
      mkdirSync(join(dir, p, '..'), { recursive: true });
      writeFileSync(join(dir, p), b);
    }
    const store = new Store(':memory:');
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    execFileSync(
      'git',
      ['-c', 'user.name=T', '-c', 'user.email=t@e', 'commit', '-q', '--allow-empty', '-m', 'i'],
      { cwd: dir },
    );
    const p = await createProject(store, [{ provider: 'claude' }], { repoPath: dir, goal: 'g' });
    return { store, project: p, dir, home: temp() };
  }

  it('shoots before once per commit and after every time, and runs the checks', async () => {
    const { store, project: p, dir, home } = await project({ 'index.html': '<h1>Board</h1>' });
    const snap = new FakeSnapshotter(() => ({}));
    const base = {
      store,
      home,
      project: p,
      afterDir: dir,
      beforeDir: dir,
      beforeCommit: 'c1',
      snapshotter: snap,
    };
    const first = await snapshotTask({ ...base, taskId: 'k1', afterCommit: 'a1' });
    expect(first.kind).toBe('taken');
    expect(snap.calls).toHaveLength(8); // 4 before + 4 after
    expect(snap.calls[0]!.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    const second = await snapshotTask({ ...base, taskId: 'k2', afterCommit: 'a2' });
    expect(snap.calls).toHaveLength(12); // before reused
    if (second.kind !== 'taken') throw new Error('skipped');
    expect(second.before?.id).toBe(first.kind === 'taken' ? first.before?.id : '');
    expect(second.diffs.every((d) => d.changed === 0)).toBe(true);
    expect(store.snapshots.forTask(p.id, 'k2')?.shots.map((s) => s.name)).toEqual([
      'home-desktop-light',
      'home-desktop-dark',
      'home-phone-light',
      'home-phone-dark',
    ]);
    expect(readFileSync(second.after.shots[0]!.path).subarray(1, 4).toString()).toBe('PNG');
  });

  it('skips with a reason when a dev server is not allowed yet, or the shots take too long', async () => {
    const {
      store,
      project: p,
      dir,
      home,
    } = await project({
      'index.html': '',
      'package.json': JSON.stringify({ scripts: { dev: 'vite' } }),
    });
    const snap = new FakeSnapshotter(() => ({}));
    const base = {
      store,
      home,
      project: p,
      afterDir: dir,
      beforeDir: dir,
      beforeCommit: 'c1',
      taskId: 'k',
      afterCommit: 'a',
    };
    expect(await snapshotTask({ ...base, snapshotter: snap })).toEqual({
      kind: 'skipped',
      reason:
        'Screenshots need a preview: allow npm run dev (vite) for this project in its Preview first.',
    });
    const site = await project({ 'index.html': '<p>x</p>' });
    const stuck = new FakeSnapshotter(() => new Promise<never>(() => undefined));
    const late = await snapshotTask({
      ...base,
      store: site.store,
      project: site.project,
      afterDir: site.dir,
      beforeDir: site.dir,
      snapshotter: stuck,
      deadlineMs: 300,
    });
    expect(late).toEqual({
      kind: 'skipped',
      reason: "Screenshots couldn't be taken: they took longer than a minute",
    });
  });
});

describe('Visual checks in a build', () => {
  it('sends back a change that hurts contrast before any AI reviews it, then merges the fix', async () => {
    const repo = temp();
    const git = (...a: string[]) =>
      execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@e', ...a], { cwd: repo });
    git('init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'index.html'), '<h1>Board</h1>');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    const home = temp();
    const store = new Store(':memory:');
    let plans = 0;
    const claude = new FakeAdapter(
      {
        reply: (req) =>
          req.role === 'planner'
            ? plans++ === 0
              ? JSON.stringify({
                  done: false,
                  tasks: [{ title: 'Add a count', spec: 'Show a card count.' }],
                })
              : '{"done": true, "reason": "ok"}'
            : '{"approve": true, "issues": [], "summary": "Looks right"}',
      },
      { id: 'claude' },
    );
    let builds = 0;
    const codex = new FakeAdapter(
      {
        reply: 'Done',
        act: (req: RunRequest) => {
          builds++;
          writeFileSync(
            join(req.cwd, 'index.html'),
            `<h1>Board</h1><span class="count">${builds}</span>`,
          );
        },
      },
      { id: 'codex' },
    );
    const project = await createProject(store, [{ provider: 'claude' }, { provider: 'codex' }], {
      repoPath: repo,
      goal: 'A board',
    });
    // Judged by what the page serves: the first attempt's count is unreadable, the fix isn't.
    const snapshotter = new FakeSnapshotter(async (url) => {
      const html = await (await fetch(url)).text();
      return html.includes('class="count">1<')
        ? { metrics: metrics({ lowContrast: [{ el: 'span.count "1"', ratio: 1.5, needed: 4.5 }] }) }
        : {};
    });
    const brain = new Brain(
      { store, adapters: adapterMap([claude, codex]), cwd: home },
      project.id,
      {
        home,
        snapshotter,
      },
    );
    expect((await brain.run({ maxRounds: 10 })).kind).toBe('done');
    expect(builds).toBe(2);
    expect(claude.requests.filter((r) => r.role === 'reviewer')).toHaveLength(1);
    const events = store.projects.events(project.id).map((e) => e.message);
    expect(events).toContain('Screenshots: 4 shots of 1 page, 0 changed; 2 problems found');
    expect(codex.requests[1]!.prompt).toContain(
      'Low contrast in light mode on /: span.count "1" is 1.5:1, needs 4.5:1 (WCAG AA)',
    );
    expect(store.projects.listTasks(project.id)[0]!.status).toBe('merged');
  });
});

describe('Headless Chrome snapshots', () => {
  const chrome = findChrome();
  it.skipIf(!chrome)(
    'measures a real page: errors, contrast, tap size, dark mode',
    async () => {
      const dir = temp();
      writeFileSync(
        join(dir, 'index.html'),
        `<style>body{background:#fff;color:#111} @media (prefers-color-scheme: dark){body{background:#111;color:#eee}} .faint{color:#ddd}</style>
       <h1>Board</h1><p class="faint">hard to read</p><button style="width:30px;height:30px">x</button>
       <img src="missing.png" alt=""><script>console.error('boom')</script>`,
      );
      const server = new PreviewServer(dir, { kind: 'static', root: dir });
      const snap = new ChromeSnapshotter(chrome!);
      try {
        const { url } = await server.start();
        const light = await snap.capture(url, { width: 390, height: 844, scheme: 'light' });
        expect(decodePng(light.png).width).toBe(390);
        expect(light.consoleErrors).toEqual(['boom']);
        expect(light.failedRequests).toEqual(['404 /missing.png']);
        expect(light.metrics.lowContrast.map((l) => l.el)).toEqual(['p.faint "hard to read"']);
        expect(light.metrics.smallTargets).toEqual([{ el: 'button "x"', width: 30, height: 30 }]);
        const dark = await snap.capture(url, { width: 390, height: 844, scheme: 'dark' });
        const px = decodePng(dark.png).rgba;
        expect([px[0], px[1], px[2]]).toEqual([17, 17, 17]);
      } finally {
        await snap.close();
        await server.stop();
      }
    },
    120_000,
  );
});

describe('Visual review', () => {
  const set = (shots: Shot[], extra: Partial<SnapshotSet> = {}): SnapshotSet => ({
    id: 'n_1',
    projectId: 'p',
    taskId: 'k',
    commit: 'c',
    shots,
    diff: null,
    checks: null,
    createdAt: 0,
    ...extra,
  });
  const names = ['home-desktop-light', 'home-desktop-dark', 'home-phone-light', 'home-phone-dark'];

  it('shows the reviewer what changed most, plus how it looked before', () => {
    const after = set(
      names.map((n) => shot(n, { path: `/a/${n}.png` })),
      {
        diff: [
          { name: 'home-desktop-light', changed: 0.002, boxes: [] },
          { name: 'home-phone-light', changed: 0.3, boxes: [] },
        ],
      },
    );
    const before = set(
      names.map((n) => shot(n, { path: `/b/${n}.png` })),
      { taskId: null },
    );
    expect(pickReviewShots(after, before).map((s) => s.label)).toEqual([
      'after: / (phone, light)',
      'after: / (phone, dark)',
      'after: / (desktop, light)',
      'before: / (phone, light)',
    ]);
    // Nothing changed noticeably: four "after" shots, phone-dark and desktop-light first.
    const quiet = set(names.map((n) => shot(n, { path: `/a/${n}.png` })));
    expect(pickReviewShots(quiet, before).map((s) => s.label)).toEqual([
      'after: / (phone, dark)',
      'after: / (desktop, light)',
      'after: / (phone, light)',
      'after: / (desktop, dark)',
    ]);
  });

  it('estimates what a screenshot costs in tokens', () => {
    expect(imageTokens(png(390, 844, () => [255, 255, 255, 255]))).toBe(439);
    expect(imageTokens(png(1280, 2400, () => [255, 255, 255, 255]))).toBe(1600);
  });

  it('reads visual problems from a verdict', () => {
    expect(
      parseReview(
        '{"approve": false, "issues": [], "summary": "s", "visual": [{"shot": "after: / (phone, dark)", "issue": "Button text invisible", "box": [10.4, 600, 380, 660.6]}, {"issue": "   "}, {"shot": "x", "issue": "Cut off"}]}',
      )?.visual,
    ).toEqual([
      { shot: 'after: / (phone, dark)', issue: 'Button text invisible', box: [10, 600, 380, 661] },
      { shot: 'x', issue: 'Cut off' },
    ]);
  });

  async function webProject(opts: {
    reviewers: { id: 'claude' | 'antigravity'; vision: 'files' | 'none' }[];
    visualReview?: boolean;
    replies: string[];
  }) {
    const repo = temp();
    const git = (...a: string[]) =>
      execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@e', ...a], { cwd: repo });
    git('init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'index.html'), '<h1>Tip calculator</h1>');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    const home = temp();
    const store = new Store(':memory:');
    let plans = 0;
    let reviews = 0;
    const reviewers = opts.reviewers.map(
      (r) =>
        new FakeAdapter(
          {
            reply: (req) =>
              req.role === 'planner'
                ? plans++ === 0
                  ? JSON.stringify({
                      done: false,
                      tasks: [{ title: 'Add a tip slider', spec: 'A slider.' }],
                    })
                  : '{"done": true, "reason": "ok"}'
                : opts.replies[Math.min(reviews++, opts.replies.length - 1)]!,
          },
          { id: r.id, vision: r.vision },
        ),
    );
    let builds = 0;
    const codex = new FakeAdapter(
      {
        reply: 'Done',
        act: (req: RunRequest) =>
          writeFileSync(join(req.cwd, 'index.html'), `<h1>Tip calculator</h1><p>v${++builds}</p>`),
      },
      { id: 'codex', vision: 'native' },
    );
    const project = await createProject(
      store,
      [...opts.reviewers.map((r) => ({ provider: r.id })), { provider: 'codex' as const }],
      {
        repoPath: repo,
        goal: 'A tip calculator',
        routing: {
          planner: [{ provider: opts.reviewers[0]!.id }],
          builder: [{ provider: 'codex' }],
          reviewer: opts.reviewers.map((r) => ({ provider: r.id })),
        },
        ...(opts.visualReview === false && { visualReview: false }),
      },
    );
    const brain = new Brain(
      { store, adapters: adapterMap([...reviewers, codex]), cwd: home },
      project.id,
      { home, snapshotter: new FakeSnapshotter(() => ({})) },
    );
    const outcome = await brain.run({ maxRounds: 12 });
    return { store, project, outcome, reviewers, codex, builds: () => builds };
  }

  const LOOKS_WRONG =
    '{"approve": false, "issues": [], "summary": "The slider is unreadable in dark mode", "visual": [{"shot": "after: / (phone, dark)", "issue": "The slider label is dark grey on black", "box": [20, 300, 370, 340]}]}';
  const FINE = '{"approve": true, "issues": [], "summary": "Looks right in every shot"}';

  it('sends back what the reviewer saw, with the screenshot, then merges the fix', async () => {
    const { store, project, outcome, reviewers, codex, builds } = await webProject({
      reviewers: [{ id: 'claude', vision: 'files' }],
      replies: [LOOKS_WRONG, FINE],
    });
    expect(outcome.kind).toBe('done');
    expect(builds()).toBe(2);
    const review = reviewers[0]!.requests.find((r) => r.role === 'reviewer')!;
    expect(review.images).toHaveLength(4);
    expect(review.images!.every((p) => p.endsWith('.png'))).toBe(true);
    expect(review.prompt).toContain('Open each file with your Read tool');
    expect(review.prompt).toMatch(/- after: \/ \(phone, dark\): .+home-phone-dark\.png/);
    // Builders of a web project are told how to show the page in use.
    expect(codex.requests[0]!.prompt).toContain('plenum.shots.json');
    // The builder got the issue, the region and the file to open.
    expect(codex.requests[1]!.prompt).toMatch(
      /The slider label is dark grey on black \[after: \/ \(phone, dark\) \(region 20, 300, 370, 340\): .+home-phone-dark\.png\]/,
    );
    const failures = store.projects
      .events(project.id)
      .filter((e) => /found visual problems/.test(e.message));
    expect(failures).toHaveLength(1);
    const used = store.db
      .prepare("SELECT SUM(image_tokens) AS t FROM agent_runs WHERE role = 'reviewer'")
      .get() as { t: number };
    expect(used.t).toBeGreaterThan(0);
    // The Usage screen's line: the same tokens, and their share of all input.
    const images = store.usage.images(0);
    expect(images).toMatchObject({ tokens: used.t, runs: 2 });
    expect(images.share).toBeGreaterThan(0);
    expect(store.usage.images(Date.now() + 60_000)).toEqual({ tokens: 0, runs: 0, share: 0 });
    // The app reads the failure back: the issue, the shot, the region and the file.
    const task = store.projects.listTasks(project.id)[0]!;
    const line = codex.requests[1]!.prompt.split('\n').find((l) =>
      l.startsWith('- The slider label'),
    )!;
    const parsed = parseVisualIssue(line.slice(2));
    expect(parsed).toMatchObject({
      issue: 'The slider label is dark grey on black',
      shot: 'after: / (phone, dark)',
      box: [20, 300, 370, 340],
    });
    expect(parsed.path).toMatch(/home-phone-dark\.png$/);
    expect(readFileSync(parsed.path!).length).toBeGreaterThan(0);
    expect(task.status).toBe('merged');
  });

  it('reviews the code only when no reviewer can see, and says so', async () => {
    const { store, project, outcome, reviewers } = await webProject({
      reviewers: [{ id: 'antigravity', vision: 'none' }],
      replies: [FINE],
    });
    expect(outcome.kind).toBe('done');
    const review = reviewers[0]!.requests.find((r) => r.role === 'reviewer')!;
    expect(review.images).toBeUndefined();
    expect(review.prompt).not.toContain('SCREENSHOTS');
    expect(store.projects.events(project.id).map((e) => e.message)).toContain(
      'No reviewer on the team can see images, so the screenshots are skipped',
    );
  });

  it('keeps screenshots and the free checks, but no image review, when visual review is off', async () => {
    const { store, project, reviewers } = await webProject({
      reviewers: [{ id: 'claude', vision: 'files' }],
      visualReview: false,
      replies: [FINE],
    });
    expect(reviewers[0]!.requests.find((r) => r.role === 'reviewer')!.images).toBeUndefined();
    expect(
      store.projects
        .events(project.id)
        .some((e) => e.message.startsWith('Screenshots: 4 shots of 1 page')),
    ).toBe(true);
  });
});

describe('Visual issue lines', () => {
  it('round-trips labels with colons, paths with spaces and regions', () => {
    const cases = [
      {
        issue: 'Text is cut off',
        shot: 'after: /settings (desktop, light)',
        box: [0, 10, 200, 40] as [number, number, number, number],
        path: 'C:\\Users\\Ana Lee\\.plenum\\projects\\p1\\shots\\s1\\settings-desktop-light.png',
      },
      {
        issue: 'Overlaps [the header]',
        shot: 'before: / (phone, dark)',
        path: '/home/a/shots/x.png',
      },
      {
        issue: 'Odd spacing',
        shot: 'after: / (phone, light)',
        box: [1, 2, 3, 4] as [number, number, number, number],
      },
      { issue: 'Reviewer made up a label', shot: 'the dark one' },
      { issue: 'No screenshot named' },
    ];
    for (const c of cases) expect(parseVisualIssue(visualIssueLine(c))).toEqual(c);
  });

  it('keeps an unrelated line whole', () => {
    expect(parseVisualIssue('Use a darker grey for the hint')).toEqual({
      issue: 'Use a darker grey for the hint',
    });
  });
});

describe('Sample states (plenum.shots.json)', () => {
  const STATES = {
    states: [
      {
        name: 'with cards',
        page: '/',
        steps: [{ fill: { label: 'New card', text: 'Plan the release' } }, { click: 'Add card' }],
      },
    ],
  };

  it('reads the file, and says plainly what is wrong with a bad one', () => {
    expect(parseShotsFile(JSON.stringify(STATES))).toEqual({
      states: [{ ...STATES.states[0], page: '/' }],
    });
    expect(parseShotsFile('{oops')).toEqual({ error: "plenum.shots.json isn't valid JSON" });
    expect(
      parseShotsFile(JSON.stringify({ states: [{ name: 'x', steps: [{ hover: 'a' }] }] })),
    ).toMatchObject({
      error: expect.stringMatching(/^plenum\.shots\.json: states\.0\.steps\.0/),
    });
    const twice = { states: [STATES.states[0], { ...STATES.states[0], name: 'With Cards' }] };
    expect(parseShotsFile(JSON.stringify(twice))).toEqual({
      error: 'plenum.shots.json: two states share a name',
    });
  });

  it('plans the first page, then the states, then other pages, at most 20 shots', () => {
    const plan = shotPlan(
      ['/', '/about'],
      [{ name: 'with cards', page: '/', steps: [{ click: 'Add' }] }],
    );
    expect(plan.map((p) => p.name)).toEqual([
      'home-desktop-light',
      'home-desktop-dark',
      'home-phone-light',
      'home-phone-dark',
      'home-with-cards-desktop-light',
      'home-with-cards-desktop-dark',
      'home-with-cards-phone-light',
      'home-with-cards-phone-dark',
      'about-desktop-light',
      'about-desktop-dark',
      'about-phone-light',
      'about-phone-dark',
    ]);
    expect(plan[4]!.state).toEqual({ name: 'with cards', steps: [{ click: 'Add' }] });
    const many = ['/', '/a', '/b', '/c', '/d'];
    const states = [1, 2, 3].map((n) => ({ name: `s${n}`, page: '/', steps: [{ wait: 1 }] }));
    const capped = shotPlan(many, states);
    expect(capped).toHaveLength(20);
    // The states make it in before the extra pages do.
    expect(capped.filter((p) => p.state)).toHaveLength(12);
  });

  it('sends a valid step script into the page', () => {
    for (const step of [
      { fill: { label: 'New "card"', text: "it's </script>" } },
      { click: 'Add card' },
    ] as ShotStep[]) {
      const src = STEP_SCRIPT(step);
      expect(() => new Function(src)).not.toThrow();
      expect(src).toContain(String.raw`/\s+/g`);
    }
  });

  it('replays each state before its shots, and notes a state that could not be replayed', async () => {
    const dir = temp();
    writeFileSync(join(dir, 'index.html'), '<h1>Board</h1>');
    writeFileSync(join(dir, 'plenum.shots.json'), JSON.stringify(STATES));
    const store = new Store(':memory:');
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    execFileSync(
      'git',
      ['-c', 'user.name=T', '-c', 'user.email=t@e', 'commit', '-q', '--allow-empty', '-m', 'i'],
      { cwd: dir },
    );
    const p = await createProject(store, [{ provider: 'claude' }], { repoPath: dir, goal: 'g' });
    const snap = new FakeSnapshotter((_u, view, n) =>
      n > 4 && view.scheme === 'dark' ? { stateError: 'step 2: no button named "Add card"' } : {},
    );
    const taken = await snapshotTask({
      store,
      home: temp(),
      project: p,
      taskId: 'k',
      afterDir: dir,
      afterCommit: 'a',
      beforeDir: dir,
      beforeCommit: 'b',
      snapshotter: snap,
    });
    if (taken.kind !== 'taken') throw new Error(taken.reason);
    // The page as it loads (before and after), then the state (before and after).
    expect(snap.calls.filter((c) => c.steps)).toHaveLength(8);
    expect(snap.calls.find((c) => c.steps)!.steps).toEqual(STATES.states[0]!.steps);
    const state = taken.after.shots.filter((x) => x.state === 'with cards');
    expect(state.map((x) => x.name)).toEqual([
      'home-with-cards-desktop-light',
      'home-with-cards-desktop-dark',
      'home-with-cards-phone-light',
      'home-with-cards-phone-dark',
    ]);
    expect(taken.checks.notes).toContain(
      'The sample state "with cards" stopped at step 2: no button named "Add card"',
    );
    expect(taken.checks.sendBack).toEqual([]);

    // A broken file is said once, and the page is still shot as it loads.
    writeFileSync(join(dir, 'plenum.shots.json'), '{"states": [{"name": "?!", "steps": []}]}');
    const again = await snapshotTask({
      store,
      home: temp(),
      project: p,
      taskId: 'k2',
      afterDir: dir,
      afterCommit: 'a2',
      beforeDir: dir,
      beforeCommit: 'b',
      snapshotter: new FakeSnapshotter(() => ({})),
    });
    if (again.kind !== 'taken') throw new Error(again.reason);
    expect(again.after.shots.some((x) => x.state)).toBe(false);
    expect(again.checks.notes[0]).toMatch(
      /^plenum\.shots\.json: states\.0\.name: .+; its sample states were left out$/,
    );
  });

  const chrome = findChrome();
  it.skipIf(!chrome)(
    'replays a state in real Chrome and finds what only shows once the page is used',
    async () => {
      const dir = temp();
      writeFileSync(
        join(dir, 'index.html'),
        `<style>body{background:#fff;color:#111;font:16px sans-serif} li{color:#bbb} button{min-height:44px;min-width:44px}</style>
         <label>New card <input id="t"></label><button>Add card</button><ul id="l"></ul>
         <script>
           document.querySelector('button').onclick = () => {
             const li = document.createElement('li');
             li.textContent = document.getElementById('t').value;
             document.getElementById('l').append(li);
             localStorage.setItem('cards', '1');
           };
           if (localStorage.getItem('cards')) { const li = document.createElement('li'); li.textContent = 'leaked'; document.getElementById('l').append(li); }
         </script>`,
      );
      const server = new PreviewServer(dir, { kind: 'static', root: dir });
      const snap = new ChromeSnapshotter(chrome!);
      try {
        const { url } = await server.start();
        const view = { width: 390, height: 844, scheme: 'light' } as const;
        const loaded = await snap.capture(url, view);
        expect(loaded.metrics.lowContrast).toEqual([]);
        const used = await snap.capture(url, view, STATES.states[0]!.steps as ShotStep[]);
        expect(used.stateError).toBeUndefined();
        expect(used.metrics.lowContrast.map((l) => l.el)).toEqual(['li "Plan the release"']);
        // What one state stored doesn't leak into the next shot.
        const next = await snap.capture(url, view, [{ click: 'Remove all' }]);
        expect(next.stateError).toBe('step 1: no button named "Remove all"');
        expect(next.metrics.lowContrast).toEqual([]);
      } finally {
        await snap.close();
        await server.stop();
      }
    },
    120_000,
  );
});
