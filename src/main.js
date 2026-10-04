const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const pty = require('node-pty');
const { execFile } = require('child_process');

const PROJECTS_FILE = () => path.join(app.getPath('userData'), 'projects.json');

let win = null;
const ptys = new Map(); // projectId -> pty process

// Earlier builds stored projects under these app names. Merge them in once.
const LEGACY_NAMES = ['Your Terminal', 'Claude Terminal', 'claude-terminal'];

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
    backgroundColor: '#e9dcc3',
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

// Files dropped on the terminal: return the path to paste. Formats Claude Code can't read
// as images (HEIC/HEIF) are converted to JPEG in the app's data folder first.
ipcMain.handle('drop:prepare', (_e, file) => new Promise((resolve) => {
  const ext = path.extname(file).toLowerCase();
  if (ext !== '.heic' && ext !== '.heif') return resolve(file);
  const outDir = path.join(app.getPath('userData'), 'converted');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, path.basename(file, ext) + '.jpg');
  execFile('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '90', file, '--out', out], (err) => {
    // sips can exit 0 and only print a warning, so check the output really exists.
    if (err || !fs.existsSync(out)) { console.error('[main] HEIC conversion failed:', err ? err.message : 'no output'); return resolve(file); }
    resolve(out);
  });
}));

// ---- Claude Code status line integration ----
// Claude Code can pipe a JSON status payload (model, context window, usage limits) to a
// command after every reply. Monk installs a script that saves that payload per project.
const MONK_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'Monk');
const STATUS_DIR = path.join(MONK_DIR, 'status');
const STATUS_SCRIPT = path.join(MONK_DIR, 'statusline.sh');
const CLAUDE_SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');

function ensureStatusLine() {
  try {
    fs.mkdirSync(STATUS_DIR, { recursive: true });
    const src = path.join(__dirname, '..', 'build', 'statusline.sh');
    const body = fs.readFileSync(src, 'utf8');
    if (!fs.existsSync(STATUS_SCRIPT) || fs.readFileSync(STATUS_SCRIPT, 'utf8') !== body) {
      fs.writeFileSync(STATUS_SCRIPT, body, { mode: 0o755 });
    }
    fs.chmodSync(STATUS_SCRIPT, 0o755);
    const settings = readJson(CLAUDE_SETTINGS) || {};
    const current = settings.statusLine;
    if (!current) {
      settings.statusLine = { type: 'command', command: STATUS_SCRIPT };
      fs.mkdirSync(path.dirname(CLAUDE_SETTINGS), { recursive: true });
      fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2) + '\n');
      console.log('[main] registered Monk status line in', CLAUDE_SETTINGS);
    } else if (current.command !== STATUS_SCRIPT) {
      console.log('[main] a different statusLine is configured; usage limits will not be available');
    }
  } catch (err) {
    console.error('[main] could not set up status line:', err.message);
  }
}

function statusPayload(cwd) {
  const file = path.join(STATUS_DIR, encodeClaudeProjectDir(cwd) + '.json');
  try {
    const st = fs.statSync(file);
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { data: d, at: st.mtimeMs };
  } catch { return null; }
}

// ---- Model detection ----
// Claude Code logs each session to ~/.claude/projects/<encoded cwd>/<session>.jsonl; every
// assistant line records the model that produced it, so the newest one is the model in use.
function encodeClaudeProjectDir(cwd) { return cwd.replace(/[^A-Za-z0-9]/g, '-'); }

function configuredModel(cwd) {
  const candidates = [
    path.join(cwd, '.claude', 'settings.local.json'),
    path.join(cwd, '.claude', 'settings.json'),
    path.join(os.homedir(), '.claude', 'settings.json'),
  ];
  for (const f of candidates) { const m = readJson(f)?.model; if (m) return m; }
  return process.env.ANTHROPIC_MODEL || null;
}

