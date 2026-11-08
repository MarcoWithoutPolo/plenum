import electronUpdater from 'electron-updater';
import type { UpdateState } from '../shared/api.js';

const DAY = 24 * 60 * 60_000;
const RELEASES = 'https://github.com/MarcoWithoutPolo/plenum/releases/latest';

/**
 * Updates from the public repository's releases (v1.0 F10): checked at start and then daily,
 * downloaded quietly, installed on the next restart. Restart to update is refused while a
 * project is building. Only the installed app updates; dev and demo runs never check.
 */
export class Updates {
  private state: UpdateState;
  private readonly listeners = new Set<(s: UpdateState) => void>();

  constructor(private readonly opts: { building: () => boolean; enabled: boolean }) {
    this.state = opts.enabled
      ? { kind: 'idle', checkedAt: null }
      : { kind: 'off', reason: 'Updates are checked by the installed app only.' };
    if (!opts.enabled) return;
    const { autoUpdater } = electronUpdater;
    // macOS can only install signed updates; unsigned builds point at the release instead.
    const selfInstall = process.platform !== 'darwin';
    autoUpdater.autoDownload = selfInstall;
    autoUpdater.autoInstallOnAppQuit = selfInstall;
    autoUpdater.on('checking-for-update', () => this.set({ kind: 'checking' }));
    autoUpdater.on('update-not-available', () => this.set({ kind: 'idle', checkedAt: Date.now() }));
    autoUpdater.on('update-available', (info) =>
      this.set(
        selfInstall
          ? { kind: 'downloading', version: info.version, percent: 0 }
          : { kind: 'available', version: info.version, url: RELEASES },
      ),
    );
    autoUpdater.on('download-progress', (p) => {
      if (this.state.kind === 'downloading')
        this.set({ ...this.state, percent: Math.round(p.percent) });
    });
    autoUpdater.on('update-downloaded', (info) =>
      this.set({ kind: 'ready', version: info.version }),
    );
    autoUpdater.on('error', (err) =>
      this.set({ kind: 'error', message: err.message.split('\n')[0] ?? 'Update check failed' }),
    );
    // A minute after start, so it never slows the first window; then once a day.
    setTimeout(() => this.check(), 60_000).unref();
    setInterval(() => this.check(), DAY).unref();
  }

  get(): UpdateState {
    return this.state;
  }

  onChange(listener: (s: UpdateState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  check(): void {
    if (!this.opts.enabled || this.state.kind === 'downloading' || this.state.kind === 'ready')
      return;
    electronUpdater.autoUpdater.checkForUpdates().catch(() => {
      // Reported through the 'error' event.
    });
  }

  /** Restart now and install, unless a project is building. */
  restart(): { ok: true } | { ok: false; reason: string } {
    if (this.state.kind !== 'ready') return { ok: false, reason: 'No update is ready.' };
    if (this.opts.building())
      return {
        ok: false,
        reason: 'A project is building. The update installs when you next quit Plenum.',
      };
    electronUpdater.autoUpdater.quitAndInstall(false, true);
    return { ok: true };
  }

  private set(next: UpdateState): void {
    this.state = next;
    for (const l of this.listeners) l(next);
  }
}
