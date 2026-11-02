// Renders build/icon.svg to build/icon.png (1024×1024) with Electron itself: `electron build/make-icon.cjs`.
const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: { offscreen: true },
  });
  const svg = readFileSync(join(__dirname, 'icon.svg'), 'utf8');
  await win.loadURL(
    `data:text/html,<body style="margin:0;background:transparent">${encodeURIComponent(svg)}</body>`,
  );
  await new Promise((r) => setTimeout(r, 300));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  writeFileSync(join(__dirname, 'icon.png'), img.resize({ width: 1024, height: 1024 }).toPNG());
  app.quit();
});
