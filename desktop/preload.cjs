const {contextBridge, ipcRenderer} = require('electron');
contextBridge.exposeInMainWorld('fjordDesktop', Object.freeze({
  play: data => ipcRenderer.invoke('native-play', data),
  connect: url => ipcRenderer.invoke('connect', url),
  checkUpdates: () => ipcRenderer.invoke('check-updates'),
  toggleFullscreen: () => ipcRenderer.invoke('toggle-fullscreen'),
  getFullscreen: () => ipcRenderer.invoke('get-fullscreen'),
  onFullscreen: callback => ipcRenderer.on('fullscreen-changed', (_event, value) => callback(value)),
  onEnded: callback => ipcRenderer.on('native-ended', () => callback()),
}));
