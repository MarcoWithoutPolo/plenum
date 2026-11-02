import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';

/**
 * The UI integrity suite's tools (v1.0 Q3): launch the demo app with a data set and theme, and
 * check a screen for what a person would otherwise have to spot by eye. Checks return problems
 * instead of failing at the first, so one run lists everything wrong with a screen.
 */
const here = dirname(fileURLToPath(import.meta.url));

export type DataSet = 'normal' | 'empty' | 'stress';
export type Theme = 'light' | 'dark';

export interface Running {
  app: ElectronApplication;
  page: Page;
  /** Page errors and console errors since launch. */
  errors: string[];
  close: () => Promise<void>;
}

export async function launch(data: DataSet, theme: Theme): Promise<Running> {
  const home = mkdtempSync(join(tmpdir(), 'conclave-int-home-'));
  const repo = mkdtempSync(join(tmpdir(), 'conclave-int-repo-'));
  const git = (...a: string[]) =>
    execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...a], {
      cwd: repo,
    });
  git('init', '-q', '-b', 'main');
  writeFileSync(
    join(repo, 'package.json'),
    '{ "name": "greeter", "scripts": { "test": "node -e 0" } }\n',
  );
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  const app = await electron.launch({
    args: [join(here, '../../out/main/index.js')],
    env: {
      ...process.env,
      CONCLAVE_DEMO: '1',
      CONCLAVE_HOME: home,
      CONCLAVE_E2E_REPO: repo,
      ...(data !== 'normal' && { CONCLAVE_DEMO_DATA: data }),
    },
    colorScheme: theme,
  });
  const page = await app.firstWindow();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`page error: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console error: ${m.text().slice(0, 300)}`);
  });
  return {
    app,
    page,
    errors,
    close: async () => {
      await app.close();
      rmSync(home, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    },
  };
}

/** Layout problems on the page as it is: sideways scroll, overflow, cut text, overlaps. */
export async function layoutProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const name = (el: Element) => {
      const label =
        el.getAttribute('aria-label') ??
        (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
      return `<${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}> "${label}"`;
    };
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return false;
      const s = getComputedStyle(el);
      return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
    };
    const doc = document.documentElement;
    if (doc.scrollWidth > innerWidth + 1)
      out.push(`the window scrolls sideways (${doc.scrollWidth}px wide in ${innerWidth}px)`);

    for (const el of document.querySelectorAll<HTMLElement>('body *')) {
      if (!visible(el) || el.closest('[data-scroll-x], pre, code, svg, [aria-hidden="true"]'))
        continue;
      const s = getComputedStyle(el);
      const over = el.scrollWidth - el.clientWidth;
      // Only code and diffs may scroll sideways; anything else that does is cut off.
      if (over > 2 && (s.overflowX === 'auto' || s.overflowX === 'scroll'))
        out.push(`scrolls sideways by ${over}px: ${name(el)}`);
      // Text squeezed into a column a few letters wide: three or more lines in under 60px.
      for (const node of el.childNodes) {
        if (node.nodeType !== Node.TEXT_NODE || (node.textContent ?? '').trim().length < 4)
          continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const lines = new Set([...range.getClientRects()].map((q) => Math.round(q.top)));
        const width = el.getBoundingClientRect().width;
        if (lines.size >= 3 && width < 60)
          out.push(`text squeezed to ${Math.round(width)}px wide: ${name(el)}`);
      }
      if (over > 2 && el.clientWidth > 0) {
        if (s.overflowX === 'visible' && el.children.length === 0)
          out.push(`text runs out of its box by ${over}px: ${name(el)}`);
        else if (s.overflowX === 'hidden' && s.textOverflow === 'ellipsis') {
          const told =
            el.title ||
            el.closest('[title]') ||
            el.getAttribute('aria-label') ||
            el.closest('[aria-label]');
          if (!told) out.push(`cut text with no tooltip: ${name(el)}`);
        }
      }
    }

    // Interactive elements: each one's center must land on itself (nothing covers it).
    const controls = document.querySelectorAll<HTMLElement>(
      'button, a[href], input, textarea, select, [role="switch"], [role="tab"], [role="radio"]',
    );
    // With a modal dialog open, the page behind it is meant to be covered: check the dialog only.
    const modal = [...document.querySelectorAll('[aria-modal="true"]')].at(-1);
    for (const el of controls) {
      if (!visible(el) || el.closest('[aria-hidden="true"]')) continue;
      if (modal && !modal.contains(el)) continue;
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue;
      // Scrolled out of its scrolling parent: not on screen, so nothing to check.
      let hiddenByScroll = false;
      for (let p = el.parentElement; p; p = p.parentElement) {
        const ps = getComputedStyle(p);
        if (ps.overflowY === 'visible' && ps.overflowX === 'visible') continue;
        const q = p.getBoundingClientRect();
        if (y < q.top || y > q.bottom || x < q.left || x > q.right) hiddenByScroll = true;
      }
      if (hiddenByScroll) continue;
      const hit = document.elementFromPoint(x, y);
      // A styled switch or checkbox: its own label drawn over the input passes clicks to it.
      const label = el.closest('label');
      if (label && hit && label.contains(hit)) continue;
      if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) {
        // A layer on top (a dialog, a popover) covering the page is expected.
        if (hit.closest('[role="dialog"], [data-popover]') && !el.closest('[role="dialog"]'))
          continue;
        out.push(`${name(el)} is covered by ${name(hit)}`);
      }
    }
    return [...new Set(out)];
  });
}

