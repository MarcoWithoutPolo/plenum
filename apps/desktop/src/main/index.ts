import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, ipcMain, nativeTheme, Notification, shell } from 'electron';
import type { AppSettings } from '@conclave/shared';
import { BrainManager, Engine, GitHub, silenceSqliteWarning } from '@conclave/core';
import { demoAdapters, demoGitHub } from './demo.js';
import { registerIpc } from './ipc.js';
import { registerProjectIpc } from './projects-ipc.js';
import { Notifier } from './notify.js';
import { IPC, type SettingsPatch } from '../shared/api.js';

silenceSqliteWarning();
const here = fileURLToPath(new URL('.', import.meta.url));
const demo = process.env.CONCLAVE_DEMO === '1';

let window: BrowserWindow | null = null;

function createWindow(): BrowserWindow {
  const dark = nativeTheme.shouldUseDarkColors;
  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'Conclave',
    show: false,
    backgroundColor: dark ? '#131416' : '#fafaf9',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform !== 'darwin' && {
      titleBarOverlay: {
        color: '#00000000',
        symbolColor: dark ? '#d6d3d1' : '#44403c',
        height: 40,
      },
    }),
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: true,
    },
  });

  win.once('ready-to-show', () => win.show());

  // The renderer never navigates; links open in the user's browser.
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(join(here, '../renderer/index.html'));
  return win;
}

function registerSettings(engine: Engine): void {
  ipcMain.handle(IPC.settingsGet, (): AppSettings => engine.store.settings.get());
  // The store merges each section and validates the whole result, so a patch only
  // changes the keys it names (and a bad value throws instead of being saved).
  ipcMain.handle(IPC.settingsUpdate, (_e, patch: SettingsPatch): AppSettings => {
    const section = (v: unknown) =>
      v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
    const notifications = section(patch?.notifications);
    const limits = section(patch?.limits);
    return engine.store.settings.update({
      ...(notifications && { notifications }),
      ...(limits && { limits }),
    } as SettingsPatch);
  });
}

/** Desktop notifications for what needs you, while the window is elsewhere (C6). */
function watchForNotices(engine: Engine, brains: BrainManager): void {
  const inbox = () =>
    engine.store.projects
      .list()
      .reduce((n, p) => n + engine.store.projects.approvals(p.id, 'pending').length, 0);
  const notifier = new Notifier({
    focused: () => Boolean(window && !window.isDestroyed() && window.isFocused()),
    settings: () => engine.store.settings.get().notifications,
    projectName: (id) => engine.store.projects.get(id)?.name ?? 'Conclave',
    attention: () => {
      if (process.platform === 'win32' && window && !window.isDestroyed()) window.flashFrame(true);
    },
    show: (notice) => {
      if (!Notification.isSupported()) return;
      const n = new Notification({ title: notice.title, body: notice.body, silent: false });
      n.on('click', () => {
        if (!window || window.isDestroyed()) window = createWindow();
        if (window.isMinimized()) window.restore();
        window.show();
        window.focus();
        window.webContents.send(IPC.openProject, notice.projectId);
      });
      n.show();
    },
  });
  brains.onEvent((event) => {
    notifier.handle(event);
    // macOS: the dock shows how many things wait in the inbox.
    if (process.platform === 'darwin' && ['question', 'approval', 'done'].includes(event.kind)) {
      app.setBadgeCount(inbox());
    }
  });
}

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });

  void app.whenReady().then(() => {
    const engine = new Engine(demo ? { adapters: demoAdapters() } : {});
    const brains = new BrainManager(engine, engine.home);
    brains.recoverOrphans();
    registerIpc(engine, () => window);
    registerProjectIpc(engine, brains, demo ? demoGitHub() : new GitHub(), () => window);
    registerSettings(engine);
    watchForNotices(engine, brains);
    window = createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) window = createWindow();
    });

    // Running projects stop cleanly (tasks back in the queue) before the app exits.
    let quitting = false;
    app.on('before-quit', (event) => {
      if (quitting) return;
      quitting = true;
      event.preventDefault();
      void brains
        .stopAll('Conclave was closed')
        .catch(() => {})
        .finally(() => {
          engine.close();
          app.quit();
        });
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
