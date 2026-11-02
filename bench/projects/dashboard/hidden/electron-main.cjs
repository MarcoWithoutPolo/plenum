// Opens the page under test in a hidden Electron window, for the hidden dashboard checks.
// Downloads are saved straight into DOWNLOAD_DIR (no save dialog).
const { app, BrowserWindow, session } = require('electron');
const { join } = require('node:path');

app.whenReady().then(() => {
  session.defaultSession.on('will-download', (_e, item) => {
    item.setSavePath(join(process.env.DOWNLOAD_DIR, item.getFilename() || 'download.csv'));
  });
  const win = new BrowserWindow({ width: 1440, height: 900, show: false });
  win.loadURL(process.env.DASHBOARD_URL);
});
app.on('window-all-closed', () => app.quit());
