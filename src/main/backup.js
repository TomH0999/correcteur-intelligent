'use strict';
/**
 * Sauvegarde, restauration et synchronisation (optionnelle) via un dossier cloud
 * (OneDrive, Google Drive pour ordinateur, Dropbox…). Les clés API ne sont JAMAIS exportées.
 */
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

const EXT = '.correcteur';

async function buildBackup(db, settings, appVersion) {
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
  return { meta, data, sqlite };
}

/** Fusionne (par défaut) ou remplace la base locale par le contenu d'une sauvegarde. */
async function importBackup(db, buffer, { mode = 'merge' } = {}) {
  const b = await readBackup(buffer);
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
async function syncFolder(db, settings, appVersion, { pullOthers = true } = {}) {
  const dir = settings.get('syncDir');
  if (!dir) return null;
  if (!fs.existsSync(dir)) throw new Error(`Dossier de synchronisation introuvable : ${dir}`);
  const stats = { imported: 0, files: 0 };
  if (pullOthers) {
    const mine = syncFileName(settings.installId);
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(EXT) || f === mine) continue;
      try {
        const s = await importBackup(db, fs.readFileSync(path.join(dir, f)), { mode: 'merge' });
        stats.files++;
        stats.imported += (s.corrections || 0) + (s.flashcards || 0) + (s.exercises || 0) + (s.folders || 0) + (s.updated || 0);
      } catch (err) {
        console.warn('Synchro : fichier ignoré', f, err.message);
      }
    }
  }
  const buf = await buildBackup(db, settings, appVersion);
  const target = path.join(dir, syncFileName(settings.installId));
  fs.writeFileSync(target + '.tmp', buf);
  fs.renameSync(target + '.tmp', target);
  settings.set('lastSyncAt', new Date().toISOString());
  return stats;
}

module.exports = { buildBackup, readBackup, importBackup, syncFolder, EXT };