function newestSessionFile(cwd) {
  const dir = path.join(os.homedir(), '.claude', 'projects', encodeClaudeProjectDir(cwd));
  let newest = null;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(dir, name);
      const st = fs.statSync(file);
      if (!newest || st.mtimeMs > newest.mtime) newest = { file, mtime: st.mtimeMs, size: st.size };
    }
  } catch {}
  return newest;
}

// Incremental scan of a session log. Cached per file so each poll only reads new bytes.
const statsCache = new Map(); // file -> { offset, partial, model, context, totals, budget }

function scanSession(info) {
  let c = statsCache.get(info.file);
  if (!c || c.offset > info.size) {
    c = { offset: 0, partial: '', model: null, context: 0, totals: { input: 0, output: 0 }, budget: { total: 0, left: null } };
    statsCache.set(info.file, c);
  }
  if (info.size > c.offset) {
    const fd = fs.openSync(info.file, 'r');
    try {
      const len = info.size - c.offset;
      const buf = Buffer.alloc(len);
      let got = 0;
      while (got < len) { // readSync may return fewer bytes than asked for on large reads
        const n = fs.readSync(fd, buf, got, len - got, c.offset + got);
        if (n <= 0) break;
        got += n;
      }
      c.offset += got;
      const text = c.partial + buf.toString('utf8', 0, got);
      const lines = text.split('\n');
      c.partial = lines.pop(); // possibly incomplete last line
      for (const line of lines) {
        if (line.includes('"type":"assistant"')) {
          let d; try { d = JSON.parse(line); } catch { continue; }
          const m = d?.message; if (!m) continue;
          if (m.model) c.model = m.model;
          const u = m.usage;
          if (u) {
            const ctx = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
            if (ctx) c.context = ctx;
            c.totals.input += ctx;
            c.totals.output += u.output_tokens || 0;
          }
        } else if (line.includes('total_tokens_reminder')) {
          const m = line.match(/<total_tokens>(\d+) tokens left<\/total_tokens>/);
          if (m) { const left = Number(m[1]); c.budget.left = left; c.budget.total = Math.max(c.budget.total, left); }
        }
      }
    } finally { fs.closeSync(fd); }
  }
  return c;
}

ipcMain.handle('session:stats', (_e, cwd) => {
  const cfg = configuredModel(cwd);
  const info = newestSessionFile(cwd);
  const c = info ? scanSession(info) : null;
  const status = statusPayload(cwd);
  const out = { model: cfg, source: cfg ? 'settings' : null, at: null, context: null, rate: null, totals: c ? c.totals : null, statusLineOk: true };

  if (c) {
    const oneM = (cfg && /\[1m\]/i.test(cfg)) || c.context > 200000;
    if (c.model) { out.model = c.model; out.source = 'session'; }
    out.at = info.mtime;
    if (c.context) out.context = { used: c.context, window: oneM ? 1000000 : 200000 };
  }
  // The status payload is authoritative when present and newer than the log.
  if (status && (!info || status.at >= info.mtime - 5000)) {
    const d = status.data;
    if (d.model?.id) { out.model = d.model.id; out.source = 'status'; out.at = status.at; }
    const cw = d.context_window;
    if (cw && cw.context_window_size) out.context = { used: cw.total_input_tokens || 0, window: cw.context_window_size, pct: cw.used_percentage };
    const rl = d.rate_limits;
    if (rl) out.rate = { five: rl.five_hour || null, seven: rl.seven_day || null, spend: rl.spend_limit || null, at: status.at };
  }
  const configured = readJson(CLAUDE_SETTINGS)?.statusLine;
  out.statusLineOk = !!configured && configured.command === STATUS_SCRIPT;
  return out;
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

app.whenReady().then(() => { ensureStatusLine(); createWindow(); });
app.on('window-all-closed', () => {
  for (const p of ptys.values()) { try { p.kill(); } catch {} }
  ptys.clear();
  app.quit();
});
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
