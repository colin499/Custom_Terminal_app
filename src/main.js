const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const pty = require('node-pty');

const PROJECTS_FILE = () => path.join(app.getPath('userData'), 'projects.json');

let win = null;
const ptys = new Map(); // projectId -> pty process

// Earlier builds stored projects under these app names. Merge them in once.
const LEGACY_NAMES = ['Claude Terminal', 'claude-terminal'];

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function loadProjects() {
  const current = readJson(PROJECTS_FILE());
  if (current) return current;
  const merged = [];
  for (const name of LEGACY_NAMES) {
    const list = readJson(path.join(path.dirname(app.getPath('userData')), name, 'projects.json')) || [];
    for (const p of list) if (!merged.some((m) => m.path === p.path)) merged.push(p);
  }
  if (merged.length) saveProjects(merged);
  return merged;
}

function saveProjects(projects) {
  fs.mkdirSync(path.dirname(PROJECTS_FILE()), { recursive: true });
  fs.writeFileSync(PROJECTS_FILE(), JSON.stringify(projects, null, 2));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 700,
    minHeight: 400,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#f3ede3',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  if (process.env.CT_DEBUG) {
    win.webContents.on('console-message', (ev) => console.log(`[renderer:${ev.level}] ${ev.message}`));
    win.webContents.on('did-finish-load', () => {
      console.log('[main] renderer loaded');
      if (process.env.CT_EVAL) {
        setTimeout(() => win.webContents.executeJavaScript(process.env.CT_EVAL)
          .then((r) => console.log('[main] CT_EVAL result:', JSON.stringify(r)))
          .catch((err) => console.log('[main] CT_EVAL error:', err.message)), 1000);
      }
      if (process.env.CT_SCREENSHOT) {
        setTimeout(async () => {
          const img = await win.webContents.capturePage();
          fs.writeFileSync(process.env.CT_SCREENSHOT, img.toPNG());
          console.log(`[main] screenshot written to ${process.env.CT_SCREENSHOT}`);
        }, 2500);
      }
    });
  }
  win.on('closed', () => { win = null; });
}

// ---- Projects ----
ipcMain.handle('projects:load', () => loadProjects());
ipcMain.handle('projects:save', (_e, projects) => { saveProjects(projects); return true; });
ipcMain.handle('projects:pickFolder', async () => {
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: path.join(os.homedir(), 'Desktop'),
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('projects:resolveFolder', (_e, p) => {
  try {
    const st = fs.statSync(p);
    return st.isDirectory() ? p : path.dirname(p);
  } catch {
    return null;
  }
});

// ---- PTY ----
ipcMain.handle('pty:create', (_e, { id, cwd, cols, rows }) => {
  if (ptys.has(id)) return true;
  const shell = process.env.SHELL || '/bin/zsh';
  const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: process.env.LANG || 'en_US.UTF-8' };
  let proc;
  try {
    proc = pty.spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols: cols || 80,
      rows: rows || 24,
      cwd: fs.existsSync(cwd) ? cwd : os.homedir(),
      env,
    });
  } catch (err) {
    console.error(`[main] failed to spawn pty for ${id}:`, err);
    return { error: err.message };
  }
  ptys.set(id, proc);
  if (process.env.CT_DEBUG) console.log(`[main] pty spawned for ${id} in ${cwd} (${cols}x${rows})`);
  proc.onData((data) => { if (win) win.webContents.send('pty:data', { id, data }); });
  proc.onExit(({ exitCode }) => {
    ptys.delete(id);
    if (win) win.webContents.send('pty:exit', { id, exitCode });
  });
  return true;
});
ipcMain.on('pty:write', (_e, { id, data }) => { const p = ptys.get(id); if (p) p.write(data); });
ipcMain.on('pty:resize', (_e, { id, cols, rows }) => {
  const p = ptys.get(id);
  if (p && cols > 0 && rows > 0) { try { p.resize(cols, rows); } catch {} }
});
ipcMain.on('pty:kill', (_e, { id }) => { const p = ptys.get(id); if (p) { p.kill(); ptys.delete(id); } });

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  for (const p of ptys.values()) { try { p.kill(); } catch {} }
  ptys.clear();
  app.quit();
});
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
