// Opens the page under test in a hidden Electron window, for the hidden kanban checks.
const { app, BrowserWindow } = require('electron');

app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 1280, height: 800, show: false });
  win.loadURL(process.env.KANBAN_URL);
});
app.on('window-all-closed', () => app.quit());
