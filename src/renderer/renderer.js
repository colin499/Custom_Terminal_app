// Renderer: sidebar of projects, one xterm per project, PTY via the preload bridge.
// xterm globals come from the UMD scripts loaded in index.html.
const TerminalCtor = window.Terminal;
const FitAddonCtor = window.FitAddon.FitAddon;
const WebLinksAddonCtor = window.WebLinksAddon.WebLinksAddon;

const THEME = {
  background: '#e9dcc3',
  foreground: '#141210',
  cursor: '#141210',
  cursorAccent: '#e9dcc3',
  selectionBackground: '#141210',
  selectionForeground: '#e9dcc3',
  black: '#141210', red: '#141210', green: '#141210', yellow: '#141210',
  blue: '#141210', magenta: '#141210', cyan: '#141210', white: '#8c8378',
  brightBlack: '#8c8378', brightRed: '#141210', brightGreen: '#141210', brightYellow: '#141210',
  brightBlue: '#141210', brightMagenta: '#141210', brightCyan: '#141210', brightWhite: '#141210',
};

let projects = [];           // [{ id, name, path }]
let activeId = null;
const sessions = new Map();  // id -> { term, fit, container, running }

const $list = document.getElementById('project-list');
const $terminals = document.getElementById('terminals');
const $empty = document.getElementById('empty-state');
const $title = document.getElementById('title-path');
const $model = document.getElementById('title-model');
const $launch = document.getElementById('launch-claude');

// ---------- Projects ----------
function renderProjects() {
  $list.innerHTML = '';
  for (const p of projects) {
    const li = document.createElement('li');
    li.className = 'project' + (p.id === activeId ? ' active' : '') + (sessions.get(p.id)?.running ? ' running' : '');
    li.dataset.id = p.id;
    li.innerHTML = `
      <span class="index"></span>
      <div class="info">
        <div class="name"></div>
        <div class="path"></div>
      </div>
      <span class="dot" title="Shell running"></span>
      <button class="remove" title="Remove from list">×</button>`;
    li.querySelector('.index').textContent = String(projects.indexOf(p) + 1).padStart(2, '0');
    li.querySelector('.name').textContent = p.name;
    li.querySelector('.path').textContent = p.path;
    li.querySelector('.path').title = p.path;
    li.addEventListener('click', () => activate(p.id));
    li.querySelector('.remove').addEventListener('click', (e) => { e.stopPropagation(); removeProject(p.id); });
    wireRowDrag(li, p.id);
    $list.appendChild(li);
  }
  $launch.disabled = !activeId;
}

// ---------- Reordering rows by drag ----------
const ROW_MIME = 'application/x-monk-project';
let draggingId = null;

function clearDropMarkers() {
  for (const el of $list.querySelectorAll('.drop-before, .drop-after')) el.classList.remove('drop-before', 'drop-after');
}

function isRowDrag(e) {
  return draggingId !== null || Array.from(e.dataTransfer?.types || []).includes(ROW_MIME);
}

async function moveProject(id, toIndex) {
  const from = projects.findIndex((p) => p.id === id);
  if (from < 0) return;
  const [item] = projects.splice(from, 1);
  if (toIndex > from) toIndex--;
  projects.splice(Math.max(0, Math.min(toIndex, projects.length)), 0, item);
  await window.api.saveProjects(projects);
  renderProjects();
}

