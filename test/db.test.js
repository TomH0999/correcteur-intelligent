const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { Database } = require('../src/main/db');
const { normalizeResult } = require('../src/main/corrector');

test('dossiers, enregistrement, recherche sans accents, persistance', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ci-')), 'db.sqlite');
  const db = await new Database(file).open();
  const f1 = db.createFolder('S1 — Bases de données');
  const f2 = db.createFolder('TD', f1);
  const result = normalizeResult({ titre: 'Requêtes SQL', matiere: 'R1.05', type_exercice: 'base_de_donnees', note: { obtenue: 14, sur: 20 }, mots_cles: ['jointure'] });
  const id = db.saveCorrection({ name: '[BDD] — R1.05 — Requêtes SQL — 14/20', result, files: [{ name: 'td.pdf' }], sources: [{ text: 'x' }] });
  assert.equal(db.listCorrections({ search: 'requetes jointure' }).length, 1);
  assert.equal(db.listCorrections({ search: 'python' }).length, 0);
  db.updateCorrection(id, { folderId: f2 });
  assert.equal(db.listCorrections({ folderId: f2 }).length, 1);
  assert.throws(() => db.moveFolder(f1, f2));
  db.deleteFolder(f1);
  assert.equal(db.listFolders().length, 0);
  assert.equal(db.getCorrection(id).folder_id, null); // reste dans l'historique
  const db2 = await new Database(file).open();
  assert.equal(db2.getCorrection(id).result.titre, 'Requêtes SQL');
});
