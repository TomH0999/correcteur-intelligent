'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

// Données propres à CETTE installation : la version de développement n'utilise jamais la base de l'application installée
if (!app.isPackaged && !app.commandLine.hasSwitch('user-data-dir')) {
  app.setPath('userData', path.join(app.getPath('appData'), 'Correcteur Intelligent (dev)'));
}

const { extractFile } = require('./extractors');
const { Database } = require('./db');
const { Settings } = require('./settings');
const { correct, recorrect, buildName, generateFlashcards, generateExercise } = require('./corrector');
const { createProvider, PROVIDERS } = require('./providers');
const { ModelResolver } = require('./models');
const { toMarkdown } = require('./report');
const runner = require('./runner');
const ocr = require('./ocr');
const backup = require('./backup');
const updater = require('./updater');
const phone = require('./phone');

let win;
let db;
let settings;
let resolver;
let currentAbort = null;
let syncTimer = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    title: 'Correcteur Intelligent',
    backgroundColor: '#020617',
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

const send = (channel, data) => win?.webContents.send(channel, data);

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

function providerFor(id) {
  const prefs = settings.prefs;
  return createProvider(id, settings.getKey(id), { baseUrl: id === 'ollama' ? prefs.ollamaUrl || undefined : undefined });
}

/** Prépare le fournisseur et les modèles réellement disponibles sur le compte. */
async function buildContext({ needVision = false, needAudio = false, progress = () => {}, signal } = {}) {
  const s = settings.prefs;
  const notes = [];
  const ai = providerFor(s.provider);
  progress({ step: 'models', message: `Vérification des modèles disponibles chez ${PROVIDERS[s.provider].label}…` });
  const corr = await resolver.resolveCorrection(ai, s.correctionModel);
  notes.push(...corr.notes);
  let vision = null;
  if (needVision) {
    progress({ step: 'models', message: 'Recherche d\'un modèle capable de lire les images…' });
    const v = await resolver.resolveVision(ai, s.visionModel, corr.main);
    vision = v.model;
    notes.push(...v.notes);
  }
  let audioAi = null;
  let audio = null;
  if (needAudio) {
    const candidates = [s.provider, 'groq', 'openai'].filter((id, i, a) => a.indexOf(id) === i && PROVIDERS[id].audio && settings.getKey(id));
    for (const id of candidates) {
      try {
        const p = providerFor(id);
        audio = await resolver.resolveAudio(p, id === s.provider ? s.audioModel : 'auto');
        if (audio) { audioAi = p; break; }
      } catch { /* suivant */ }
    }
  }
  return { ai, audioAi, models: { main: corr.main, fallbacks: corr.fallbacks, vision, audio }, s, progress, signal, notes, ocr: ocr.ocrImage };
}

const hasType = (files, t) => files.some((f) => f.parts.some((p) => p.type === t));

async function saveAndCards(out, { files, consigne, kind = 'correction', exerciseId = null, folderId = null, nameSuffix = '' }) {
  const now = new Date();
  const id = db.saveCorrection({
    name: buildName(out.result, now) + nameSuffix,
    createdAt: now.toISOString(),
    folderId,
    result: out.result,
    files,
    consigne,
    sources: out.sources,
    model: out.model,
    kind,
    exerciseId
  });
  return id;
}

/** Fiches de révision générées en arrière-plan après une correction. */
function autoFlashcards(ctx, id, result) {
  if (!settings.prefs.autoFlashcards || (!result.fautes.length && !result.a_revoir.length)) return;
  generateFlashcards({ ...ctx, progress: () => {}, notes: [] }, result)
    .then((cards) => {
      if (!cards.length) return;
      db.addFlashcards(cards, { correctionId: id, subject: result.matiere });
      send('cards:added', { correctionId: id, count: cards.length });
    })
    .catch((err) => console.warn('Fiches de révision :', err.message));
}

function scheduleSync() {
  if (!settings.get('syncDir')) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => backup.syncFolder(db, settings, app.getVersion(), { pullOthers: false }).catch((err) => send('sync:status', { error: err.message })), 5000);
}

