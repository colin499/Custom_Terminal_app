const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  loadProjects: () => ipcRenderer.invoke('projects:load'),
  saveProjects: (projects) => ipcRenderer.invoke('projects:save', projects),
  pickFolder: () => ipcRenderer.invoke('projects:pickFolder'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  resolveFolder: (p) => ipcRenderer.invoke('projects:resolveFolder', p),

  ptyCreate: (opts) => ipcRenderer.invoke('pty:create', opts),
  ptyWrite: (id, data) => ipcRenderer.send('pty:write', { id, data }),
  ptyResize: (id, cols, rows) => ipcRenderer.send('pty:resize', { id, cols, rows }),
  ptyKill: (id) => ipcRenderer.send('pty:kill', { id }),
  onPtyData: (cb) => ipcRenderer.on('pty:data', (_e, payload) => cb(payload)),
  onPtyExit: (cb) => ipcRenderer.on('pty:exit', (_e, payload) => cb(payload)),
});
