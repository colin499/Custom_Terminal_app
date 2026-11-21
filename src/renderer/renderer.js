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

let projects = [];           // [{ id, name, path, icon? }]  icon: an image file chosen by hand
let activeId = null;
const sessions = new Map();  // id -> { term, fit, container, running }
const saves = new Map();     // id -> { since, state: 'wait' | 'ok' | 'fail', note }  from the last "Save everything"

// A fixed row for working outside any project: a shell (and Claude) in the home folder.
const SCRATCH = { id: 'scratch', name: 'Scratch', path: window.api.home };
function findProject(id) { return id === SCRATCH.id ? SCRATCH : projects.find((p) => p.id === id); }

const $list = document.getElementById('project-list');
const $terminals = document.getElementById('terminals');
const $empty = document.getElementById('empty-state');
const $title = document.getElementById('title-path');
const $model = document.getElementById('title-model');
const $launch = document.getElementById('launch-claude');

// ---------- Project icons ----------
// Each row shows a thumbnail found in the project folder (see "Project icons" in main.js).
// Until one arrives, or when the folder has nothing to show, the row gets a block pattern
// drawn from the project's name, so every row still looks different.
const icons = new Map();     // id -> { url, at }
const ICON_MAX_AGE = 30000;

function patternIcon(name) {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) { h ^= name.charCodeAt(i); h = Math.imul(h, 16777619); }
  let rects = '';
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 3; x++) {
      if (!((h >>> (y * 3 + x)) & 1)) continue;
      rects += `<rect x="${x}" y="${y}" width="1" height="1"/>`;
      if (x < 2) rects += `<rect x="${4 - x}" y="${y}" width="1" height="1"/>`;
    }
  }
  return `<svg viewBox="-1.5 -1.5 8 8" shape-rendering="crispEdges" fill="currentColor">${rects}</svg>`;
}

function paintIcon(li, p) {
  const cell = li.querySelector('.icon');
  const url = icons.get(p.id)?.url;
  if (url) {
    const img = document.createElement('img');
    img.src = url;
    img.draggable = false;
    cell.replaceChildren(img);
  } else cell.innerHTML = patternIcon(p.name);
}

async function loadIcon(p, force) {
  const have = icons.get(p.id);
  if (!force && have && Date.now() - have.at < ICON_MAX_AGE) return;
  icons.set(p.id, { url: have?.url || null, at: Date.now() });
  const url = await window.api.projectIcon(p).catch(() => null);
  icons.set(p.id, { url, at: Date.now() });
  const li = Array.from($list.children).find((el) => el.dataset.id === p.id);
  if (li) paintIcon(li, p);
  if (previewId === p.id) { if (url) $preview.firstChild.src = url; else hidePreview(); }
}

// Hovering a row's icon shows the same picture larger, beside the sidebar. Rows with only a
// generated pattern have nothing more to show, so they get no preview.
const $preview = document.createElement('div');
$preview.id = 'icon-preview';
$preview.appendChild(document.createElement('img'));
document.body.appendChild($preview);
let previewId = null;

function showPreview(cell, id) {
  const url = icons.get(id)?.url;
  if (!url || draggingId !== null) return;
  previewId = id;
  $preview.firstChild.src = url;
  $preview.classList.add('visible');
  const row = cell.getBoundingClientRect();
  const size = $preview.offsetHeight;
  const top = Math.max(8, Math.min(row.top, window.innerHeight - size - 8));
  $preview.style.top = `${top}px`;
  $preview.style.left = `${$sidebar.getBoundingClientRect().right + 8}px`;
}

function hidePreview() {
  previewId = null;
  $preview.classList.remove('visible');
}

