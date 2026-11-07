'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, Menu, Notification } = require('electron');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// Données propres à CETTE installation : la version de développement n'utilise jamais la base de l'application installée
if (!app.isPackaged && !app.commandLine.hasSwitch('user-data-dir')) {
  app.setPath('userData', path.join(app.getPath('appData'), 'Correcteur Intelligent (dev)'));
}

const { extractFile } = require('./extractors');
const { Database } = require('./db');
const { Settings } = require('./settings');
const { correct, recorrect, buildName, generateFlashcards, generateExercise, chatAbout, locateFaultsOnImage } = require('./corrector');
const pages = require('./pages');
const { Queue } = require('./queue');
const { createProvider, PROVIDERS } = require('./providers');
const { ModelResolver } = require('./models');
const { LimitBook } = require('./limits');
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
let book;
let queue;
let dataDir;
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
  return createProvider(id, settings.getKey(id), { book, baseUrl: id === 'ollama' ? prefs.ollamaUrl || undefined : undefined });
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
  return { ai, audioAi, models: { main: corr.main, fallbacks: corr.fallbacks, vision, audio }, limits: (model) => book.limits(s.provider, model), s, progress, signal, notes, ocr: ocr.ocrImage };
}

const hasType = (files, t) => files.some((f) => f.parts.some((p) => p.type === t));

