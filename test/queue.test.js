const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { Database } = require('../src/main/db');
const { Queue } = require('../src/main/queue');
const backup = require('../src/main/backup');
const { normalizeResult } = require('../src/main/corrector');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ciq-'));
const waitFor = async (cond, ms = 5000) => {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error('délai dépassé');
    await new Promise((r) => setTimeout(r, 20));
  }
};

test('file d\'attente : traitement, échec, relance et reprise après redémarrage', async () => {
  const dir = tmpDir();
  const db = await new Database(path.join(dir, 'db.sqlite')).open();
  const events = [];
  let fail = true;
  const run = async (job, payload) => {
    if (payload.files[0].name === 'ko.txt' && fail) throw new Error('quota dépassé');
    const id = db.saveCorrection({ name: job.title, result: normalizeResult({ titre: job.title, note: { obtenue: 15, sur: 20 } }) });
    return { id, warnings: [] };
  };
  const q = new Queue({ db, dataDir: dir, run, notify: (e) => events.push(e) });
  q.enqueue({ title: 'Copie A', files: [{ name: 'a.txt', parts: [] }] });
  q.enqueue({ title: 'Copie B', files: [{ name: 'ko.txt', parts: [] }] });
  await waitFor(() => db.listJobs().every((j) => ['done', 'error'].includes(j.status)));
  const jobs = db.listJobs();
  assert.equal(jobs.find((j) => j.title === 'Copie A').status, 'done');
  assert.equal(jobs.find((j) => j.title === 'Copie A').grade, 15);
  const b = jobs.find((j) => j.title === 'Copie B');
  assert.equal(b.status, 'error');
  assert.match(b.error, /quota/);
  assert.ok(events.some((e) => e.done) && events.some((e) => e.failed));
  fail = false;
  q.retry(b.id);
  await waitFor(() => db.getJob(b.id).status === 'done');
  // Reprise : une tâche « en cours » au moment de la fermeture redevient « en attente »
  const id = db.addJob({ title: 'Interrompue', payloadFile: 'x.json' });
  db.updateJob(id, { status: 'running' });
  db.resumeJobs();
  assert.equal(db.getJob(id).status, 'pending');
});

test('réinitialisation précédée d\'une sauvegarde automatique restaurable', async () => {
  const dir = tmpDir();
  const db = await new Database(path.join(dir, 'db.sqlite')).open();
  const id = db.saveCorrection({ name: 'Ma correction', result: normalizeResult({ titre: 'T' }) });
  db.addChat(id, 'user', 'Pourquoi ?');
  db.addFlashcards([{ front: 'Q', back: 'R' }], { correctionId: id });
  const settings = { installId: 'abcdef12-0000', get: () => null, set: () => {} };
  await backup.autoBackup(db, settings, '1.2.0', dir, 'avant-reinitialisation');
  db.resetAll();
  assert.equal(db.listCorrections().length, 0);
  assert.equal(db.listFlashcards().length, 0);
  const list = backup.listAutoBackups(dir);
  assert.equal(list.length, 1);
  assert.equal(list[0].reason, 'avant-reinitialisation');
  await backup.importBackup(db, fs.readFileSync(list[0].path), { mode: 'replace', dataDir: dir });
  assert.equal(db.listCorrections()[0].name, 'Ma correction');
  assert.equal(db.listChat(db.listCorrections()[0].id).length, 1);
  // Rotation : 10 sauvegardes maximum
  for (let i = 0; i < 12; i++) {
    fs.writeFileSync(path.join(dir, 'backups', `2026-01-${String(i + 1).padStart(2, '0')}-00-00_auto_v1${backup.EXT}`), 'x');
  }
  await backup.autoBackup(db, settings, '1.2.0', dir, 'quotidienne');
  assert.equal(backup.listAutoBackups(dir).length, 10);
});
