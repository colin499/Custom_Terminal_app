const { app, BrowserWindow, ipcMain, dialog, nativeImage } = require('electron');
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
ipcMain.on('app:home', (e) => { e.returnValue = os.homedir(); });
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

// ---- Project icons ----
// Each sidebar row shows a small picture of what the project is. An image set by hand
// (project.icon) wins; otherwise the folder is searched, a few levels deep, for the most
// telling file: an app icon or logo, a built .app, a render or screenshot, any other image,
// then a 3D model. macOS Quick Look draws the thumbnail, so models and PDFs work too.
const ICON_IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.heic', '.tif', '.tiff', '.bmp', '.svg', '.icns']);
const ICON_MODEL_EXT = new Set(['.stl', '.obj', '.usdz', '.3mf', '.step', '.stp']);
const ICON_SKIP_DIRS = new Set(['node_modules', 'venv', 'env', '__pycache__', 'target', 'Pods', 'DerivedData', 'vendor', 'fonts', 'logs', 'tmp', 'cache']);
const ICON_MAX_DEPTH = 3;
const ICON_MAX_ENTRIES = 4000;
const ICON_MAX_CANDIDATES = 400;

function iconScore(name, ext, depth) {
  const base = name.toLowerCase();
  let score;
  if (ext === '.app') score = 90;
  else if (ICON_IMAGE_EXT.has(ext)) {
    if (/^(app[-_ ]?)?(icon|logo|favicon)/.test(base)) score = 100;
    else if (/thumb|preview|render|screenshot|screen shot|cover|hero|banner/.test(base)) score = 80;
    else score = 50;
  } else if (ICON_MODEL_EXT.has(ext)) score = 40;
  else if (ext === '.pdf') score = 20;
  else return 0;
  return score - depth * 5;
}

async function iconCandidates(root) {
  const found = [];
  let seen = 0;
  let level = [root];
  for (let depth = 0; depth <= ICON_MAX_DEPTH && level.length; depth++) {
    const next = [];
    for (const dir of level) {
      let entries;
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
      for (const ent of entries) {
        if (++seen > ICON_MAX_ENTRIES || found.length >= ICON_MAX_CANDIDATES) break;
        if (ent.name.startsWith('.')) continue;
        const ext = path.extname(ent.name).toLowerCase();
        const full = path.join(dir, ent.name);
        if (ent.isDirectory() && ext !== '.app') {
          if (!ICON_SKIP_DIRS.has(ent.name)) next.push(full);
          continue;
        }
        const score = iconScore(ent.name, ext, depth);
        if (score > 0) found.push({ file: full, score });
      }
    }
    level = next;
  }
  // Newest first within a score, so a fresh render replaces an old one.
  await Promise.all(found.map(async (c) => {
    try { const st = await fs.promises.stat(c.file); c.mtime = st.mtimeMs; c.size = st.size; } catch { c.score = 0; }
  }));
  return found
    .filter((c) => c.score > 0 && (c.size >= 500 || c.file.endsWith('.app')))
    .sort((a, b) => b.score - a.score || b.mtime - a.mtime);
}

const thumbCache = new Map(); // "file:mtime" -> data URL, or null when Quick Look can't draw it

async function thumbnail(file) {
  let st;
  try { st = await fs.promises.stat(file); } catch { return null; }
  const key = `${file}:${st.mtimeMs}`;
  if (thumbCache.has(key)) return thumbCache.get(key);
  let url = null;
  try {
    const img = await Promise.race([
      nativeImage.createThumbnailFromPath(file, { width: 512, height: 512 }),
      new Promise((_r, reject) => setTimeout(() => reject(new Error('timed out')), 4000)),
    ]);
    if (!img.isEmpty()) url = img.toDataURL();
  } catch (err) {
    if (process.env.CT_DEBUG) console.log(`[main] no thumbnail for ${file}: ${err.message}`);
  }
  if (!url && file.endsWith('.app')) {
    try { const img = await app.getFileIcon(file, { size: 'normal' }); if (!img.isEmpty()) url = img.toDataURL(); } catch {}
  }
  thumbCache.set(key, url);
  return url;
}

