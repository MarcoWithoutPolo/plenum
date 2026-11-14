import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { release, type as osType } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, Notification, shell } from 'electron';
import type { AppSettings, AppearanceSettings, BackgroundSettings } from '@plenum/shared';
import {
  BrainManager,
  Engine,
  GitHub,
  diagnosticsReport,
  silenceSqliteWarning,
} from '@plenum/core';
import {
  demoAdapters,
  demoData,
  demoFailure,
  demoGitHub,
  demoReadings,
  seedStress,
} from './demo.js';
import { registerIpc } from './ipc.js';
import { registerProjectIpc } from './projects-ipc.js';
import { Notifier } from './notify.js';
import { ElectronSnapshotter } from './snapshotter.js';
import { ACTIVE, AppTray } from './tray.js';
import { Updates } from './updates.js';
import { IPC, type SettingsPatch } from '../shared/api.js';

silenceSqliteWarning();
const here = fileURLToPath(new URL('.', import.meta.url));
const demo = process.env.PLENUM_DEMO === '1';

let window: BrowserWindow | null = null;
/** Set once the app is quitting: the window closes for real then. */
let quitting = false;
/** Decides what closing the window does (F11); set once the engine is up. */
let onClose: ((event: Electron.Event, win: BrowserWindow) => void) | null = null;
/** Started at sign-in (F11): stay in the tray until opened. */
const startHidden = process.argv.includes('--hidden');
/** How the app looks (F3), read once the engine is up; theme and zoom are applied here. */
let appearance: AppearanceSettings | undefined;

function applyAppearance(next: AppearanceSettings): void {
  appearance = next;
  // The renderer's light and dark styles follow prefers-color-scheme, which this sets.
  nativeTheme.themeSource = next.theme;
  if (window && !window.isDestroyed()) window.webContents.setZoomFactor(next.textScale);
}

/** Open at login (F11). Only the installed app registers itself; dev and demo runs never do. */
function applyBackground(next: BackgroundSettings): void {
  if (!app.isPackaged || demo || process.platform === 'linux') return;
  app.setLoginItemSettings({ openAtLogin: next.openAtLogin, args: ['--hidden'] });
}

/** Show the window, making it again if it was closed (macOS) and restoring it if minimized. */
function showWindow(): BrowserWindow {
  if (!window || window.isDestroyed()) window = createWindow();
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  return window;
}

/** Send to the renderer once it has loaded (a window opened just now isn't listening yet). */
function sendWhenLoaded(win: BrowserWindow, channel: string, ...args: unknown[]): void {
  const send = () => win.webContents.send(channel, ...args);
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send);
  else send();
}

function createWindow(visible = true): BrowserWindow {
  const dark = nativeTheme.shouldUseDarkColors;
  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'Plenum',
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
      // Text size (F3): the window's zoom, so menus and dialogs scale and measure together.
      zoomFactor: appearance?.textScale ?? 1,
      preload: join(here, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: true,
    },
  });

  if (visible) win.once('ready-to-show', () => win.show());
  win.on('close', (event) => {
    if (!quitting) onClose?.(event, win);
  });
  // Chromium remembers a zoom between launches; the text size setting is the only one that counts.
  win.webContents.on('did-finish-load', () =>
    win.webContents.setZoomFactor(appearance?.textScale ?? 1),
  );

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

