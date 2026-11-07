'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args).then((r) => {
  if (r && r.__error) throw new Error(r.__error);
  return r;
});
const on = (channel) => (cb) => {
  const handler = (_e, data) => cb(data);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

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
  onProgress: on('correct:progress'),
  runCode: (payload) => invoke('run:code', payload),
  // Modèles
  describeModels: (provider, force) => invoke('models:describe', provider, force),
  resolveModels: () => invoke('models:resolve'),
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
  dashboard: () => invoke('db:dashboard'),
  // Fiches de révision
  cards: (q) => invoke('cards:list', q),
  reviewCard: (id, grade) => invoke('cards:review', id, grade),
  updateCard: (id, patch) => invoke('cards:update', id, patch),
  deleteCard: (id) => invoke('cards:delete', id),
  addCard: (card) => invoke('cards:add', card),
  generateCards: (correctionId) => invoke('cards:generate', correctionId),
  onCardsAdded: on('cards:added'),
  // Exercices
  generateExercise: (opts) => invoke('ex:generate', opts),
  exercises: () => invoke('ex:list'),
  exercise: (id) => invoke('ex:get', id),
  updateExercise: (id, patch) => invoke('ex:update', id, patch),
  deleteExercise: (id) => invoke('ex:delete', id),
  submitExercise: (payload) => invoke('ex:submit', payload),
  // Export / sauvegarde / synchro
  exportMarkdown: (id) => invoke('export:markdown', id),
  exportPdf: (id) => invoke('export:pdf', id),
  exportBackup: () => invoke('backup:export'),
  importBackup: (mode) => invoke('backup:import', mode),
  chooseSyncDir: () => invoke('sync:chooseDir'),
  syncNow: () => invoke('sync:now'),
  disableSync: () => invoke('sync:disable'),
  onSyncStatus: on('sync:status'),
  // Téléphone
  phoneStart: () => invoke('phone:start'),
  phoneStop: () => invoke('phone:stop'),
  onPhoneFile: on('phone:file'),
  // Mises à jour
  checkUpdate: () => invoke('update:check'),
  installUpdate: () => invoke('update:install'),
  updateState: () => invoke('update:state'),
  onUpdateStatus: on('update:status'),
  // Paramètres
  getSettings: () => invoke('settings:get'),
  saveSettings: (prefs) => invoke('settings:save', prefs),
  setApiKey: (provider, key) => invoke('settings:setKey', provider, key),
  testApiKey: (provider, key) => invoke('settings:testKey', provider, key),
  openExternal: (url) => invoke('app:openExternal', url),
  openDataFolder: () => invoke('app:openDataFolder'),
  info: () => invoke('app:info')
});
