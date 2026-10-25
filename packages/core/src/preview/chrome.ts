import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { killTree, removeDir } from '../process.js';
import { delimiter, join } from 'node:path';
import type { ShotStep } from '@conclave/shared';
import {
  captureWithCdp,
  type CdpSession,
  type Snapshot,
  type Snapshotter,
  type View,
} from './snapshot.js';

/** A Chrome, Edge or Chromium on this computer, or null. CONCLAVE_CHROME picks one explicitly. */
export function findChrome(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.CONCLAVE_CHROME && existsSync(env.CONCLAVE_CHROME)) return env.CONCLAVE_CHROME;
  const candidates: string[] = [];
  if (process.platform === 'win32') {
    for (const base of [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA]) {
      if (!base) continue;
      candidates.push(
        join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        join(base, 'Chromium', 'Application', 'chrome.exe'),
      );
    }
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    );
  } else {
    const names = [
      'google-chrome',
      'google-chrome-stable',
      'chromium',
      'chromium-browser',
      'microsoft-edge',
    ];
    for (const dir of (env.PATH ?? '').split(delimiter))
      for (const n of names) candidates.push(join(dir, n));
  }
  return candidates.find((c) => existsSync(c)) ?? null;
}

/** A DevTools session over a page target's WebSocket. */
function wsSession(url: string): Promise<{ session: CdpSession; close: () => void }> {
  return new Promise((ok, fail) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map<
      number,
      { ok: (v: Record<string, unknown>) => void; fail: (e: Error) => void }
    >();
    const handlers = new Map<string, Set<(p: Record<string, unknown>) => void>>();
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(String(e.data)) as {
        id?: number;
        result?: Record<string, unknown>;
        error?: { message: string };
        method?: string;
        params?: Record<string, unknown>;
      };
      if (msg.id !== undefined) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p?.fail(new Error(msg.error.message));
        else p?.ok(msg.result ?? {});
      } else if (msg.method) {
        for (const h of handlers.get(msg.method) ?? []) h(msg.params ?? {});
      }
    });
    ws.addEventListener('error', () => fail(new Error('Couldn’t connect to the browser.')));
    ws.addEventListener('open', () =>
      ok({
        session: {
          send: (method, params = {}) =>
            new Promise((resolve, reject) => {
              const n = ++id;
              pending.set(n, { ok: resolve, fail: reject });
              ws.send(JSON.stringify({ id: n, method, params }));
            }),
          on: (event, handler) => {
            const set = handlers.get(event) ?? new Set();
            set.add(handler);
            handlers.set(event, set);
            return () => set.delete(handler);
          },
        },
        close: () => ws.close(),
      }),
    );
  });
}

/**
 * Screenshots in a headless Chrome or Edge, for the CLI and the benchmark. One browser for all
 * captures, one capture at a time; close() takes the browser and its temp profile away.
 */
export class ChromeSnapshotter implements Snapshotter {
  private child: ChildProcess | undefined;
  private profile: string | undefined;
  private page: Promise<{ session: CdpSession; close: () => void }> | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly executable: string) {}

  private start(): Promise<{ session: CdpSession; close: () => void }> {
    this.page ??= new Promise((ok, fail) => {
      this.profile = mkdtempSync(join(tmpdir(), 'conclave-chrome-'));
      const child = spawn(
        this.executable,
        [
          '--headless=new',
          '--remote-debugging-port=0',
          `--user-data-dir=${this.profile}`,
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-gpu',
          '--hide-scrollbars',
          '--mute-audio',
          // CI containers on Linux often can't start Chrome's sandbox; real machines keep it.
          ...(process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []),
          'about:blank',
        ],
        // Its own process group on macOS and Linux, so close() takes Chrome's helpers down too.
        { windowsHide: true, detached: process.platform !== 'win32' },
      );
      this.child = child;
      let err = '';
      const timer = setTimeout(
        () => fail(new Error(`The browser didn't start.\n${err.slice(-500)}`)),
        45_000, // a first start on a busy machine can be slow
      );
      child.on('exit', (code) =>
        fail(new Error(`The browser exited (${code}).\n${err.slice(-500)}`)),
      );
      child.stderr?.on('data', async (chunk: Buffer) => {
        err += chunk.toString();
        const m = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(err);
        if (!m) return;
        clearTimeout(timer);
        try {
          const list = (await (await fetch(`http://127.0.0.1:${m[1]}/json/list`)).json()) as {
            type: string;
            webSocketDebuggerUrl: string;
          }[];
          const target = list.find((t) => t.type === 'page');
          if (!target) throw new Error('The browser has no page to use.');
          ok(await wsSession(target.webSocketDebuggerUrl));
        } catch (e) {
          fail(e instanceof Error ? e : new Error(String(e)));
        }
      });
    });
    return this.page;
  }

  capture(url: string, view: View, steps?: ShotStep[]): Promise<Snapshot> {
    const run = this.queue.then(async () =>
      captureWithCdp((await this.start()).session, url, view, steps),
    );
    this.queue = run.catch(() => undefined);
    return run;
  }

  async close(): Promise<void> {
    const page = this.page;
    this.page = undefined;
    await page?.then((p) => p.close()).catch(() => undefined);
    const child = this.child;
    this.child = undefined;
    if (child) await killTree(child);
    // Chrome's helpers can still be letting go of the profile for a moment.
    if (this.profile) await removeDir(this.profile);
    this.profile = undefined;
  }
}