// ---------- Projects ----------
function renderProjects() {
  hidePreview();
  $list.innerHTML = '';
  for (const p of [SCRATCH, ...projects]) {
    const scratch = p === SCRATCH;
    const li = document.createElement('li');
    li.className = 'project' + (scratch ? ' scratch' : '') + (p.id === activeId ? ' active' : '') + (sessions.get(p.id)?.running ? ' running' : '');
    li.dataset.id = p.id;
    li.innerHTML = `
      <span class="index"></span>
      <span class="icon"></span>
      <div class="info">
        <div class="name"></div>
        <div class="path"></div>
      </div>
      <span class="save"></span>
      <span class="dot" title="Shell running"></span>
      <button class="remove" title="Remove from list">×</button>`;
    li.querySelector('.index').textContent = scratch ? '~' : String(projects.indexOf(p) + 1).padStart(2, '0');
    li.querySelector('.name').textContent = p.name;
    li.querySelector('.path').textContent = scratch ? 'No project · home folder' : p.path;
    li.querySelector('.path').title = p.path;
    const save = saves.get(p.id);
    if (save) {
      const mark = li.querySelector('.save');
      mark.textContent = save.state === 'ok' ? '✓' : save.state === 'fail' ? '!' : '…';
      mark.title = save.state === 'wait' ? 'Waiting for Claude to finish saving' : save.note || (save.state === 'ok' ? 'Saved' : 'Not saved');
    }
    li.addEventListener('click', () => activate(p.id));
    if (scratch) { li.querySelector('.remove').remove(); li.querySelector('.icon').remove(); }
    else {
      paintIcon(li, p);
      const cell = li.querySelector('.icon');
      cell.addEventListener('mouseenter', () => showPreview(cell, p.id));
      cell.addEventListener('mouseleave', hidePreview);
      li.querySelector('.remove').addEventListener('click', (e) => { e.stopPropagation(); removeProject(p.id); });
      wireRowDrag(li, p.id);
    }
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
    hidePreview();
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
  loadIcon(project);
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
  // A single image (or model) file dropped on a project's row becomes that project's icon.
  const row = e.target.closest?.('.project:not(.scratch)');
  const target = row && projects.find((p) => p.id === row.dataset.id);
  for (const file of Array.from(e.dataTransfer.files)) {
    const raw = window.api.pathForFile(file);
    const folder = raw && await window.api.resolveFolder(raw);
    if (target && folder && folder !== raw && e.dataTransfer.files.length === 1 && await window.api.fileIcon(raw)) {
      target.icon = raw;
      await window.api.saveProjects(projects);
      loadIcon(target, true);
      return;
    }
    if (folder) await addProjectPath(folder);
  }
});
// Dropping files on the terminal pastes their paths, like Terminal.app: backslash-escaped
// and sent as a paste (bracketed when the program asks for it). Claude Code only attaches
// an image path as [Image #n] when it arrives as a paste; typed, it stays plain text.
function shellEscape(p) { return p.replace(/[^A-Za-z0-9_\-.,:+=@%\/\u0080-￿]/g, '\\$&'); }
function pastePaths(s, paths) {
  s.term.paste(paths.map(shellEscape).join(' ') + ' ');
  s.term.focus();
}
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
  if (paths.length) pastePaths(s, paths);
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
  icons.delete(id);
  await window.api.saveProjects(projects);
  if (activeId === id) {
    activeId = null;
    activate(projects.length ? projects[0].id : SCRATCH.id);
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
  const project = findProject(id);
  if (!project) return;
  activeId = id;
  if (project !== SCRATCH) loadIcon(project); // pick up a new render or screenshot
  for (const s of sessions.values()) s.container.classList.remove('visible');
  const session = ensureSession(project);
  session.container.classList.add('visible');
  updateMain();
  renderProjects();
  requestAnimationFrame(() => { fitSession(session); session.term.focus(); });
}

function updateMain() {
  const project = findProject(activeId);
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
  if (ms <= 0) return 'now';
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
  if (h >= 48) return `${Math.round(h / 24)}d`;
  return h ? `${h}h${String(m).padStart(2, '0')}` : `${m}m`;
}

