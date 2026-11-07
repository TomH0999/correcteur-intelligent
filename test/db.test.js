const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');
const { Database } = require('../src/main/db');
const { normalizeResult } = require('../src/main/corrector');
const backup = require('../src/main/backup');

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ci-')), 'db.sqlite');

test('dossiers, enregistrement, recherche sans accents, persistance', async () => {
  const file = tmp();
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
  assert.equal(db.getCorrection(id).folder_id, null);
  const db2 = await new Database(file).open();
  assert.equal(db2.getCorrection(id).result.titre, 'Requêtes SQL');
});

test('migration d\'une base v1.0 (sans uuid) sans perte', async () => {
  const SQL = await initSqlJs({ wasmBinary: fs.readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm')) });
  const old = new SQL.Database();
  old.run(`CREATE TABLE folders (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, parent_id INTEGER, color TEXT, created_at TEXT NOT NULL);
    CREATE TABLE corrections (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, folder_id INTEGER, created_at TEXT NOT NULL, subject TEXT, exercise_type TEXT, score REAL, grade REAL, grade_max REAL, files TEXT, consigne TEXT, result TEXT NOT NULL, sources TEXT, model TEXT, search_text TEXT);
    INSERT INTO corrections (name, created_at, result, score) VALUES ('ancienne', '2026-11-01T10:00:00Z', '{"titre":"x"}', 50);`);
  const file = tmp();
  fs.writeFileSync(file, Buffer.from(old.export()));
  const db = await new Database(file).open();
  const c = db.listCorrections()[0];
  assert.equal(c.name, 'ancienne');
  assert.ok(c.uuid);
});

test('fiches de révision : répétition espacée', async () => {
  const db = await new Database(tmp()).open();
  db.addFlashcards([{ front: 'Q', back: 'R', notion: 'jointures' }]);
  const [card] = db.listFlashcards({ dueOnly: true });
  const t0 = new Date('2026-11-07T10:00:00Z');
  let c = db.reviewFlashcard(card.id, 'good', t0);
  assert.equal(c.box, 1);
  assert.equal(c.due_at, new Date(t0.getTime() + 86400000).toISOString());
  c = db.reviewFlashcard(card.id, 'easy', t0);
  assert.equal(c.box, 3);
  c = db.reviewFlashcard(card.id, 'again', t0);
  assert.equal(c.box, 1);
  assert.equal(c.lapses, 1);
});

test('sauvegarde puis fusion sur une autre installation, sans doublon', async () => {
  const a = await new Database(tmp()).open();
  const f = a.createFolder('Maths');
  const result = normalizeResult({ titre: 'Dérivées', matiere: 'Maths', note: { obtenue: 12, sur: 20 }, fautes: [{ notion: 'dérivée', description: 'x' }] });
  const id = a.saveCorrection({ name: 'Dérivées', result, folderId: f });
  a.addFlashcards([{ front: 'Q', back: 'R' }], { correctionId: id });
  const settings = { installId: 'aaaaaaaa-1111', get: () => null, set: () => {} };
  const buf = await backup.buildBackup(a, settings, '1.1.0');
  const b = await new Database(tmp()).open();
  b.saveCorrection({ name: 'locale', result: normalizeResult({ titre: 'Local' }) });
  const s1 = await backup.importBackup(b, buf);
  assert.equal(s1.corrections, 1);
  assert.equal(s1.flashcards, 1);
  const s2 = await backup.importBackup(b, buf);
  assert.equal(s2.corrections, 0);
  assert.equal(b.listCorrections().length, 2);
  const merged = b.listCorrections({ search: 'derivees' })[0];
  assert.equal(merged.folder_name, 'Maths');
  const dash = b.dashboard();
  assert.equal(dash.topNotions[0].notion, 'dérivée');
  assert.equal(dash.bySubject.length, 2);
});

test('exercices d\'entraînement', async () => {
  const db = await new Database(tmp()).open();
  const id = db.saveExercise({ titre: 'Jointures', matiere: 'BDD', type_exercice: 'base_de_donnees', notions: ['jointures'], enonce: '1. …', difficulte: 'moyenne' });
  db.updateExercise(id, { draft: 'SELECT …' });
  assert.equal(db.getExercise(id).draft, 'SELECT …');
  assert.deepEqual(db.listExercises()[0].notions, ['jointures']);
});

test('brouillons non comptés + réussite du premier coup et amélioration', async () => {
  const db = await new Database(tmp()).open();
  const enonce = { file: 'sujet.pdf', role: 'enonce', kind: 'pdf-page', text: 'Exercice 1 : écrire une requête SQL qui liste tous les clients de la table client.' };
  const save = (score, answer, extra = {}) => db.saveCorrection({
    name: `essai ${score}`,
    result: normalizeResult({ titre: 'TD SQL', note: { obtenue: score / 5, sur: 20 }, identification: { enonce: ['sujet.pdf'] } }),
    sources: [enonce, { file: 'copie.txt', role: 'auto', kind: 'text', text: answer }],
    ...extra
  });
  // Exercice A : raté (40 %) puis réussi (80 %), avec une re-correction de la 1re copie qui ne compte pas en plus
  const a1 = save(40, 'SELECT nom FROM client WHERE ville = 1');
  save(45, 'SELECT nom FROM client WHERE ville = 1');
  const a2 = save(80, 'SELECT nom FROM client');
  // Brouillon : ignoré partout
  save(10, 'brouillon', { counted: false });
  // Exercice B (autre énoncé) : réussi du premier coup
  db.saveCorrection({ name: 'B', result: normalizeResult({ titre: 'Maths', note: { obtenue: 15, sur: 20 } }), sources: [{ file: 'b.txt', role: 'enonce', kind: 'text', text: 'Calculer la dérivée de la fonction f définie sur R par f(x) = x au carré.' }, { file: 'r.txt', kind: 'text', role: 'reponse', text: '2x' }] });
  assert.equal(db.listCorrections().length, 4);
  assert.equal(db.listCorrections({ drafts: true }).length, 1);
  assert.equal(db.stats().drafts, 1);
  const st = db.attemptStats();
  assert.equal(st.exercises, 2);
  assert.equal(st.firstTryRate, 50);
  const sA = st.series.find((s) => s.count === 2);
  assert.equal(sA.first, 45); // la re-correction remplace la note de la 1re tentative
  assert.equal(sA.improvement, 35);
  assert.equal(st.avgImprovement, 35);
  assert.equal(st.recoveredRate, 100);
  assert.equal(db.attemptsFor(a2).index, 1);
  assert.equal(db.dashboard().timeline.length, 4);
  // Détacher puis relier
  db.updateCorrection(a2, { exerciseKey: null });
  assert.equal(db.attemptStats().exercises, 3);
  db.updateCorrection(a2, { exerciseKey: db.getCorrection(a1).exercise_key });
  assert.equal(db.attemptStats().exercises, 2);
});
