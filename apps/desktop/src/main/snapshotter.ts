import { BrowserWindow } from 'electron';
import {
  captureWithCdp,
  type CdpSession,
  type Snapshot,
  type Snapshotter,
  type View,
} from '@conclave/core';

/**
 * Screenshots in Electron's own Chromium: one hidden, off-screen, sandboxed window per shot, in its own
 * storage partition (no Node, no preload, no pop-ups), driven through the DevTools Protocol.
 */
export class ElectronSnapshotter implements Snapshotter {
  private queue: Promise<unknown> = Promise.resolve();

  capture(url: string, view: View): Promise<Snapshot> {
    const run = this.queue.then(() => this.shoot(url, view));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async shoot(url: string, view: View): Promise<Snapshot> {
    const win = new BrowserWindow({
      show: false,
      width: view.width,
      height: view.height,
      webPreferences: {
        partition: 'conclave-shots',
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        // Hidden windows aren't painted; off-screen rendering paints them without showing them.
        offscreen: true,
      },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    // A window that never loaded a page doesn't answer DevTools commands yet.
    await win.loadURL('about:blank');
    const dbg = win.webContents.debugger;
    dbg.attach('1.3');
    const session: CdpSession = {
      send: (method, params) => dbg.sendCommand(method, params) as Promise<Record<string, unknown>>,
      on: (event, handler) => {
        const listener = (_e: unknown, method: string, params: Record<string, unknown>) => {
          if (method === event) handler(params);
        };
        dbg.on('message', listener);
        return () => dbg.removeListener('message', listener);
      },
    };
    try {
      return await captureWithCdp(session, url, view);
    } finally {
      try {
        dbg.detach();
      } catch {
        // the window may already be gone
      }
      win.destroy();
    }
  }
}