async function refreshModel() {
  const project = findProject(activeId);
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
    setBar('ctx-fill', 'ctx-text', pct, `${Math.round(pct)}% ${fmtK(c.used)}/${fmtK(c.window)}`);
  } else setBar('ctx-fill', 'ctx-text', null, '—', 'No Claude session for this project yet');

  const r = info.rate;
  const noStatus = info.statusLineOk ? 'Appears after the next Claude reply' : 'Needs the Monk status line in Claude settings';
  if (r && r.five) setBar('five-fill', 'five-text', r.five.used_percentage, `${Math.round(r.five.used_percentage)}% ↻${resetsIn(r.five.resets_at)}`, `Resets ${new Date(r.five.resets_at * 1000).toLocaleString()}`);
  else setBar('five-fill', 'five-text', null, '—', noStatus);
  if (r && r.seven) setBar('seven-fill', 'seven-text', r.seven.used_percentage, `${Math.round(r.seven.used_percentage)}% ↻${resetsIn(r.seven.resets_at)}`, `Resets ${new Date(r.seven.resets_at * 1000).toLocaleString()}`);
  else setBar('seven-fill', 'seven-text', null, '—', noStatus);

  document.getElementById('totals-text').textContent = info.totals ? `IN ${fmtK(info.totals.input)} OUT ${fmtK(info.totals.output)}` : '—';
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

// "Save everything": before quitting, ask Claude in every tab where it is running to save its
// work, so no tab has to be visited by hand. Tabs sitting at a shell prompt are left alone.
// A Claude that is mid-task queues the message and gets to it when it finishes. Each asked
// row shows "…" until Claude's reply reports the result, then a check, or "!" if it couldn't.
const SAVE_PROMPT = 'Save and back up everything you have done in this project. If this folder is a git repository, commit all uncommitted work and push it to the remote; if it has no remote, commit and say it was not pushed. If it is not a git repository, do not create one: make sure all the work is written to its files in this folder. End your reply with one final line that starts with "MONK SAVED:" followed by a few words on what was saved, or "MONK NOT SAVED:" followed by what went wrong.';
const $saveAll = document.getElementById('save-all');
const SAVE_LABEL = $saveAll.textContent;
let saveTimer = null;

async function pollSaves() {
  let waiting = 0, changed = false;
  for (const [id, save] of saves) {
    if (save.state !== 'wait') continue;
    const project = findProject(id);
    const res = project && sessions.get(id)?.running ? await window.api.saveStatus(project.path, save.since).catch(() => null) : null;
    if (res) { save.state = res.ok ? 'ok' : 'fail'; save.note = res.note; changed = true; }
    else if (!project || !sessions.get(id)?.running) { saves.delete(id); changed = true; } // tab closed before it answered
    else waiting++;
  }
  if (changed) renderProjects();
  if (!waiting) { clearInterval(saveTimer); saveTimer = null; }
}

$saveAll.addEventListener('click', async () => {
  $saveAll.disabled = true;
  const ids = (await window.api.claudeTabs().catch(() => [])).filter((id) => sessions.get(id)?.running);
  saves.clear();
  for (const id of ids) {
    saves.set(id, { since: Date.now(), state: 'wait', note: '' });
    // Sent as a paste so Claude Code takes it as one message, then Enter once it has landed.
    sessions.get(id).term.paste(SAVE_PROMPT);
    setTimeout(() => window.api.ptyWrite(id, '\r'), 300);
  }
  renderProjects();
  if (ids.length && !saveTimer) saveTimer = setInterval(pollSaves, 2000);
  $saveAll.textContent = ids.length ? `Asked ${ids.length} ${ids.length === 1 ? 'tab' : 'tabs'}` : 'No Claude running';
  setTimeout(() => { $saveAll.textContent = SAVE_LABEL; $saveAll.disabled = false; }, 2500);
  sessions.get(activeId)?.term.focus();
});

// Cmd+1..9 switches projects, Cmd+0 is the scratch row, Cmd+N adds a project.
window.addEventListener('keydown', (e) => {
  if (!e.metaKey) return;
  if (e.key === 'n') { e.preventDefault(); addProject(); }
  if (e.key === '0') { e.preventDefault(); activate(SCRATCH.id); }
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
  for (const p of projects) loadIcon(p);
  activate(projects.length ? projects[0].id : SCRATCH.id);
})();