/** Serious and critical accessibility problems (axe-core). */
export async function accessibilityProblems(page: Page): Promise<string[]> {
  // Legacy mode runs inside this page: Electron can't open the extra page axe would use.
  const result = await new AxeBuilder({ page })
    .setLegacyMode(true)
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  return result.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .flatMap((v) =>
      v.nodes.slice(0, 5).map((n) => {
        // For contrast, say which colors and how far off, so the fix is obvious.
        const d = n.any[0]?.data as
          | {
              fgColor?: string;
              bgColor?: string;
              contrastRatio?: number;
              expectedContrastRatio?: string;
            }
          | undefined;
        const colors = d?.fgColor
          ? ` (${d.fgColor} on ${d.bgColor}: ${d.contrastRatio} < ${d.expectedContrastRatio})`
          : '';
        return `${v.id}: ${n.target.join(' ')}${colors} — ${v.help}`;
      }),
    );
}

/** Open each picker on the page in turn: fully on screen, scrolled to its end, Escape closes it. */
export async function pickerProblems(page: Page, scope = 'body'): Promise<string[]> {
  const out: string[] = [];
  const triggers = page.locator(`${scope} [aria-haspopup="dialog"]:visible`);
  const count = Math.min(await triggers.count(), 12);
  for (let i = 0; i < count; i++) {
    const trigger = triggers.nth(i);
    const label = (await trigger.getAttribute('aria-label')) ?? (await trigger.innerText());
    if (await trigger.isDisabled()) continue;
    await trigger.click();
    const id = await trigger.getAttribute('aria-controls');
    const popover = page.locator(`[id="${id}"]`);
    try {
      await popover.waitFor({ state: 'visible', timeout: 2000 });
    } catch {
      out.push(`picker "${label}" didn't open`);
      continue;
    }
    const fit = await popover.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const problems: string[] = [];
      if (r.left < -1 || r.top < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1)
        problems.push(
          `off screen: [${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.right)},${Math.round(r.bottom)}] in ${innerWidth}×${innerHeight}`,
        );
      for (const list of el.querySelectorAll<HTMLElement>('*')) {
        if (list.scrollHeight <= list.clientHeight + 1) continue;
        const s = getComputedStyle(list);
        if (s.overflowY !== 'auto' && s.overflowY !== 'scroll') continue;
        const rows = list.querySelectorAll<HTMLElement>('button, [role="option"]');
        if (rows.length >= 4 && list.clientHeight < 150)
          problems.push(`a list only ${list.clientHeight}px tall`);
        list.scrollTop = list.scrollHeight;
        const last = [...rows].at(-1);
        if (!last) continue;
        last.scrollIntoView({ block: 'nearest' });
        const a = last.getBoundingClientRect();
        if (
          a.bottom > list.getBoundingClientRect().bottom + 1 ||
          a.bottom > el.getBoundingClientRect().bottom + 1
        )
          problems.push(`last row "${(last.textContent ?? '').slice(0, 30)}" can't be reached`);
      }
      return problems;
    });
    out.push(...fit.map((p) => `picker "${label}": ${p}`));
    await page.keyboard.press('Escape');
    if (await popover.isVisible()) out.push(`picker "${label}": Escape didn't close it`);
  }
  return out;
}
