import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type Locator, type Page } from '@playwright/test';

// The trailer: a real recording of the app in demo mode, with captions and a cursor drawn over
// the live UI. Run with CONCLAVE_TRAILER=1; the video lands in e2e/screenshots/trailer/.
test.skip(process.env.CONCLAVE_TRAILER !== '1', 'set CONCLAVE_TRAILER=1 to record');

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'screenshots', 'trailer');
const W = 1280;
const H = 800;

/** Captions and a cursor, drawn over the app so the recording shows what matters. */
const OVERLAY = `
(() => {
  const css = document.createElement('style');
  css.textContent = \`
    #tr-card, #tr-band, #tr-cursor { font-family: Inter, "Segoe UI", system-ui, sans-serif; pointer-events: none; z-index: 2147483000; }
    #tr-card { position: fixed; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 18px;
      background: #0e0e10; color: #f3f1ea; text-align: center; padding: 0 120px; opacity: 0; transition: opacity 700ms ease; }
    #tr-card .t { font-size: 64px; font-weight: 600; letter-spacing: -0.02em; line-height: 1.05; }
    #tr-card .s { font-size: 26px; color: #b7b4aa; max-width: 980px; line-height: 1.4; }
    #tr-card .k { font-size: 22px; color: #8c8cff; letter-spacing: 0.04em; }
    #tr-card .logo { width: 72px; height: 72px; margin-bottom: 8px; }
    #tr-band { position: fixed; left: 0; right: 0; bottom: 0; padding: 26px 48px 30px; display: flex; flex-direction: column; gap: 6px;
      background: linear-gradient(to top, rgba(10,10,12,0.92), rgba(10,10,12,0.75) 70%, rgba(10,10,12,0)); color: #f3f1ea;
      transform: translateY(100%); transition: transform 600ms cubic-bezier(.2,.7,.2,1); }
    #tr-band .t { font-size: 34px; font-weight: 600; letter-spacing: -0.01em; }
    #tr-band .s { font-size: 20px; color: #c9c6bc; }
    #tr-cursor { position: fixed; left: 0; top: 0; width: 22px; height: 22px; opacity: 0;
      transition: transform 650ms cubic-bezier(.2,.7,.2,1), opacity 300ms ease; filter: drop-shadow(0 2px 4px rgba(0,0,0,.45)); }
    #tr-cursor::after { content: ""; position: absolute; left: -11px; top: -11px; width: 44px; height: 44px; border-radius: 50%;
      border: 2px solid #8c8cff; opacity: 0; transform: scale(.4); }
    #tr-cursor.click::after { animation: tr-pulse 450ms ease-out; }
    @keyframes tr-pulse { 0% { opacity: .9; transform: scale(.4); } 100% { opacity: 0; transform: scale(1.3); } }
  \`;
  document.head.append(css);
  const card = document.createElement('div'); card.id = 'tr-card';
  const band = document.createElement('div'); band.id = 'tr-band';
  const cursor = document.createElement('div'); cursor.id = 'tr-cursor';
  cursor.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M4 2l16 9.5-7 1.6-3.6 6.6z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  document.body.append(card, band, cursor);
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  window.__trailer = {
    card(lines, on) {
      if (lines) card.innerHTML = lines.map(([cls, text]) => cls === 'logo'
        ? '<svg class="logo" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="5" r="3" fill="#d97757"/><circle cx="5" cy="18" r="3" fill="#3fb27f"/><circle cx="19" cy="18" r="3" fill="#4a8df8"/><path d="M12 8v4m0 0l-5 4m5-4l5 4" stroke="#8c8cff" stroke-width="1.6"/></svg>'
        : '<div class="' + cls + '">' + esc(text) + '</div>').join('');
      card.style.opacity = on ? '1' : '0';
    },
    band(title, sub) {
      if (title) band.innerHTML = '<div class="t">' + esc(title) + '</div>' + (sub ? '<div class="s">' + esc(sub) + '</div>' : '');
      band.style.transform = title ? 'translateY(0)' : 'translateY(100%)';
    },
    cursor(x, y, show) {
      cursor.style.opacity = show === false ? '0' : '1';
      if (x !== undefined) cursor.style.transform = 'translate(' + x + 'px,' + y + 'px)';
    },
    click() { cursor.classList.remove('click'); void cursor.offsetWidth; cursor.classList.add('click'); },
  };
})();`;

class Director {
  constructor(private readonly page: Page) {}
  private readonly sleep = (ms: number) => this.page.waitForTimeout(ms);

