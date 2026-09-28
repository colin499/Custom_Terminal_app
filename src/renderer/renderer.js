// Renderer: sidebar of projects, one xterm per project, PTY via the preload bridge.
// xterm globals come from the UMD scripts loaded in index.html.
const TerminalCtor = window.Terminal;
const FitAddonCtor = window.FitAddon.FitAddon;
const WebLinksAddonCtor = window.WebLinksAddon.WebLinksAddon;

const THEME = {
  background: '#ffffff',
  foreground: '#000000',
  cursor: '#000000',
  cursorAccent: '#ffffff',
  selectionBackground: '#000000',
  selectionForeground: '#ffffff',
  black: '#000000', red: '#000000', green: '#000000', yellow: '#000000',
  blue: '#000000', magenta: '#000000', cyan: '#000000', white: '#888888',
  brightBlack: '#888888', brightRed: '#000000', brightGreen: '#000000', brightYellow: '#000000',
  brightBlue: '#000000', brightMagenta: '#000000', brightCyan: '#000000', brightWhite: '#000000',
};

let projects = [];           // [{ id, name, path }]
let activeId = null;
const sessions = new Map();  // id -> { term, fit, container, running }

const $list = document.getElementById('project-list');
const $terminals = document.getElementById('terminals');
const $empty = document.getElementById('empty-state');
const $title = document.getElementById('titlebar-drag');
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
    $list.appendChild(li);
  }
  $launch.disabled = !activeId;
}

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
$sidebar.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $sidebar.classList.add('drop-target'); });
$sidebar.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
$sidebar.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $sidebar.classList.remove('drop-target'); } });
$sidebar.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  $sidebar.classList.remove('drop-target');
  for (const file of Array.from(e.dataTransfer.files)) {
    const raw = window.api.pathForFile(file);
    const folder = raw && await window.api.resolveFolder(raw);
    if (folder) await addProjectPath(folder);
  }
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
  fit.fit();
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
  requestAnimationFrame(() => { session.fit.fit(); session.term.focus(); });
}

function updateMain() {
  const project = projects.find((p) => p.id === activeId);
  $empty.classList.toggle('hidden', !!project);
  $title.textContent = project ? project.path : '';
}

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
const ro = new ResizeObserver(() => {
  const s = sessions.get(activeId);
  if (s && s.container.classList.contains('visible')) s.fit.fit();
});
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
