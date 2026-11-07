'use strict';
/**
 * Base de données locale (SQLite via sql.js / WebAssembly : aucune compilation native nécessaire).
 * Le fichier est stocké dans le dossier de données de l'utilisateur et réécrit à chaque modification.
 */
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

function normalize(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

class Database {
  constructor(file) {
    this.file = file;
    this.db = null;
  }

  async open() {
    const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
    const SQL = await initSqlJs({ wasmBinary: fs.readFileSync(wasmPath) });
    if (this.file && fs.existsSync(this.file)) {
      this.db = new SQL.Database(fs.readFileSync(this.file));
    } else {
      this.db = new SQL.Database();
    }
    this.db.run(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS folders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        parent_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,
        color TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS corrections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        subject TEXT,
        exercise_type TEXT,
        score REAL,
        grade REAL,
        grade_max REAL,
        files TEXT,
        consigne TEXT,
        result TEXT NOT NULL,
        sources TEXT,
        model TEXT,
        search_text TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_corr_folder ON corrections(folder_id);
      CREATE INDEX IF NOT EXISTS idx_corr_date ON corrections(created_at);
    `);
    this.persist();
    return this;
  }

  persist() {
    if (!this.file) return;
    const data = Buffer.from(this.db.export());
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, this.file);
  }

  all(sql, params = []) {
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }

  get(sql, params = []) {
    return this.all(sql, params)[0] || null;
  }

  run(sql, params = []) {
    this.db.run(sql, params);
    const id = this.get('SELECT last_insert_rowid() AS id').id;
    this.persist();
    return id;
  }

  // ---------- Dossiers ----------
  listFolders() {
    const folders = this.all('SELECT f.*, (SELECT COUNT(*) FROM corrections c WHERE c.folder_id = f.id) AS count FROM folders f ORDER BY name COLLATE NOCASE');
    return folders;
  }

  createFolder(name, parentId = null, color = null) {
    const clean = String(name || '').trim();
    if (!clean) throw new Error('Le nom du dossier est vide.');
    return this.run('INSERT INTO folders (name, parent_id, color, created_at) VALUES (?, ?, ?, ?)', [clean, parentId || null, color, new Date().toISOString()]);
  }

  renameFolder(id, name) {
    const clean = String(name || '').trim();
    if (!clean) throw new Error('Le nom du dossier est vide.');
    this.run('UPDATE folders SET name = ? WHERE id = ?', [clean, id]);
  }

  moveFolder(id, parentId) {
    // Empêche de déplacer un dossier dans l'un de ses descendants
    let cur = parentId;
    while (cur) {
      if (cur === id) throw new Error('Impossible de déplacer un dossier dans lui-même.');
      cur = this.get('SELECT parent_id FROM folders WHERE id = ?', [cur])?.parent_id;
    }
    this.run('UPDATE folders SET parent_id = ? WHERE id = ?', [parentId || null, id]);
  }

  /** Supprime un dossier : les corrections qu'il contient restent dans l'historique. */
  deleteFolder(id) {
    const ids = [id];
    for (let i = 0; i < ids.length; i++) {
      for (const c of this.all('SELECT id FROM folders WHERE parent_id = ?', [ids[i]])) ids.push(c.id);
    }
    const ph = ids.map(() => '?').join(',');
    this.db.run(`UPDATE corrections SET folder_id = NULL WHERE folder_id IN (${ph})`, ids);
    this.db.run(`DELETE FROM folders WHERE id IN (${ph})`, ids);
    this.persist();
  }

  // ---------- Corrections ----------
  saveCorrection(rec) {
    const r = rec.result || {};
    const searchText = normalize([
      rec.name, r.titre, r.matiere, r.type_exercice, r.langage, r.resume,
      ...(r.mots_cles || []), ...(rec.files || []).map((f) => f.name || f), rec.consigne
    ].filter(Boolean).join(' '));
    return this.run(
      `INSERT INTO corrections (name, folder_id, created_at, subject, exercise_type, score, grade, grade_max, files, consigne, result, sources, model, search_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        rec.name, rec.folderId || null, rec.createdAt || new Date().toISOString(), r.matiere || null, r.type_exercice || null,
        r.score_pourcentage ?? null, r.note?.obtenue ?? null, r.note?.sur ?? null,
        JSON.stringify(rec.files || []), rec.consigne || '', JSON.stringify(r), JSON.stringify(rec.sources || []), rec.model || null, searchText
      ]
    );
  }

  _hydrate(row) {
    if (!row) return null;
    return {
      ...row,
      files: JSON.parse(row.files || '[]'),
      result: row.result ? JSON.parse(row.result) : null,
      sources: row.sources ? JSON.parse(row.sources) : []
    };
  }

  getCorrection(id) {
    return this._hydrate(this.get('SELECT * FROM corrections WHERE id = ?', [id]));
  }

  /**
   * Liste les corrections.
   * @param {object} q { folderId: number|'none'|undefined, search, type, limit, offset }
   */
  listCorrections(q = {}) {
    const where = [];
    const params = [];
    if (q.folderId === 'none') where.push('folder_id IS NULL');
    else if (q.folderId) { where.push('folder_id = ?'); params.push(q.folderId); }
    if (q.type) { where.push('exercise_type = ?'); params.push(q.type); }
    if (q.search) {
      for (const word of normalize(q.search).split(/\s+/).filter(Boolean)) {
        where.push("(search_text LIKE ? ESCAPE '\\')");
        params.push(`%${word.replace(/[\\%_]/g, (m) => '\\' + m)}%`);
      }
    }
    const sql = `SELECT c.id, c.name, c.folder_id, c.created_at, c.subject, c.exercise_type, c.score, c.grade, c.grade_max, c.files, c.model,
                        f.name AS folder_name
                 FROM corrections c LEFT JOIN folders f ON f.id = c.folder_id
                 ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY c.created_at DESC LIMIT ? OFFSET ?`;
    params.push(q.limit || 500, q.offset || 0);
    return this.all(sql, params).map((r) => ({ ...r, files: JSON.parse(r.files || '[]') }));
  }

  updateCorrection(id, patch) {
    if (patch.name !== undefined) {
      const clean = String(patch.name).trim();
      if (!clean) throw new Error('Le nom est vide.');
      const row = this.getCorrection(id);
      const rest = row.search_text || '';
      this.db.run('UPDATE corrections SET name = ?, search_text = ? WHERE id = ?', [clean, normalize(clean) + ' ' + rest, id]);
    }
    if (patch.folderId !== undefined) this.db.run('UPDATE corrections SET folder_id = ? WHERE id = ?', [patch.folderId || null, id]);
    this.persist();
    return this.getCorrection(id);
  }

  deleteCorrection(id) {
    this.run('DELETE FROM corrections WHERE id = ?', [id]);
  }

  stats() {
    return this.get(`SELECT COUNT(*) AS total, ROUND(AVG(score), 1) AS avg_score,
                     SUM(CASE WHEN folder_id IS NOT NULL THEN 1 ELSE 0 END) AS filed FROM corrections`);
  }
}

module.exports = { Database, normalize };
