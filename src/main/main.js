'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { extractFile } = require('./extractors');
const { Database } = require('./db');
const { Settings } = require('./settings');
const { correct, recorrect, buildName } = require('./corrector');
const { GroqClient } = require('./groq');
const { toMarkdown } = require('./report');

let win;
let db;
let settings;
let currentAbort = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 980,
    minHeight: 640,
    title: 'Correcteur Intelligent',
    backgroundColor: '#0f1220',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: true
    }
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  // Les liens externes s'ouvrent dans le navigateur
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file:')) {
      e.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });
}

/** Enveloppe les handlers IPC pour renvoyer les erreurs proprement à l'interface. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      console.error(`[${channel}]`, err);
      return { __error: err.message || String(err) };
    }
  });
}

function registerIpc() {
  // ---- Fichiers ----
  handle('files:pick', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Choisir les fichiers (énoncé et réponses)', properties: ['openFile', 'multiSelections'] });
    return r.canceled ? [] : r.filePaths;
  });
  handle('files:pickFolder', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Choisir un dossier (projet, TP…)', properties: ['openDirectory'] });
    return r.canceled ? [] : r.filePaths;
  });
  handle('files:extract', (p) => extractFile(p));

  // ---- Correction ----
  const progress = (data) => win?.webContents.send('correct:progress', data);

  handle('correct:run', async ({ files, consigne }) => {
    currentAbort = new AbortController();
    try {
      const prefs = settings.corrector();
      const out = await correct({ apiKey: settings.getApiKey(), files, consigne, settings: prefs, progress, signal: currentAbort.signal });
      progress({ step: 'save', message: 'Enregistrement dans l\'historique…' });
      const now = new Date();
      const name = buildName(out.result, now);
      const id = db.saveCorrection({
        name,
        createdAt: now.toISOString(),
        result: out.result,
        files: files.map((f) => ({ name: f.name, role: f.role || 'auto' })),
        consigne,
        sources: out.sources,
        model: out.model
      });
      return { id, warnings: out.warnings };
    } finally {
      currentAbort = null;
    }
  });

  handle('correct:rerun', async (id) => {
    const rec = db.getCorrection(id);
    if (!rec) throw new Error('Correction introuvable.');
    currentAbort = new AbortController();
    try {
      const out = await recorrect({ apiKey: settings.getApiKey(), sources: rec.sources, consigne: rec.consigne, settings: settings.corrector(), progress, signal: currentAbort.signal });
      const now = new Date();
      const newId = db.saveCorrection({
        name: buildName(out.result, now) + ' (re-correction)',
        createdAt: now.toISOString(),
        folderId: rec.folder_id,
        result: out.result,
        files: rec.files,
        consigne: rec.consigne,
        sources: rec.sources,
        model: out.model
      });
      return { id: newId, warnings: out.warnings };
    } finally {
      currentAbort = null;
    }
  });

  handle('correct:cancel', () => {
    currentAbort?.abort();
    return true;
  });

  // ---- Base de données ----
  handle('db:folders', () => db.listFolders());
  handle('db:createFolder', (name, parentId) => db.createFolder(name, parentId));
  handle('db:renameFolder', (id, name) => db.renameFolder(id, name));
  handle('db:moveFolder', (id, parentId) => db.moveFolder(id, parentId));
  handle('db:deleteFolder', (id) => db.deleteFolder(id));
  handle('db:list', (q) => db.listCorrections(q || {}));
  handle('db:get', (id) => db.getCorrection(id));
  handle('db:update', (id, patch) => db.updateCorrection(id, patch));
  handle('db:delete', (id) => db.deleteCorrection(id));
  handle('db:stats', () => db.stats());

  // ---- Export ----
  const safeName = (s) => s.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120);
  handle('export:markdown', async (id) => {
    const rec = db.getCorrection(id);
    const r = await dialog.showSaveDialog(win, { defaultPath: safeName(rec.name) + '.md', filters: [{ name: 'Markdown', extensions: ['md'] }] });
    if (r.canceled) return false;
    fs.writeFileSync(r.filePath, toMarkdown(rec), 'utf8');
    return r.filePath;
  });
  handle('export:pdf', async (id) => {
    const rec = db.getCorrection(id);
    const r = await dialog.showSaveDialog(win, { defaultPath: safeName(rec.name) + '.pdf', filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (r.canceled) return false;
    const data = await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4', margins: { marginType: 'default' } });
    fs.writeFileSync(r.filePath, data);
    shell.openPath(r.filePath);
    return r.filePath;
  });

  // ---- Paramètres ----
  handle('settings:get', () => settings.public());
  handle('settings:save', (prefs) => settings.update(prefs));
  handle('settings:setKey', (key) => {
    settings.setApiKey(key);
    return settings.public();
  });
  handle('settings:testKey', async (key) => {
    const client = new GroqClient(String(key || settings.getApiKey() || '').trim());
    const models = await client.listModels();
    return { ok: true, models };
  });
  handle('app:openExternal', (url) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
  });
  handle('app:openDataFolder', () => shell.openPath(app.getPath('userData')));
  handle('app:version', () => app.getVersion());
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    const dataDir = app.getPath('userData');
    settings = new Settings(path.join(dataDir, 'settings.json'), safeStorage);
    db = await new Database(path.join(dataDir, 'corrections.sqlite')).open();
    registerIpc();
    if (app.isPackaged) Menu.setApplicationMenu(null);
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
