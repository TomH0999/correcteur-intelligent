'use strict';
/**
 * Cache des transcriptions d'images : une image déjà lue (pré-lecture dès l'import, nouvelle correction,
 * re-correction) n'est jamais relue. Les lectures en cours sont partagées (pas de double appel).
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

class VisionCache {
  constructor(dir, { maxFiles = 400 } = {}) {
    this.dir = dir;
    this.maxFiles = maxFiles;
    this.pending = new Map();
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch { /* lecture seule : cache en mémoire uniquement */ }
  }

  key(base64, model) {
    return crypto.createHash('sha1').update(String(model)).update('\0').update(String(base64)).digest('hex');
  }

  file(key) {
    return path.join(this.dir, `${key}.json`);
  }

  read(key) {
    try {
      const v = JSON.parse(fs.readFileSync(this.file(key), 'utf8'));
      return v && typeof v.text === 'string' ? v : null;
    } catch {
      return null;
    }
  }

  write(key, value) {
    try {
      fs.writeFileSync(this.file(key), JSON.stringify({ text: value.text, via: value.via, at: Date.now() }));
      this.prune();
    } catch { /* sans gravité */ }
  }

  prune() {
    try {
      const files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.json'));
      if (files.length <= this.maxFiles) return;
      const byAge = files.map((f) => ({ f, t: fs.statSync(path.join(this.dir, f)).mtimeMs })).sort((a, b) => a.t - b.t);
      for (const { f } of byAge.slice(0, files.length - this.maxFiles)) fs.rmSync(path.join(this.dir, f), { force: true });
    } catch { /* sans gravité */ }
  }

  /** Renvoie la transcription en cache, la lecture en cours, ou lance compute(). */
  run(key, compute) {
    const disk = this.read(key);
    if (disk) return Promise.resolve(disk);
    if (this.pending.has(key)) return this.pending.get(key);
    const p = Promise.resolve()
      .then(compute)
      .then((r) => {
        // Seules les lectures par le modèle de vision sont gardées (l'OCR de secours sera retenté)
        if (r && r.text && r.via !== 'ocr') this.write(key, r);
        this.pending.delete(key);
        return r;
      }, (err) => {
        this.pending.delete(key);
        throw err;
      });
    this.pending.set(key, p);
    return p;
  }

  clear() {
    this.pending.clear();
    try {
      fs.rmSync(this.dir, { recursive: true, force: true });
      fs.mkdirSync(this.dir, { recursive: true });
    } catch { /* sans gravité */ }
  }
}

module.exports = { VisionCache };
