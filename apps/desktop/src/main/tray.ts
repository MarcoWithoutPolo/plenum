import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { app, Menu, nativeImage, Tray, type MenuItemConstructorOptions } from 'electron';
import type { BrainManager, Engine } from '@conclave/core';

/** Statuses that mean a project's brain is still working, or waiting for a limit to reset. */
export const ACTIVE = ['running', 'waiting'];

export interface TrayActions {
  show(): void;
  /** A downloaded update's version, for Restart to update (F10). */
  update(): string | null;
  restartToUpdate(): void;
  openProject(projectId: string): void;
  openInbox(): void;
  quit(): void;
}

/**
 * The tray (menu bar on macOS) icon (v1.0 F11): Conclave stays reachable while its window is
 * closed and projects keep working. The menu lists the running projects and what waits in the
 * Inbox, and pauses or quits everything.
 */
export class AppTray {
  private readonly tray: Tray;
  private menu: Menu | null = null;

  constructor(
    private readonly engine: Engine,
    private readonly brains: BrainManager,
    private readonly actions: TrayActions,
    here: string,
  ) {
    const file = app.isPackaged
      ? join(process.resourcesPath, 'icon.png')
      : join(here, '../../build/icon.png');
    const size = process.platform === 'darwin' ? 18 : 32;
    const icon = existsSync(file)
      ? nativeImage.createFromPath(file).resize({ width: size, height: size })
      : nativeImage.createEmpty();
    this.tray = new Tray(icon);
    this.tray.setToolTip('Conclave');
    // Windows and Linux: a click opens the window; the menu is on right-click.
    if (process.platform !== 'darwin') this.tray.on('click', () => actions.show());
    this.refresh();
    brains.onEvent(() => this.refresh());
  }

  /** Labels of the menu as it stands, for tests. */
  labels(): string[] {
    return this.items().map((i) => i.label ?? (i.type === 'separator' ? '—' : ''));
  }

  /** Click a menu item by its label, as a person would (tests). */
  choose(label: string): void {
    const item = this.menu?.items.find((i) => i.label === label);
    if (!item) throw new Error(`No tray item "${label}"`);
    item.click();
  }

  refresh(): void {
    this.menu = Menu.buildFromTemplate(this.items());
    this.tray.setContextMenu(this.menu);
    const waiting = this.waiting();
    this.tray.setToolTip(waiting ? `Conclave: ${waiting} waiting for you` : 'Conclave');
  }

  destroy(): void {
    this.tray.destroy();
  }

  private waiting(): number {
    return this.engine.store.projects
      .list()
      .reduce((n, p) => n + this.engine.store.projects.approvals(p.id, 'pending').length, 0);
  }

  private items(): MenuItemConstructorOptions[] {
    const store = this.engine.store;
    const active = store.projects.list().filter((p) => ACTIVE.includes(p.status));
    const waiting = this.waiting();
    const paused = store.settings.get().limits.pauseAll;
    return [
      { label: 'Open Conclave', click: () => this.actions.show() },
      { type: 'separator' },
      ...(active.length
        ? active.slice(0, 8).map((p): MenuItemConstructorOptions => ({
            label: `${p.name}: ${p.status === 'waiting' ? 'waiting for a limit' : 'running'}`,
            click: () => this.actions.openProject(p.id),
          }))
        : [{ label: 'No projects running', enabled: false }]),
      {
        label: waiting ? `Inbox: ${waiting} waiting for you` : 'Inbox: nothing waiting',
        click: () => this.actions.openInbox(),
      },
      { type: 'separator' },
      {
        label: 'Pause everything',
        type: 'checkbox',
        checked: paused,
        click: (item) => {
          store.settings.update({ limits: { pauseAll: item.checked } });
          if (!item.checked) this.brains.wake();
          this.refresh();
        },
      },
      ...(this.actions.update()
        ? [
            {
              label: `Restart to update to ${this.actions.update()}`,
              click: () => this.actions.restartToUpdate(),
            },
          ]
        : []),
      { label: 'Quit Conclave', click: () => this.actions.quit() },
    ];
  }
}
