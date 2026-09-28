// Renders build/icon.svg to build/icon.icns with a transparent background.
// Run with: npm run icon   (uses Electron so the SVG is rasterized by Chromium with alpha)
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const SVG = path.join(__dirname, 'icon.svg');
const OUT = path.join(__dirname, 'icon.icns');
const SIZES = [16, 32, 128, 256, 512];

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1024, height: 1024, show: false, transparent: true, frame: false,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true },
  });
  // A file:// page may load a file:// image; a data: page may not.
  const page = path.join(__dirname, '.icon-render.html');
  fs.writeFileSync(page, `<!doctype html><html><head><meta charset="utf-8"></head>
    <body style="margin:0;background:transparent"><img id="i" src="icon.svg" width="1024" height="1024" style="display:block"></body></html>`);
  await win.loadFile(page);
  await win.webContents.executeJavaScript('new Promise(r => { const i = document.getElementById("i"); if (i.complete) r(); else i.onload = r; })');
  await new Promise((r) => setTimeout(r, 300));
  const full = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  fs.unlinkSync(page);
  if (process.env.ICON_DEBUG_PNG) fs.writeFileSync(process.env.ICON_DEBUG_PNG, full.toPNG());

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'icon-'));
  const iconset = path.join(work, 'icon.iconset');
  fs.mkdirSync(iconset);
  for (const s of SIZES) {
    fs.writeFileSync(path.join(iconset, `icon_${s}x${s}.png`), full.resize({ width: s, height: s, quality: 'best' }).toPNG());
    fs.writeFileSync(path.join(iconset, `icon_${s}x${s}@2x.png`), full.resize({ width: s * 2, height: s * 2, quality: 'best' }).toPNG());
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', OUT]);
  fs.rmSync(work, { recursive: true, force: true });
  const bmp = full.toBitmap();
  console.log(`wrote ${OUT} (${fs.statSync(OUT).size} bytes), corner alpha = ${bmp[3]}`);
  app.quit();
});
