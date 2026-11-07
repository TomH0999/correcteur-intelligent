'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args).then((r) => {
  if (r && r.__error) throw new Error(r.__error);
  return r;
});

contextBridge.exposeInMainWorld('api', {
  // Fichiers
  pathForFile: (file) => webUtils.getPathForFile(file),
  pickFiles: () => invoke('files:pick'),
  pickFolder: () => invoke('files:pickFolder'),
  extract: (filePath) => invoke('files:extract', filePath),
  // Correction
  correct: (payload) => invoke('correct:run', payload),
  recorrect: (id) => invoke('correct:rerun', id),
  cancel: () => invoke('correct:cancel'),
  onProgress: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('correct:progress', handler);
    return () => ipcRenderer.removeListener('correct:progress', handler);
  },
  // Base de données
  folders: () => invoke('db:folders'),
  createFolder: (name, parentId) => invoke('db:createFolder', name, parentId),
  renameFolder: (id, name) => invoke('db:renameFolder', id, name),
  moveFolder: (id, parentId) => invoke('db:moveFolder', id, parentId),
  deleteFolder: (id) => invoke('db:deleteFolder', id),
  list: (query) => invoke('db:list', query),
  get: (id) => invoke('db:get', id),
  update: (id, patch) => invoke('db:update', id, patch),
  remove: (id) => invoke('db:delete', id),
  stats: () => invoke('db:stats'),
  // Export
  exportMarkdown: (id) => invoke('export:markdown', id),
  exportPdf: (id) => invoke('export:pdf', id),
  // Paramètres
  getSettings: () => invoke('settings:get'),
  saveSettings: (prefs) => invoke('settings:save', prefs),
  setApiKey: (key) => invoke('settings:setKey', key),
  testApiKey: (key) => invoke('settings:testKey', key),
  openExternal: (url) => invoke('app:openExternal', url),
  openDataFolder: () => invoke('app:openDataFolder'),
  version: () => invoke('app:version')
});