function registerIpc() {
  // ---- Fichiers ----
  handle('files:pick', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Choisir les fichiers (énoncé, réponses, barème)', properties: ['openFile', 'multiSelections'] });
    return r.canceled ? [] : r.filePaths;
  });
  handle('files:pickFolder', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Choisir un dossier (projet, TP…)', properties: ['openDirectory'] });
    return r.canceled ? [] : r.filePaths;
  });
  handle('files:extract', (p) => extractFile(p));

  // ---- Correction ----
  const progress = (data) => send('correct:progress', data);

  handle('correct:run', async ({ files, consigne }) => {
    currentAbort = new AbortController();
    try {
      const ctx = await buildContext({ needVision: hasType(files, 'image'), needAudio: hasType(files, 'audio'), progress, signal: currentAbort.signal });
      const out = await correct(ctx, { files, consigne, runCode: runner.runCode });
      progress({ step: 'save', message: 'Enregistrement dans l\'historique…' });
      const id = await saveAndCards(out, { files: files.map((f) => ({ name: f.name, role: f.role || 'auto' })), consigne });
      autoFlashcards(ctx, id, out.result);
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
      const ctx = await buildContext({ progress, signal: currentAbort.signal });
      const out = await recorrect(ctx, { sources: rec.sources, consigne: rec.consigne, runCode: runner.runCode });
      const newId = await saveAndCards(out, { files: rec.files, consigne: rec.consigne, folderId: rec.folder_id, kind: rec.kind, exerciseId: rec.exercise_id, nameSuffix: ' (re-correction)' });
      return { id: newId, warnings: out.warnings };
    } finally {
      currentAbort = null;
    }
  });

  handle('correct:cancel', () => {
    currentAbort?.abort();
    return true;
  });

  handle('run:code', (payload) => runner.runCode(payload));

  // ---- Modèles ----
  handle('models:describe', async (providerId, force = true) => {
    const id = providerId || settings.prefs.provider;
    const p = providerFor(id);
    const d = await resolver.describe(p, { force });
    return { provider: id, ...d };
  });
  handle('models:resolve', async () => {
    const ctx = await buildContext({ needVision: true, needAudio: true });
    return { ...ctx.models, notes: ctx.notes, provider: settings.prefs.provider };
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
  handle('db:dashboard', () => db.dashboard());

  // ---- Fiches de révision ----
  handle('cards:list', (q) => db.listFlashcards(q || {}));
  handle('cards:review', (id, grade) => db.reviewFlashcard(id, grade));
  handle('cards:update', (id, patch) => db.updateFlashcard(id, patch));
  handle('cards:delete', (id) => db.deleteFlashcard(id));
  handle('cards:add', (card) => db.addFlashcards([card], { subject: card.subject }));
  handle('cards:generate', async (correctionId) => {
    const rec = db.getCorrection(correctionId);
    if (!rec) throw new Error('Correction introuvable.');
    const ctx = await buildContext({ progress });
    const cards = await generateFlashcards(ctx, rec.result);
    db.addFlashcards(cards, { correctionId, subject: rec.result.matiere });
    return cards.length;
  });

  // ---- Exercices d'entraînement ----
  handle('ex:generate', async (opts) => {
    const ctx = await buildContext({ progress });
    const ex = await generateExercise(ctx, opts);
    return db.saveExercise(ex, opts.sourceCorrectionId || null);
  });
  handle('ex:list', () => db.listExercises());
  handle('ex:get', (id) => db.getExercise(id));
  handle('ex:update', (id, patch) => db.updateExercise(id, patch));
  handle('ex:delete', (id) => db.deleteExercise(id));
  handle('ex:submit', async ({ id, answer, files = [] }) => {
    const ex = db.getExercise(id);
    if (!ex) throw new Error('Exercice introuvable.');
    const all = [
      { name: `Exercice : ${ex.title}`, role: 'enonce', parts: [{ type: 'text', text: `# ${ex.title}\n\n${ex.statement}`, label: 'Énoncé de l\'exercice d\'entraînement', generated: true }] },
      ...(answer?.trim() ? [{ name: 'Ma réponse (saisie)', role: 'reponse', parts: [{ type: 'text', text: answer, label: 'Réponse saisie dans l\'application' }] }] : []),
      ...files.map((f) => ({ ...f, role: 'reponse' }))
    ];
    currentAbort = new AbortController();
    try {
      const ctx = await buildContext({ needVision: hasType(all, 'image'), needAudio: hasType(all, 'audio'), progress, signal: currentAbort.signal });
      const out = await correct(ctx, { files: all, consigne: 'Exercice d\'entraînement généré par l\'application.', runCode: runner.runCode });
      const cid = await saveAndCards(out, { files: all.map((f) => ({ name: f.name, role: f.role })), consigne: '', kind: 'practice', exerciseId: id, nameSuffix: ' (entraînement)' });
      db.updateExercise(id, { doneCorrectionId: cid, draft: answer || '' });
      autoFlashcards(ctx, cid, out.result);
      return { id: cid, warnings: out.warnings };
    } finally {
      currentAbort = null;
    }
  });

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

  // ---- Sauvegarde & synchronisation ----
  handle('backup:export', async () => {
    const d = new Date().toISOString().slice(0, 10);
    const r = await dialog.showSaveDialog(win, { defaultPath: `Sauvegarde-Correcteur-${d}${backup.EXT}`, filters: [{ name: 'Sauvegarde Correcteur Intelligent', extensions: [backup.EXT.slice(1)] }] });
    if (r.canceled) return false;
    fs.writeFileSync(r.filePath, await backup.buildBackup(db, settings, app.getVersion()));
    return r.filePath;
  });
  handle('backup:import', async (mode = 'merge') => {
    const r = await dialog.showOpenDialog(win, { title: 'Importer une sauvegarde', properties: ['openFile'], filters: [{ name: 'Sauvegarde', extensions: [backup.EXT.slice(1), 'sqlite', 'zip'] }] });
    if (r.canceled) return false;
    return backup.importBackup(db, fs.readFileSync(r.filePaths[0]), { mode });
  });
  handle('sync:chooseDir', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Dossier synchronisé (OneDrive, Google Drive, Dropbox…)', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled) return settings.public();
    settings.update({ syncDir: r.filePaths[0] });
    await backup.syncFolder(db, settings, app.getVersion());
    return settings.public();
  });
  handle('sync:now', () => backup.syncFolder(db, settings, app.getVersion()));
  handle('sync:disable', () => settings.update({ syncDir: '' }));

  // ---- Téléphone (QR code) ----
  handle('phone:start', () => phone.start((file) => send('phone:file', file)));
  handle('phone:stop', () => phone.stop());

  // ---- Mises à jour ----
  handle('update:check', () => updater.check());
  handle('update:install', () => updater.installNow());
  handle('update:state', () => updater.getState());

  // ---- Paramètres ----
  handle('settings:get', () => settings.public());
  handle('settings:save', (prefs) => {
    const before = settings.public().autoUpdate;
    const out = settings.update(prefs);
    if (prefs.autoUpdate !== undefined && prefs.autoUpdate !== before) updater.setEnabled(prefs.autoUpdate);
    return out;
  });
  handle('settings:setKey', (provider, key) => {
    settings.setKey(provider, key);
    return settings.public();
  });
  handle('settings:testKey', async (provider, key) => {
    const p = createProvider(provider, String(key || settings.getKey(provider) || '').trim(), { baseUrl: provider === 'ollama' ? settings.prefs.ollamaUrl || undefined : undefined });
    const models = await p.listModels();
    return { ok: true, count: models.length };
  });
  handle('app:openExternal', (url) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
  });
  handle('app:openDataFolder', () => shell.openPath(app.getPath('userData')));
  handle('app:info', () => ({
    version: app.getVersion(),
    dataDir: app.getPath('userData'),
    installId: settings.installId,
    packaged: app.isPackaged,
    platform: process.platform
  }));
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
    resolver = new ModelResolver(settings.modelStore());
    db = await new Database(path.join(dataDir, 'corrections.sqlite'), { onChange: scheduleSync }).open();
    registerIpc();
    if (app.isPackaged) Menu.setApplicationMenu(null);
    createWindow();
    updater.init({ notify: (s) => send('update:status', s), enabled: settings.public().autoUpdate });
    // Synchronisation au démarrage (récupère les corrections faites sur les autres PC)
    if (settings.get('syncDir')) {
      backup.syncFolder(db, settings, app.getVersion()).then((s) => s && send('sync:status', s)).catch((err) => send('sync:status', { error: err.message }));
    }
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('before-quit', () => {
    phone.stop();
    runner.shutdown();
    ocr.shutdown();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