function registerSettings(engine: Engine, brains: BrainManager): void {
  ipcMain.handle(IPC.settingsGet, (): AppSettings => engine.store.settings.get());
  ipcMain.handle(IPC.about, () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    platform: process.platform,
    // For Report a problem: the system's name and version, nothing about you.
    system: `${osType()} ${release()} ${process.arch}`,
    // The line that adds Plenum to Claude Code as an MCP server (F9).
    mcp: app.isPackaged
      ? `claude mcp add plenum -- "${process.execPath}" --mcp`
      : `claude mcp add plenum -- npm --prefix "${join(here, '../../../..')}" run -s plenum -- mcp`,
  }));
  // Export logs (C9): a redacted report, saved where you choose; nothing is sent anywhere.
  ipcMain.handle(IPC.diagnosticsExport, async () => {
    if (demo) demoFailure(IPC.diagnosticsExport);
    const name = `plenum-diagnostics-${new Date().toISOString().slice(0, 10)}.txt`;
    const target =
      demo && process.env.PLENUM_E2E_SAVE
        ? process.env.PLENUM_E2E_SAVE
        : (
            await dialog.showSaveDialog({
              title: 'Save the diagnostics report',
              defaultPath: join(app.getPath('downloads'), name),
              filters: [{ name: 'Text', extensions: ['txt'] }],
            })
          ).filePath;
    if (!target) return null;
    const report = await diagnosticsReport(engine, {
      version: app.getVersion(),
      electron: process.versions.electron,
      platform: process.platform,
      arch: process.arch,
    });
    writeFileSync(target, report);
    return { path: target };
  });
  // Read synchronously by the preload, so the first paint already has the right look.
  ipcMain.on(IPC.appearanceGet, (event) => {
    event.returnValue = engine.store.settings.get().appearance;
  });
  // The store merges each section and validates the whole result, so a patch only
  // changes the keys it names (and a bad value throws instead of being saved).
  ipcMain.handle(IPC.settingsUpdate, (_e, patch: SettingsPatch): AppSettings => {
    if (demo) demoFailure(IPC.settingsUpdate);
    const section = (v: unknown) =>
      v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
    const notifications = section(patch?.notifications);
    const limits = section(patch?.limits);
    const local = section(patch?.local);
    const defaults = section(patch?.defaults);
    const appearance = section(patch?.appearance);
    const council = section(patch?.council);
    const background = section(patch?.background);
    const firstRun = section(patch?.firstRun);
    const next = engine.store.settings.update({
      ...(notifications && { notifications }),
      ...(limits && { limits }),
      ...(local && { local }),
      ...(defaults && { defaults }),
      ...(appearance && { appearance }),
      ...(council && { council }),
      ...(background && { background }),
      ...(firstRun && { firstRun }),
    } as SettingsPatch);
    if (appearance) applyAppearance(next.appearance);
    if (background) applyBackground(next.background);
    // Limits changed (Pause everything off, quiet hours, caps): waiting projects look again now.
    if (limits) brains.wake();
    return next;
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
    projectName: (id) => engine.store.projects.get(id)?.name ?? 'Plenum',
    attention: () => {
      if (process.platform === 'win32' && window && !window.isDestroyed()) window.flashFrame(true);
    },
    show: (notice) => {
      if (!Notification.isSupported()) return;
      const n = new Notification({ title: notice.title, body: notice.body, silent: false });
      // A window opened just now (macOS, after closing it) gets the project once it has
      // loaded; sent earlier, nothing would be listening yet (U25).
      n.on('click', () => sendWhenLoaded(showWindow(), IPC.openProject, notice.projectId));
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

/**
 * Closing the window (F11). On Windows and Linux, with projects running, Plenum asks whether
 * to keep them running from the tray, and remembers the answer if you tick the box. macOS keeps
 * apps running with the window closed anyway, so it just closes there.
 */
function closeWindow(
  event: Electron.Event,
  win: BrowserWindow,
  engine: Engine,
  tray: boolean,
): void {
  if (process.platform === 'darwin' || !tray) return;
  const choice = engine.store.settings.get().background.onClose;
  if (choice === 'quit') return;
  const active = engine.store.projects.list().filter((p) => ACTIVE.includes(p.status));
  if (choice === 'ask' && active.length === 0) return;
  event.preventDefault();
  if (choice === 'keep') {
    win.hide();
    return;
  }
  void dialog
    .showMessageBox(win, {
      type: 'question',
      title: 'Plenum',
      message:
        active.length === 1
          ? `Keep “${active[0]!.name}” running in the background?`
          : `Keep ${active.length} projects running in the background?`,
      detail:
        'Plenum stays in the system tray and keeps working; open it again from the tray icon. Quitting stops the projects, and their steps go back to the queue.',
      buttons: ['Keep running', 'Quit Plenum', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      checkboxLabel: 'Remember my choice (change it in Settings → Background)',
    })
    .then(({ response, checkboxChecked }) => {
      if (response === 2) return;
      if (checkboxChecked)
        engine.store.settings.update({ background: { onClose: response === 0 ? 'keep' : 'quit' } });
      if (response === 0) win.hide();
      else app.quit();
    });
}

/**
 * `Plenum --mcp` (F9): no window, just the MCP server on stdio for Claude Code or another
 * client, on the same data as the app; it runs alongside an open Plenum. Electron's main
 * process can't read stdin on Windows, so this executable runs mcp.js again as plain Node,
 * handing over its stdin and stdout.
 */
const mcp = process.argv.includes('--mcp');
if (mcp) {
  const child = spawn(process.execPath, [join(here, 'mcp.js')], {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PLENUM_VERSION: app.getVersion() },
    windowsHide: true,
  });
  child.on('exit', (code) => app.exit(code ?? 0));
  child.on('error', () => app.exit(1));
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // The window may be closed (macOS) or hidden in the tray: show it (U25, F11).
    if (app.isReady()) showWindow();
  });

  void app.whenReady().then(async () => {
    const engine = new Engine(demo ? { adapters: demoAdapters() } : {});
    if (demo) demoReadings(engine.store);
    // The demo skips the first run (F7) unless a test asks for it.
    if (demo && !process.env.PLENUM_DEMO_FIRST_RUN)
      engine.store.settings.update({ firstRun: { done: true } });
    if (demo && demoData() === 'stress' && engine.store.listThreads(1).length === 0)
      await seedStress(engine.store, process.env.PLENUM_E2E_REPO);
    const brains = new BrainManager(engine, engine.home, {
      snapshotter: new ElectronSnapshotter(),
    });
    brains.recoverOrphans();
    registerIpc(engine, () => window);
    registerProjectIpc(engine, brains, demo ? demoGitHub() : new GitHub(), () => window);
    registerSettings(engine, brains);
    applyAppearance(engine.store.settings.get().appearance);
    watchForNotices(engine, brains);
    applyBackground(engine.store.settings.get().background);
    const updates = new Updates({
      enabled: app.isPackaged && !demo,
      building: () => engine.store.projects.list().some((p) => p.status === 'running'),
    });
    ipcMain.handle(IPC.updateGet, () => updates.get());
    ipcMain.handle(IPC.updateCheck, () => updates.check());
    ipcMain.handle(IPC.updateRestart, () => updates.restart());
    let tray: AppTray | null = null;
    try {
      tray = new AppTray(
        engine,
        brains,
        {
          show: () => void showWindow(),
          openProject: (id) => sendWhenLoaded(showWindow(), IPC.openProject, id),
          openInbox: () => sendWhenLoaded(showWindow(), IPC.openInbox),
          update: () => {
            const u = updates.get();
            return u.kind === 'ready' ? u.version : null;
          },
          restartToUpdate: () => {
            const r = updates.restart();
            if (!r.ok) void dialog.showMessageBox({ type: 'info', message: r.reason });
          },
          quit: () => app.quit(),
        },
        here,
      );
    } catch {
      // No tray on this desktop (some Linux ones): closing the window quits, as before.
    }
    if (demo) (globalThis as { plenumTray?: AppTray | null }).plenumTray = tray;
    updates.onChange((state) => {
      tray?.refresh();
      if (window && !window.isDestroyed()) window.webContents.send(IPC.updateChanged, state);
    });
    onClose = (event, win) => closeWindow(event, win, engine, Boolean(tray));
    window = createWindow(!startHidden);

    app.on('activate', () => void showWindow());

    // Running projects stop cleanly (tasks back in the queue) before the app exits.
    let stopped = false;
    app.on('before-quit', (event) => {
      quitting = true;
      if (stopped) return;
      stopped = true;
      event.preventDefault();
      tray?.destroy();
      void brains
        .stopAll('Plenum was closed')
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