  async install() {
    await this.page.evaluate(OVERLAY);
  }
  /** A full-screen card: a title, a subtitle, a small kicker, or the logo. */
  async card(lines: [string, string][], holdMs: number) {
    await this.page.evaluate(([l]) => window.__trailer.card(l, true), [lines] as const);
    await this.sleep(700 + holdMs);
  }
  async uncard() {
    await this.page.evaluate(() => window.__trailer.card(null, false));
    await this.sleep(750);
  }
  /** A caption band over the live UI. */
  async band(title: string, sub?: string) {
    await this.page.evaluate(([t, s]) => window.__trailer.band(t, s), [title, sub ?? ''] as const);
    await this.sleep(650);
  }
  async unband() {
    await this.page.evaluate(() => window.__trailer.band(null));
    await this.sleep(650);
  }
  /** Glide the cursor to the element and click it. */
  async click(target: Locator, settleMs = 500) {
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    if (!box) throw new Error('Nothing to click');
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await this.page.evaluate(([px, py]) => window.__trailer.cursor(px, py, true), [x, y] as const);
    await this.sleep(700);
    await this.page.evaluate(() => window.__trailer.click());
    await this.sleep(120);
    await target.click();
    await this.sleep(settleMs);
  }
  async hideCursor() {
    await this.page.evaluate(() => window.__trailer.cursor(undefined, undefined, false));
  }
  /** Type like a person, after clicking into the field. */
  async type(target: Locator, text: string) {
    await this.click(target, 200);
    await target.pressSequentially(text, { delay: 28 });
    await this.sleep(400);
  }
  hold(ms: number) {
    return this.sleep(ms);
  }
}

declare global {
  interface Window {
    __trailer: {
      card(lines: [string, string][] | null, on: boolean): void;
      band(title: string | null, sub?: string): void;
      cursor(x?: number, y?: number, show?: boolean): void;
      click(): void;
    };
  }
}

