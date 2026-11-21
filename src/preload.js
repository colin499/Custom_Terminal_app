const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  home: ipcRenderer.sendSync('app:home'),
  loadProjects: () => ipcRenderer.invoke('projects:load'),
  saveProjects: (projects) => ipcRenderer.invoke('projects:save', projects),
  pickFolder: () => ipcRenderer.invoke('projects:pickFolder'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  resolveFolder: (p) => ipcRenderer.invoke('projects:resolveFolder', p),
  prepareDrop: (p) => ipcRenderer.invoke('drop:prepare', p),
  projectIcon: (project) => ipcRenderer.invoke('icon:project', { path: project.path, icon: project.icon }),
  fileIcon: (file) => ipcRenderer.invoke('icon:file', file),
  sessionStats: (cwd) => ipcRenderer.invoke('session:stats', cwd),

  ptyCreate: (opts) => ipcRenderer.invoke('pty:create', opts),
  ptyWrite: (id, data) => ipcRenderer.send('pty:write', { id, data }),
  ptyResize: (id, cols, rows) => ipcRenderer.send('pty:resize', { id, cols, rows }),
  saveStatus: (cwd, since) => ipcRenderer.invoke('save:status', { cwd, since }),
  claudeTabs: () => ipcRenderer.invoke('pty:claudeTabs'),
  ptyKill: (id) => ipcRenderer.send('pty:kill', { id }),
  onPtyData: (cb) => ipcRenderer.on('pty:data', (_e, payload) => cb(payload)),
  onPtyExit: (cb) => ipcRenderer.on('pty:exit', (_e, payload) => cb(payload)),
});
