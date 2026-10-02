const {contextBridge, ipcRenderer} = require('electron');
contextBridge.exposeInMainWorld('fjordDesktop', Object.freeze({
  play: data => ipcRenderer.invoke('native-play', data),
  connect: url => ipcRenderer.invoke('connect', url),
  onEnded: callback => ipcRenderer.on('native-ended', () => callback()),
}));
