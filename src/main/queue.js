'use strict';
/**
 * File d'attente de corrections en arrière-plan.
 * Les fichiers à corriger sont enregistrés sur le disque (<données>/queue/) : si l'application est fermée,
 * les corrections en attente ou interrompues reprennent au prochain démarrage.
 * Les tâches sont traitées une par une (respect des limites de débit des fournisseurs d'IA).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class Queue {
  /**
   * @param {object} o
   * @param o.db Database
   * @param o.dataDir dossier de données
   * @param o.run async (job, payload, { progress, signal }) => { id, warnings }
   * @param o.notify (event) => void  — informe l'interface
   * @param o.isBusy () => boolean      — une correction manuelle est en cours : on attend
   */
  constructor({ db, dataDir, run, notify, isBusy }) {
    this.db = db;
    this.dir = path.join(dataDir, 'queue');
    this.run = run;
    this.notify = notify || (() => {});
    this.isBusy = isBusy || (() => false);
    this.current = null; // { id, abort }
    this.paused = false;
    fs.mkdirSync(this.dir, { recursive: true });
  }

  enqueue({ title, files, consigne = '', folderId = null }) {
    const name = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`;
    fs.writeFileSync(path.join(this.dir, name), JSON.stringify({ files, consigne }));
    const id = this.db.addJob({ title: String(title || 'Correction').slice(0, 200), payloadFile: name, consigne, folderId });
    this.emit();
    this.kick();
    return id;
  }

  list() {
    return { jobs: this.db.listJobs(), paused: this.paused, running: this.current?.id || null };
  }

  emit() {
    this.notify(this.list());
  }

  cancel(id) {
    if (this.current?.id === id) this.current.abort.abort();
    const job = this.db.getJob(id);
    if (job && ['pending', 'running'].includes(job.status)) this.db.updateJob(id, { status: 'cancelled', finished_at: new Date().toISOString(), progress: 'Annulée' });
    this.emit();
  }

  retry(id) {
    this.db.updateJob(id, { status: 'pending', error: null, progress: null });
    this.emit();
    this.kick();
  }

  remove(id) {
    if (this.current?.id === id) this.current.abort.abort();
    const job = this.db.getJob(id);
    if (job) {
      this.db.deleteJob(id);
      fs.rm(path.join(this.dir, job.payload_file), { force: true }, () => {});
    }
    this.emit();
  }

  clearFinished() {
    for (const f of this.db.clearFinishedJobs()) fs.rm(path.join(this.dir, f), { force: true }, () => {});
    this.emit();
  }

  setPaused(p) {
    this.paused = !!p;
    this.emit();
    if (!p) this.kick();
  }

  /** Reprise au démarrage. */
  resume() {
    this.db.resumeJobs();
    this.emit();
    setTimeout(() => this.kick(), 4000);
  }

  kick() {
    if (this.current || this.paused) return;
    if (this.isBusy()) {
      clearTimeout(this.waitTimer);
      this.waitTimer = setTimeout(() => this.kick(), 3000);
      return;
    }
    const job = this.db.nextJob();
    if (!job) return;
    this.process(job).finally(() => {
      this.current = null;
      this.emit();
      setTimeout(() => this.kick(), 500);
    });
  }

  async process(job) {
    const abort = new AbortController();
    this.current = { id: job.id, abort };
    this.db.updateJob(job.id, { status: 'running', started_at: new Date().toISOString(), attempts: (job.attempts || 0) + 1, progress: 'Démarrage…', error: null });
    this.emit();
    let lastSave = 0;
    const progress = (p) => {
      const now = Date.now();
      this.notify({ progress: { id: job.id, message: p.message } });
      if (now - lastSave > 1500) {
        lastSave = now;
        this.db.updateJob(job.id, { progress: p.message });
      }
    };
    try {
      const payload = JSON.parse(fs.readFileSync(path.join(this.dir, job.payload_file), 'utf8'));
      const out = await this.run(job, payload, { progress, signal: abort.signal });
      if (abort.signal.aborted) return;
      this.db.updateJob(job.id, { status: 'done', correction_id: out.id, finished_at: new Date().toISOString(), progress: out.warnings?.length ? out.warnings.join(' · ').slice(0, 500) : 'Terminée' });
      fs.rm(path.join(this.dir, job.payload_file), { force: true }, () => {});
      this.notify({ done: { id: job.id, title: job.title, correctionId: out.id } });
    } catch (err) {
      if (abort.signal.aborted) return;
      this.db.updateJob(job.id, { status: 'error', error: String(err.message || err).slice(0, 1000), finished_at: new Date().toISOString() });
      this.notify({ failed: { id: job.id, title: job.title, error: err.message } });
    }
  }
}

module.exports = { Queue };