ipcMain.handle('icon:file', (_e, file) => thumbnail(file));
ipcMain.handle('icon:project', async (_e, { path: root, icon }) => {
  if (icon) { const url = await thumbnail(icon); if (url) return url; }
  const candidates = await iconCandidates(root);
  for (const c of candidates.slice(0, 6)) {
    const url = await thumbnail(c.file);
    if (url) return url;
  }
  return null;
});

// ---- Claude Code status line integration ----
// Claude Code can pipe a JSON status payload (model, context window, usage limits) to a
// command after every reply. Monk installs a script that saves that payload per project.
const MONK_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'Monk');
const STATUS_DIR = path.join(MONK_DIR, 'status');
const STATUS_SCRIPT = path.join(MONK_DIR, 'statusline.sh');
// Claude Code runs the command through a shell, and the path has a space in it, so the
// registered command is the quoted path. (Earlier builds registered it unquoted and the
// shell looked for "/Users/.../Library/Application", so no status was ever saved.)
const STATUS_CMD = `"${STATUS_SCRIPT}"`;
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
    if (!current || current.command === STATUS_SCRIPT) {
      settings.statusLine = { type: 'command', command: STATUS_CMD };
      fs.mkdirSync(path.dirname(CLAUDE_SETTINGS), { recursive: true });
      fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2) + '\n');
      console.log('[main] registered Monk status line in', CLAUDE_SETTINGS);
    } else if (current.command !== STATUS_CMD) {
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
  out.statusLineOk = !!configured && configured.command === STATUS_CMD;
  return out;
});

// ---- "Save everything" results ----
// The save request asks Claude to end its reply with a line starting "MONK SAVED:" or
// "MONK NOT SAVED:". Claude's replies land in the project's session log, so that is where to
// look for it: the terminal screen also shows the request itself, which names both phrases.
ipcMain.handle('save:status', (_e, { cwd, since }) => {
  const dir = path.join(os.homedir(), '.claude', 'projects', encodeClaudeProjectDir(cwd));
  let result = null; // { ok, note, at } from the newest matching reply
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')); } catch {}
  for (const name of names) {
    const file = path.join(dir, name);
    let text;
    try {
      const st = fs.statSync(file);
      if (st.mtimeMs < since) continue;
      const len = Math.min(st.size, 2 << 20); // a save reply is always near the end
      const buf = Buffer.alloc(len);
      const fd = fs.openSync(file, 'r');
      try { text = buf.toString('utf8', 0, fs.readSync(fd, buf, 0, len, st.size - len)); } finally { fs.closeSync(fd); }
    } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.includes('"type":"assistant"') || !/MONK (NOT )?SAVED/i.test(line)) continue;
      let d; try { d = JSON.parse(line); } catch { continue; }
      const at = Date.parse(d.timestamp);
      if (!(at >= since) || !Array.isArray(d.message?.content)) continue;
      for (const block of d.message.content) {
        if (block.type !== 'text') continue;
        const marks = [...block.text.matchAll(/^\W*MONK (NOT )?SAVED\W*(.*)$/gim)];
        const m = marks[marks.length - 1];
        if (m && (!result || at >= result.at)) result = { ok: !m[1], note: m[2].replace(/[*_`]+/g, '').trim(), at };
      }
    }
  }
  return result;
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
// Tabs where Claude Code is the program in front, as opposed to a bare shell or another tool.
// "Save everything" only types into these: the same text sent to a shell would run as a command.
ipcMain.handle('pty:claudeTabs', () => new Promise((resolve) => {
  // node-pty's own process name is no use here: Claude Code is a symlink to a versioned
  // binary, so it reports "2.1.330". ps shows the command as typed, per terminal.
  execFile('/bin/ps', ['-Ao', 'tty=,stat=,args='], { maxBuffer: 8 << 20 }, (err, out) => {
    if (err) return resolve([]);
    const claudeTtys = new Set();
    for (const line of out.split('\n')) {
      const m = line.match(/^(\S+)\s+(\S+)\s+(.*)$/);
      // "+" in the state marks the terminal's foreground process group.
      if (m && m[2].includes('+') && /(^|\/)claude(\s|$)|claude-code/.test(m[3])) claudeTtys.add(m[1]);
    }
    const ids = [];
    for (const [id, p] of ptys) if (claudeTtys.has(path.basename(p.ptsName || p._pty || ''))) ids.push(id);
    resolve(ids);
  });
}));
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
