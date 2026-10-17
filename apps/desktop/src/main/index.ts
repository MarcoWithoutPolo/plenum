import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, nativeTheme, shell } from 'electron';
import { Engine, silenceSqliteWarning } from '@conclave/core';
import { demoAdapters } from './demo.js';
import { registerIpc } from './ipc.js';

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
    registerIpc(engine, () => window);
    window = createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) window = createWindow();
    });
    app.on('will-quit', () => engine.close());
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
