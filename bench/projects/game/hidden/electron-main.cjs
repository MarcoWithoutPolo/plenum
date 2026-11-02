// Opens the game under test in an Electron window, for the hidden game checks.
//
// Unlike the other benchmarks' windows, this one is shown: a never-shown window paints a busy
// canvas at only a few frames a second, which would make any game look broken. It is shown
// inactive, far off-screen, without a taskbar button, so it never takes focus or gets in the way.
const { app, BrowserWindow } = require('electron');

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    x: -6000,
    y: 0,
    show: false,
    skipTaskbar: true,
    focusable: false,
    webPreferences: { backgroundThrottling: false },
  });
  win.loadURL(process.env.GAME_URL);
  win.showInactive();
});
app.on('window-all-closed', () => app.quit());