test('trailer', async () => {
  test.setTimeout(10 * 60_000);
  mkdirSync(out, { recursive: true });
  const home = mkdtempSync(join(tmpdir(), 'conclave-trailer-'));
  const repo = mkdtempSync(join(tmpdir(), 'greeter-'));
  const git = (...a: string[]) =>
    execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...a], {
      cwd: repo,
    });
  git('init', '-q', '-b', 'main');
  writeFileSync(
    join(repo, 'package.json'),
    JSON.stringify({ name: 'greeter', scripts: { test: 'node -e 0' } }),
  );
  git('add', '-A');
  git('commit', '-q', '-m', 'init');

  const app = await electron.launch({
    args: [join(here, '../out/main/index.js')],
    env: {
      ...process.env,
      CONCLAVE_DEMO: '1',
      CONCLAVE_DEMO_SLOW: '1',
      CONCLAVE_DEMO_LANES: '1',
      CONCLAVE_HOME: home,
      CONCLAVE_E2E_REPO: repo,
    },
    colorScheme: 'dark',
    recordVideo: { dir: out, size: { width: W, height: H } },
  });
  const page = await app.firstWindow();
  const video = page.video();
  try {
    await page.setViewportSize({ width: W, height: H });
    await page.waitForLoadState('load');
    const d = new Director(page);
    await d.install();
    const nav = (name: RegExp) => page.getByRole('complementary').getByRole('button', { name });

    // ── 1. Title ──────────────────────────────────────────────────────
    await d.card(
      [
        ['logo', ''],
        ['t', 'Conclave'],
        ['s', 'Your AI coding subscriptions, working as one team.'],
      ],
      2600,
    );

    // ── 2. Accounts ───────────────────────────────────────────────────
    await nav(/^Accounts/).click();
    await expect(page.getByRole('heading', { name: 'Accounts' })).toBeVisible();
    await d.uncard();
    await d.band(
      'Claude Code. Codex. Antigravity.',
      'The CLIs you already pay for. No API keys, no credentials.',
    );
    await d.hold(3200);
    await d.unband();

    // ── 3. Council ────────────────────────────────────────────────────
    await d.click(nav(/^Ask the council/));
    const box = page.getByRole('textbox', { name: 'Message' });
    await d.band('Ask them all at once.', 'One question, every AI, one merged answer.');
    await d.type(box, 'Best way to store small app settings?');
    await box.press('Enter');
    await d.hideCursor();
    await expect(page.getByRole('article', { name: 'Council answer' })).toContainText('JSON', {
      timeout: 30_000,
    });
    await d.hold(3800);
    await d.unband();

    // ── 4. New project ────────────────────────────────────────────────
    await d.click(nav(/^Projects/));
    await d.click(page.getByRole('button', { name: 'New project' }));
    const dialog = page.getByRole('dialog', { name: 'New project' });
    await d.click(dialog.getByRole('button', { name: 'Choose a folder' }));
    await expect(dialog.getByLabel('Ready')).toBeVisible();
    await d.click(dialog.getByRole('button', { name: 'Next' }));
    await d.band('Give it a goal.', 'It asks before it guesses.');
    await d.type(
      dialog.getByRole('textbox', { name: 'Goal' }),
      'Add a greet() helper and document how to use it.',
    );
    await d.click(dialog.getByRole('button', { name: 'Next' }));
    await expect(dialog.getByText('What should greet() say?')).toBeVisible({ timeout: 30_000 });
    await d.hideCursor();
    await d.hold(3000);
    await d.unband();
    await d.click(dialog.getByRole('button', { name: 'Start', exact: true }));
    await d.hideCursor();

    // ── 5. Lanes ──────────────────────────────────────────────────────
    await expect(page.getByRole('region', { name: 'Lanes: 2 of 2 busy' })).toBeVisible({
      timeout: 40_000,
    });
    await d.band('Independent tasks build at the same time,', 'each in its own git worktree.');
    await d.hold(4200);
    await d.unband();

    // ── 6. Review and merge ───────────────────────────────────────────
    await d.band(
      'A different AI reviews every change.',
      'Your tests first. Then a second opinion.',
    );
    await expect(page.getByRole('article', { name: /Ready to merge/ })).toBeVisible({
      timeout: 90_000,
    });
    await d.hold(2600);
    await d.unband();

    // ── 7. Steering ───────────────────────────────────────────────────
    await d.click(page.getByRole('tab', { name: 'Chat' }));
    await d.band(
      'Steer it in plain words.',
      'The planner proposes. Nothing changes until you apply it.',
    );
    await d.type(
      page.getByRole('textbox', { name: 'Message to the project' }),
      'Add a goodbye helper too, and keep the docs short.',
    );
    await d.click(page.getByRole('button', { name: 'Send' }));
    await expect(page.getByRole('group', { name: 'Proposed changes' })).toBeVisible({
      timeout: 30_000,
    });
    await d.hold(1600);
    await d.click(page.getByRole('button', { name: /^Apply/ }));
    await expect(page.getByRole('region', { name: 'Chat' })).toContainText('Added', {
      timeout: 20_000,
    });
    await d.hideCursor();
    await d.hold(2200);
    await d.unband();

    // ── 8. Ready to merge ─────────────────────────────────────────────
    await page.getByRole('article', { name: /Ready to merge/ }).scrollIntoViewIfNeeded();
    await d.band(
      'Nothing reaches your branch until you approve.',
      'Merge here, or open a pull request.',
    );
    await d.hold(3400);
    await d.unband();

    // ── 9. Settings ───────────────────────────────────────────────────
    await d.click(nav(/^Settings/));
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
    await d.band(
      'Your limits, shared across every project.',
      'Quiet hours. Daily caps. One pause switch.',
    );
    await d.click(page.getByRole('button', { name: 'Add quiet hours' }));
    await d.click(
      page.getByRole('group', { name: 'Quiet hours 1' }).getByRole('button', { name: 'Claude' }),
    );
    await d.hideCursor();
    await d.hold(2600);
    await d.unband();

    // ── 10. Numbers ───────────────────────────────────────────────────
    await d.card(
      [
        ['k', 'MEASURED, NOT PROMISED'],
        ['t', 'Every hidden test passed.'],
        [
          's',
          'Across every Conclave run of the benchmark, on four projects. On par with Codex alone for speed, with a second AI reviewing every change.',
        ],
      ],
      4200,
    );

    // ── 11. End ───────────────────────────────────────────────────────
    await d.card(
      [
        ['logo', ''],
        ['t', 'Conclave'],
        ['s', 'Open source · MIT'],
        ['k', 'github.com/MarcoWithoutPolo/conclave'],
      ],
      3600,
    );
  } finally {
    await app.close();
    if (video) {
      const path = await video.path();
      const final = join(out, 'conclave-trailer.webm');
      rmSync(final, { force: true });
      renameSync(path, final);
      console.log(`VIDEO ${final}`);
    }
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});
