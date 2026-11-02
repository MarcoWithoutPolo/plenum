// Opens the site under test in a hidden Electron window, for the hidden site checks.
const { app, BrowserWindow } = require('electron');

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    // A hidden window is throttled like a background tab: no frames, no media-query events.
    webPreferences: { backgroundThrottling: false },
  });
  win.loadURL(process.env.SITE_URL);
});
app.on('window-all-closed', () => app.quit());