async function saveAndCards(out, { files, consigne, kind = 'correction', exerciseId = null, folderId = null, nameSuffix = '', previews = [], pagesList = null }) {
  const now = new Date();
  const uuid = crypto.randomUUID();
  // Aperçus des pages de la copie (pour l'affichage annoté), enregistrés sur le disque
  let savedPages = pagesList;
  if (!savedPages) {
    try {
      savedPages = pages.savePages(dataDir, uuid, previews);
    } catch (err) {
      console.warn('Pages :', err.message);
      savedPages = [];
    }
  }
  const id = db.saveCorrection({
    uuid,
    pages: savedPages,
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

/** Une correction complète (utilisée par le bouton « Corriger » et par la file d'attente). */
async function runCorrectionTask({ files, consigne = '', previews = [], folderId = null }, { progress, signal }) {
  const ctx = await buildContext({ needVision: hasType(files, 'image'), needAudio: hasType(files, 'audio'), progress, signal });
  const out = await correct(ctx, { files, consigne, runCode: runner.runCode });
  progress({ step: 'save', message: 'Enregistrement dans l\'historique…' });
  const id = await saveAndCards(out, { files: files.map((f) => ({ name: f.name, role: f.role || 'auto' })), consigne, previews, folderId });
  autoFlashcards(ctx, id, out.result);
  return { id, warnings: out.warnings };
}

function notifyDesktop(title, body, onClick) {
  try {
    if (!Notification.isSupported() || win?.isFocused()) return;
    const n = new Notification({ title, body, icon: path.join(__dirname, '..', '..', 'build', 'icon.png') });
    n.on('click', () => {
      win?.show();
      win?.focus();
      onClick?.();
    });
    n.show();
  } catch { /* ignore */ }
}

function scheduleSync() {
  if (!settings.get('syncDir')) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => backup.syncFolder(db, settings, app.getVersion(), { pullOthers: false, dataDir }).catch((err) => send('sync:status', { error: err.message })), 5000);
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

  handle('correct:run', async ({ files, consigne, previews }) => {
    currentAbort = new AbortController();
    try {
      return await runCorrectionTask({ files, consigne, previews }, { progress, signal: currentAbort.signal });
    } finally {
      currentAbort = null;
    }
  });

  // ---- File d'attente ----
  handle('queue:add', (jobs) => jobs.map((j) => queue.enqueue(j)));
  handle('queue:list', () => queue.list());
  handle('queue:cancel', (id) => queue.cancel(id));
  handle('queue:retry', (id) => queue.retry(id));
  handle('queue:remove', (id) => queue.remove(id));
  handle('queue:clear', () => queue.clearFinished());
  handle('queue:pause', (p) => queue.setPaused(p));

  // ---- Discussion avec l'IA ----
  handle('chat:list', (correctionId) => db.listChat(correctionId));
  handle('chat:clear', (correctionId) => db.clearChat(correctionId));
  handle('chat:send', async (correctionId, text) => {
    const rec = db.getCorrection(correctionId);
    if (!rec) throw new Error('Correction introuvable.');
    const question = String(text || '').trim();
    if (!question) throw new Error('Message vide.');
    const history = db.listChat(correctionId);
    db.addChat(correctionId, 'user', question);
    try {
      const ctx = await buildContext({ progress: (p) => send('chat:progress', { correctionId, message: p.message }) });
      const r = await chatAbout(ctx, rec, history, question);
      db.addChat(correctionId, 'assistant', r.content, r.model);
    } catch (err) {
      db.addChat(correctionId, 'error', `Réponse impossible : ${err.message}`);
    }
    return db.listChat(correctionId);
  });

  // ---- Copie annotée ----
  handle('page:read', (rel) => `data:image/jpeg;base64,${pages.readPage(dataDir, rel)}`);
  handle('annotate:locate', async (correctionId) => {
    const rec = db.getCorrection(correctionId);
    if (!rec) throw new Error('Correction introuvable.');
    const fautes = rec.result.fautes;
    if (!fautes.length) return [];
    const answerFiles = new Set(rec.result.identification?.reponses || []);
    // Pages sans texte exploitable (photos, scans) : localisation par le modèle de vision
    const targets = rec.pages.filter((p) => !p.items?.length && (!answerFiles.size || answerFiles.has(p.file) || [...answerFiles].some((f) => p.label.includes(f))));
    if (!targets.length) return rec.annotations || [];
    const ctx = await buildContext({ needVision: true, progress: (p) => send('annotate:progress', { correctionId, message: p.message }) });
    const out = (rec.annotations || []).filter((a) => !targets.some((t) => t.id === a.page));
    for (const [i, pg] of targets.entries()) {
      send('annotate:progress', { correctionId, message: `Localisation des fautes sur la page ${i + 1}/${targets.length}…` });
      try {
        const found = await locateFaultsOnImage(ctx, pages.readPage(dataDir, pg.img), fautes);
        for (const a of found) out.push({ page: pg.id, faute: a.faute, boxes: a.boxes, source: 'vision' });
      } catch (err) {
        if (err.status === 401) throw err;
        send('annotate:progress', { correctionId, message: `Page ${i + 1} : ${err.message}` });
      }
    }
    db.setAnnotations(correctionId, out);
    return out;
  });

  handle('correct:rerun', async (id) => {
    const rec = db.getCorrection(id);
    if (!rec) throw new Error('Correction introuvable.');
    currentAbort = new AbortController();
    try {
      const ctx = await buildContext({ progress, signal: currentAbort.signal });
      const out = await recorrect(ctx, { sources: rec.sources, consigne: rec.consigne, runCode: runner.runCode });
      const newId = await saveAndCards(out, { files: rec.files, consigne: rec.consigne, folderId: rec.folder_id, kind: rec.kind, exerciseId: rec.exercise_id, nameSuffix: ' (re-correction)', pagesList: rec.pages });
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
  handle('db:delete', (id) => {
    const rec = db.getCorrection(id);
    db.deleteCorrection(id);
    // Images de la copie supprimées si plus aucune correction ne les utilise (re-corrections)
    const dir = rec?.pages?.[0]?.img?.split('/')[1];
    if (dir && !db.get('SELECT id FROM corrections WHERE pages LIKE ?', [`%pages/${dir}/%`])) pages.deletePages(dataDir, dir);
  });
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
  handle('ex:submit', async ({ id, answer, files = [], previews = [] }) => {
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
      const cid = await saveAndCards(out, { files: all.map((f) => ({ name: f.name, role: f.role })), consigne: '', kind: 'practice', exerciseId: id, nameSuffix: ' (entraînement)', previews });
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
    fs.writeFileSync(r.filePath, await backup.buildBackup(db, settings, app.getVersion(), { dataDir }));
    return r.filePath;
  });
  handle('backup:import', async (mode = 'merge') => {
    const r = await dialog.showOpenDialog(win, { title: 'Importer une sauvegarde', properties: ['openFile'], filters: [{ name: 'Sauvegarde', extensions: [backup.EXT.slice(1), 'sqlite', 'zip'] }] });
    if (r.canceled) return false;
    if (mode === 'replace') await backup.autoBackup(db, settings, app.getVersion(), dataDir, 'avant-restauration');
    return backup.importBackup(db, fs.readFileSync(r.filePaths[0]), { mode, dataDir });
  });
  handle('backup:listAuto', () => backup.listAutoBackups(dataDir));
  handle('backup:restoreAuto', async (file) => {
    const item = backup.listAutoBackups(dataDir).find((b) => b.file === file);
    if (!item) throw new Error('Sauvegarde introuvable.');
    await backup.autoBackup(db, settings, app.getVersion(), dataDir, 'avant-restauration');
    return backup.importBackup(db, fs.readFileSync(item.path), { mode: 'replace', dataDir });
  });
  handle('backup:openDir', () => shell.openPath(path.join(dataDir, 'backups')));

  // ---- Réinitialisation (avec sauvegarde automatique préalable) ----
  handle('app:reset', async ({ data = true, prefs = false, keys = false } = {}) => {
    const saved = await backup.autoBackup(db, settings, app.getVersion(), dataDir, 'avant-reinitialisation');
    if (data) {
      currentAbort?.abort();
      queue.setPaused(true);
      for (const f of db.listJobs()) queue.remove(f.id);
      db.resetAll();
      fs.rmSync(path.join(dataDir, 'pages'), { recursive: true, force: true });
      queue.setPaused(false);
    }
    settings.reset({ prefs, keys });
    return { backup: saved, settings: settings.public() };
  });
  handle('sync:chooseDir', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Dossier synchronisé (OneDrive, Google Drive, Dropbox…)', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled) return settings.public();
    settings.update({ syncDir: r.filePaths[0] });
    await backup.syncFolder(db, settings, app.getVersion(), { dataDir });
    return settings.public();
  });
  handle('sync:now', () => backup.syncFolder(db, settings, app.getVersion(), { dataDir }));
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
    const p = createProvider(provider, String(key || settings.getKey(provider) || '').trim(), { book, baseUrl: provider === 'ollama' ? settings.prefs.ollamaUrl || undefined : undefined });
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

  if (process.platform === 'win32') app.setAppUserModelId('fr.tomh0999.correcteur-intelligent');
  app.whenReady().then(async () => {
    dataDir = app.getPath('userData');
    settings = new Settings(path.join(dataDir, 'settings.json'), safeStorage);
    resolver = new ModelResolver(settings.modelStore());
    book = new LimitBook(settings.limitStore());
    db = await new Database(path.join(dataDir, 'corrections.sqlite'), { onChange: scheduleSync }).open();
    registerIpc();
    if (app.isPackaged) Menu.setApplicationMenu(null);
    createWindow();
    updater.init({
      notify: (s) => send('update:status', s),
      enabled: settings.public().autoUpdate,
      onBeforeInstall: () => backup.autoBackup(db, settings, app.getVersion(), dataDir, 'avant-mise-a-jour')
    });
    // Sauvegarde automatique quotidienne (protège les données en cas de problème)
    const today = new Date().toISOString().slice(0, 10);
    if (settings.get('lastAutoBackup') !== today && db.stats().total) {
      backup.autoBackup(db, settings, app.getVersion(), dataDir, 'quotidienne').then(() => settings.set('lastAutoBackup', today)).catch((err) => console.warn('Sauvegarde auto :', err.message));
    }
    // File d'attente : reprise des corrections interrompues
    queue = new Queue({
      db,
      dataDir,
      isBusy: () => !!currentAbort,
      run: (job, payload, opts) => runCorrectionTask({ ...payload, folderId: job.folder_id }, opts),
      notify: (ev) => {
        send('queue:update', ev);
        if (ev.done) notifyDesktop('Correction terminée', ev.done.title, () => send('nav:result', ev.done.correctionId));
        if (ev.failed) notifyDesktop('Correction en échec', `${ev.failed.title} : ${ev.failed.error}`);
      }
    });
    queue.resume();
    // Synchronisation au démarrage (récupère les corrections faites sur les autres PC)
    if (settings.get('syncDir')) {
      backup.syncFolder(db, settings, app.getVersion(), { dataDir }).then((s) => s && send('sync:status', s)).catch((err) => send('sync:status', { error: err.message }));
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
