'use strict';
/**
 * Sauvegarde, restauration et synchronisation (optionnelle) via un dossier cloud
 * (OneDrive, Google Drive pour ordinateur, Dropbox…). Les clés API ne sont JAMAIS exportées.
 */
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

const EXT = '.correcteur';

/** Ajoute à l'archive les images des pages de copie référencées par les corrections. */
function addPages(zip, db, dataDir) {
  if (!dataDir) return;
  for (const row of db.all('SELECT pages FROM corrections WHERE pages IS NOT NULL')) {
    for (const p of JSON.parse(row.pages || '[]')) {
      const full = path.join(dataDir, p.img);
      if (p.img && fs.existsSync(full)) zip.file(p.img, fs.readFileSync(full), { compression: 'STORE' });
    }
  }
}

async function buildBackup(db, settings, appVersion, { dataDir, withPages = true } = {}) {
  const zip = new JSZip();
  const meta = {
    format: 'correcteur-intelligent-backup',
    version: 2,
    appVersion,
    installId: settings.installId,
    createdAt: new Date().toISOString()
  };
  zip.file('meta.json', JSON.stringify(meta, null, 2));
  zip.file('data.json', JSON.stringify(db.exportAll()));
  zip.file('corrections.sqlite', db.rawExport());
  if (withPages) addPages(zip, db, dataDir);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

async function readBackup(buffer) {
  // Ancien format : fichier .sqlite brut
  if (buffer.subarray(0, 15).toString() === 'SQLite format 3') return { meta: { format: 'sqlite' }, sqlite: buffer };
  const zip = await JSZip.loadAsync(buffer);
  const meta = JSON.parse(await zip.file('meta.json').async('string'));
  if (meta.format !== 'correcteur-intelligent-backup') throw new Error('Ce fichier n\'est pas une sauvegarde du Correcteur Intelligent.');
  const data = JSON.parse(await zip.file('data.json').async('string'));
  const sqlite = zip.file('corrections.sqlite') ? await zip.file('corrections.sqlite').async('nodebuffer') : null;
  return { meta, data, sqlite, zip };
}

/** Fusionne (par défaut) ou remplace la base locale par le contenu d'une sauvegarde. */
async function importBackup(db, buffer, { mode = 'merge', dataDir } = {}) {
  const b = await readBackup(buffer);
  // Images des pages de copie : restaurées si absentes
  if (b.zip && dataDir) {
    for (const name of Object.keys(b.zip.files).filter((n) => /^pages\/[\w-]+\/\d+\.jpg$/.test(n))) {
      const target = path.join(dataDir, name);
      if (fs.existsSync(target)) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, await b.zip.file(name).async('nodebuffer'));
    }
  }
  if (mode === 'replace' && b.sqlite) {
    db.replaceWith(b.sqlite);
    db.persist();
    return { replaced: true };
  }
  let data = b.data;
  if (!data && b.sqlite) {
    const { Database } = require('./db');
    const tmp = new Database(null);
    await tmp.open();
    tmp.replaceWith(b.sqlite);
    data = tmp.exportAll();
  }
  const stats = db.mergeAll(data);
  db.persist();
  return stats;
}

function syncFileName(installId) {
  return `Correcteur-Intelligent-${installId.slice(0, 8)}${EXT}`;
}

/**
 * Synchronisation par dossier partagé :
 *  - écrit la sauvegarde de CETTE installation dans le dossier ;
 *  - fusionne les sauvegardes des AUTRES installations (autres PC) présentes dans le dossier.
 */
const AUTO_KEEP = 10;

/**
 * Sauvegarde automatique locale (<données>/backups) : au démarrage (1 fois par jour), avant une mise à jour
 * et avant une réinitialisation. Les 10 plus récentes sont conservées.
 */
async function autoBackup(db, settings, appVersion, dataDir, reason = 'auto') {
  const dir = path.join(dataDir, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const file = path.join(dir, `${stamp}_${reason}_v${appVersion}${EXT}`);
  fs.writeFileSync(file, await buildBackup(db, settings, appVersion, { dataDir, withPages: false }));
  const all = fs.readdirSync(dir).filter((f) => f.endsWith(EXT)).sort();
  for (const old of all.slice(0, Math.max(0, all.length - AUTO_KEEP))) fs.rmSync(path.join(dir, old), { force: true });
  return file;
}

function listAutoBackups(dataDir) {
  const dir = path.join(dataDir, 'backups');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(EXT)).sort().reverse().map((f) => {
    const st = fs.statSync(path.join(dir, f));
    const [, reason = 'auto', version = ''] = f.replace(EXT, '').split('_');
    return { file: f, path: path.join(dir, f), date: st.mtime.toISOString(), size: st.size, reason, version: version.replace(/^v/, '') };
  });
}

async function syncFolder(db, settings, appVersion, { pullOthers = true, dataDir } = {}) {
  const dir = settings.get('syncDir');
  if (!dir) return null;
  if (!fs.existsSync(dir)) throw new Error(`Dossier de synchronisation introuvable : ${dir}`);
  const stats = { imported: 0, files: 0 };
  if (pullOthers) {
    const mine = syncFileName(settings.installId);
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(EXT) || f === mine) continue;
      try {
        const s = await importBackup(db, fs.readFileSync(path.join(dir, f)), { mode: 'merge', dataDir });
        stats.files++;
        stats.imported += (s.corrections || 0) + (s.flashcards || 0) + (s.exercises || 0) + (s.folders || 0) + (s.updated || 0);
      } catch (err) {
        console.warn('Synchro : fichier ignoré', f, err.message);
      }
    }
  }
  const buf = await buildBackup(db, settings, appVersion, { dataDir });
  const target = path.join(dir, syncFileName(settings.installId));
  fs.writeFileSync(target + '.tmp', buf);
  fs.renameSync(target + '.tmp', target);
  settings.set('lastSyncAt', new Date().toISOString());
  return stats;
}

module.exports = { buildBackup, readBackup, importBackup, syncFolder, autoBackup, listAutoBackups, EXT };