function wireRowDrag(li, id) {
  li.draggable = true;
  li.addEventListener('dragstart', (e) => {
    draggingId = id;
    e.dataTransfer.setData(ROW_MIME, id);
    e.dataTransfer.effectAllowed = 'move';
    requestAnimationFrame(() => li.classList.add('dragging'));
  });
  li.addEventListener('dragend', () => {
    draggingId = null;
    li.classList.remove('dragging');
    clearDropMarkers();
  });
  li.addEventListener('dragover', (e) => {
    if (!isRowDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    const rect = li.getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;
    clearDropMarkers();
    li.classList.add(after ? 'drop-after' : 'drop-before');
  });
  li.addEventListener('drop', (e) => {
    if (!isRowDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const after = li.classList.contains('drop-after');
    clearDropMarkers();
    const target = projects.findIndex((p) => p.id === id);
    moveProject(draggingId || e.dataTransfer.getData(ROW_MIME), after ? target + 1 : target);
  });
}

// Dropping a row on the empty space below the list moves it to the end.
$list.addEventListener('dragover', (e) => {
  if (!isRowDrag(e) || e.target !== $list) return;
  e.preventDefault();
  e.stopPropagation();
  clearDropMarkers();
  $list.lastElementChild?.classList.add('drop-after');
});
$list.addEventListener('drop', (e) => {
  if (!isRowDrag(e) || e.target !== $list) return;
  e.preventDefault();
  e.stopPropagation();
  clearDropMarkers();
  moveProject(draggingId || e.dataTransfer.getData(ROW_MIME), projects.length);
});

async function addProject() {
  const folder = await window.api.pickFolder();
  if (folder) await addProjectPath(folder);
}

async function addProjectPath(folder) {
  const existing = projects.find((p) => p.path === folder);
  if (existing) { activate(existing.id); return; }
  const project = { id: `p_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, name: folder.split('/').filter(Boolean).pop() || folder, path: folder };
  projects.push(project);
  await window.api.saveProjects(projects);
  activate(project.id);
}

// Drag a folder from Finder onto the sidebar to add it as a project.
const $sidebar = document.getElementById('sidebar');
let dragDepth = 0;
$sidebar.addEventListener('dragenter', (e) => { if (isRowDrag(e)) return; e.preventDefault(); dragDepth++; $sidebar.classList.add('drop-target'); });
$sidebar.addEventListener('dragover', (e) => { if (isRowDrag(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
$sidebar.addEventListener('dragleave', (e) => { if (isRowDrag(e)) return; if (--dragDepth <= 0) { dragDepth = 0; $sidebar.classList.remove('drop-target'); } });
$sidebar.addEventListener('drop', async (e) => {
  if (isRowDrag(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $sidebar.classList.remove('drop-target');
  for (const file of Array.from(e.dataTransfer.files)) {
    const raw = window.api.pathForFile(file);
    const folder = raw && await window.api.resolveFolder(raw);
    if (folder) await addProjectPath(folder);
  }
});
// Dropping files on the terminal pastes their paths, like Terminal.app.
function shellQuote(p) { return "'" + p.replace(/'/g, "'\\''") + "'"; }
$terminals.addEventListener('dragover', (e) => {
  if (isRowDrag(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'link';
});
$terminals.addEventListener('drop', async (e) => {
  if (isRowDrag(e)) return;
  e.preventDefault();
  const s = sessions.get(activeId);
  if (!s || !s.running) return;
  const paths = [];
  for (const file of Array.from(e.dataTransfer.files)) {
    const raw = window.api.pathForFile(file);
    if (raw) paths.push(await window.api.prepareDrop(raw));
  }
  if (!paths.length) return;
  window.api.ptyWrite(activeId, paths.map(shellQuote).join(' ') + ' ');
  s.term.focus();
});

// Dropping anywhere else should not navigate the window away.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

async function removeProject(id) {
  const s = sessions.get(id);
  if (s) {
    window.api.ptyKill(id);
    s.term.dispose();
    s.container.remove();
    sessions.delete(id);
  }
  projects = projects.filter((p) => p.id !== id);
  await window.api.saveProjects(projects);
  if (activeId === id) {
    activeId = null;
    if (projects.length) activate(projects[0].id); else renderProjects();
  } else {
    renderProjects();
  }
  updateMain();
}

// ---------- Terminal sessions ----------
// Fit the terminal to its container, then make sure the rendered screen really fits:
// if the last row would be clipped, drop rows until it isn't.
function fitSession(s) {
  if (!s || !s.container.classList.contains('visible')) return;
  s.fit.fit();
  const screen = s.container.querySelector('.xterm-screen');
  if (!screen) return;
  for (let i = 0; i < 3; i++) {
    const overflow = screen.getBoundingClientRect().bottom - s.container.getBoundingClientRect().bottom;
    if (overflow <= 0 || s.term.rows <= 2) break;
    s.term.resize(s.term.cols, s.term.rows - 1);
  }
}
function ensureSession(project) {
  if (sessions.has(project.id)) return sessions.get(project.id);

  const container = document.createElement('div');
  container.className = 'term-container';
  $terminals.appendChild(container);

  const term = new TerminalCtor({
    theme: THEME,
    fontFamily: '"Space Mono", Menlo, monospace',
    fontSize: 12,
    lineHeight: 1.4,
    cursorBlink: false,
    cursorStyle: 'block',
    scrollback: 10000,
    macOptionIsMeta: true,
    allowProposedApi: true,
  });
  const fit = new FitAddonCtor();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddonCtor());
  term.open(container);

  const session = { term, fit, container, running: false };
  sessions.set(project.id, session);

  term.onData((data) => window.api.ptyWrite(project.id, data));
  term.onResize(({ cols, rows }) => window.api.ptyResize(project.id, cols, rows));

  // Spawn shell after first fit so the pty gets the right size.
  container.classList.add('visible');
  fitSession(session);
  window.api.ptyCreate({ id: project.id, cwd: project.path, cols: term.cols, rows: term.rows }).then((result) => {
    if (result && result.error) {
      term.write(`\x1b[31mFailed to start shell: ${result.error}\x1b[0m\r\n`);
      return;
    }
    session.running = true;
    renderProjects();
  }).catch((err) => term.write(`\x1b[31mFailed to start shell: ${err.message}\x1b[0m\r\n`));

  return session;
}

function activate(id) {
  const project = projects.find((p) => p.id === id);
  if (!project) return;
  activeId = id;
  for (const s of sessions.values()) s.container.classList.remove('visible');
  const session = ensureSession(project);
  session.container.classList.add('visible');
  updateMain();
  renderProjects();
  requestAnimationFrame(() => { fitSession(session); session.term.focus(); });
}

function updateMain() {
  const project = projects.find((p) => p.id === activeId);
  $empty.classList.toggle('hidden', !!project);
  $title.textContent = project ? project.path : '';
  refreshModel();
}

// ---------- Model label ----------
// "claude-opus-5-5" -> "OPUS 5.5"; "claude-haiku-4-5-20251001" -> "HAIKU 4.5"; "fable[1m]" -> "FABLE [1M]"
function prettyModel(id) {
  if (!id) return '';
  let s = id.replace(/^claude-/, '').replace(/-\d{8}$/, '');
  const m = s.match(/^([a-z]+)-(\d+)-(\d+)$/i);
  if (m) s = `${m[1]} ${m[2]}.${m[3]}`;
  return s.toUpperCase();
}

const $stats = document.getElementById('statsbar');
const fmtK = (n) => n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'K' : String(n);

function setBar(fillId, textId, pct, text, title) {
  const fill = document.getElementById(fillId), label = document.getElementById(textId);
  if (pct === null || pct === undefined) { fill.style.width = '0'; fill.classList.remove('warn'); label.textContent = text || '—'; label.title = title || ''; return; }
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  fill.style.width = p + '%';
  fill.classList.toggle('warn', p >= 80);
  label.textContent = text;
  label.title = title || '';
}

function resetsIn(epochSeconds) {
  const ms = epochSeconds * 1000 - Date.now();
  if (ms <= 0) return 'resets now';
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
  if (h >= 48) return `resets in ${Math.round(h / 24)}d`;
  return h ? `resets in ${h}h ${m}m` : `resets in ${m}m`;
}

async function refreshModel() {
  const project = projects.find((p) => p.id === activeId);
  if (!project) { $model.textContent = ''; $stats.classList.add('hidden'); return; }
  $stats.classList.remove('hidden');
  const info = await window.api.sessionStats(project.path);

  if (!info.model) { $model.textContent = 'MODEL: DEFAULT'; $model.classList.add('stale'); }
  else {
    $model.textContent = prettyModel(info.model);
    const live = (info.source === 'status' || info.source === 'session') && Date.now() - info.at < 30 * 60 * 1000;
    $model.classList.toggle('stale', !live);
    $model.title = `${info.model} (from ${info.source === 'status' ? 'Claude Code status' : info.source === 'session' ? 'latest session log' : 'settings'})`;
  }

  const c = info.context;
  if (c) {
    const pct = c.pct ?? (100 * c.used / c.window);
    setBar('ctx-fill', 'ctx-text', pct, `${Math.round(pct)}%  ${fmtK(c.used)} / ${fmtK(c.window)}`);
  } else setBar('ctx-fill', 'ctx-text', null, '—', 'No Claude session for this project yet');

  const r = info.rate;
  const noStatus = info.statusLineOk ? 'Appears after the next Claude reply' : 'Needs the Monk status line in Claude settings';
  if (r && r.five) setBar('five-fill', 'five-text', r.five.used_percentage, `${Math.round(r.five.used_percentage)}%  ${resetsIn(r.five.resets_at)}`);
  else setBar('five-fill', 'five-text', null, '—', noStatus);
  if (r && r.seven) setBar('seven-fill', 'seven-text', r.seven.used_percentage, `${Math.round(r.seven.used_percentage)}%  ${resetsIn(r.seven.resets_at)}`);
  else setBar('seven-fill', 'seven-text', null, '—', noStatus);

  document.getElementById('totals-text').textContent = info.totals ? `IN ${fmtK(info.totals.input)}  OUT ${fmtK(info.totals.output)}` : '—';
}
setInterval(refreshModel, 3000);

// ---------- PTY events ----------
window.api.onPtyData(({ id, data }) => { sessions.get(id)?.term.write(data); });
window.api.onPtyExit(({ id, exitCode }) => {
  const s = sessions.get(id);
  if (!s) return;
  s.running = false;
  s.term.write(`\r\n\x1b[90m[shell exited with code ${exitCode}. Click the project again to restart.]\x1b[0m\r\n`);
  renderProjects();
  // Allow restart: next activate() will create a fresh session.
  s.container.addEventListener('click', () => restartSession(id), { once: true });
});

function restartSession(id) {
  const s = sessions.get(id);
  if (!s || s.running) return;
  s.term.dispose();
  s.container.remove();
  sessions.delete(id);
  if (activeId === id) activate(id);
}

// ---------- Resize ----------
const ro = new ResizeObserver(() => fitSession(sessions.get(activeId)));
ro.observe($terminals);

// ---------- UI wiring ----------
document.getElementById('add-project').addEventListener('click', addProject);
$launch.addEventListener('click', () => {
  const s = sessions.get(activeId);
  if (!s || !s.running) return;
  window.api.ptyWrite(activeId, 'claude\r');
  s.term.focus();
});

// Cmd+1..9 switches projects, Cmd+N adds one.
window.addEventListener('keydown', (e) => {
  if (!e.metaKey) return;
  if (e.key === 'n') { e.preventDefault(); addProject(); }
  const n = parseInt(e.key, 10);
  if (n >= 1 && n <= 9 && projects[n - 1]) { e.preventDefault(); activate(projects[n - 1].id); }
});

// ---------- Init ----------
(async () => {
  // Make sure the terminal font is loaded before xterm measures glyphs.
  await Promise.all([
    document.fonts.load('400 12px "Space Mono"'),
    document.fonts.load('700 12px "Space Mono"'),
  ]).catch(() => {});
  projects = await window.api.loadProjects();
  renderProjects();
  updateMain();
  if (projects.length) activate(projects[0].id);
})();
