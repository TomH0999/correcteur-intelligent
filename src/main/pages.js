'use strict';
/**
 * Pages de la copie (aperçus JPEG) conservées avec chaque correction pour l'affichage annoté.
 * Stockées dans <données>/pages/<uuid de la correction>/ — jamais supprimées par une mise à jour.
 */
const fs = require('fs');
const path = require('path');

const MAX_PAGES = 60;

/**
 * @param previews [{ file, label, base64, w, h, items? }]  items : [[texte, x, y, l, h]] (coordonnées 0–1)
 * @returns pages [{ id, file, label, img (chemin relatif), w, h, items }]
 */
function savePages(dataDir, uuid, previews = []) {
  if (!previews.length) return [];
  const rel = path.join('pages', uuid);
  const dir = path.join(dataDir, rel);
  fs.mkdirSync(dir, { recursive: true });
  return previews.slice(0, MAX_PAGES).map((p, i) => {
    const name = `${String(i + 1).padStart(3, '0')}.jpg`;
    fs.writeFileSync(path.join(dir, name), Buffer.from(p.base64, 'base64'));
    return { id: i + 1, file: p.file, label: p.label, img: `${rel.split(path.sep).join('/')}/${name}`, w: p.w, h: p.h, items: p.items || null };
  });
}

function readPage(dataDir, rel) {
  const full = path.resolve(dataDir, rel);
  if (!full.startsWith(path.resolve(dataDir, 'pages'))) throw new Error('Chemin invalide.');
  return fs.readFileSync(full).toString('base64');
}

function deletePages(dataDir, uuid) {
  if (!uuid || /[\\/]/.test(uuid)) return;
  fs.rm(path.join(dataDir, 'pages', uuid), { recursive: true, force: true }, () => {});
}

module.exports = { savePages, readPage, deletePages, MAX_PAGES };
