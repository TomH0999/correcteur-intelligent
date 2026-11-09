'use strict';
/**
 * Base de données LOCALE de cette installation (SQLite via sql.js / WebAssembly).
 * Le fichier est stocké dans le dossier de données de l'utilisateur Windows (%APPDATA%) :
 * chaque installation a sa propre base, rien n'est partagé sans action explicite (sauvegarde / synchro).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const initSqlJs = require('sql.js');

const SCHEMA_VERSION = 4;
// Une copie est « réussie » à partir de 50 % (10/20)
const SUCCESS_THRESHOLD = 50;
// Intervalles de révision (jours) par boîte de Leitner
const BOX_DAYS = [0, 1, 2, 4, 8, 16, 32, 64];

function normalize(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

class Database {
  constructor(file, { onChange } = {}) {
    this.file = file;
    this.db = null;
    this.onChange = onChange;
  }

  async open() {
    const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
    const SQL = await initSqlJs({ wasmBinary: fs.readFileSync(wasmPath) });
    this.SQL = SQL;
    if (this.file && fs.existsSync(this.file)) {
      this.db = new SQL.Database(fs.readFileSync(this.file));
    } else {
      this.db = new SQL.Database();
    }
    this.migrate();
    this.persist(true);
    return this;
  }

  columns(table) {
    return this.all(`PRAGMA table_info(${table})`).map((c) => c.name);
  }

  migrate() {
    this.x(`
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
      CREATE TABLE IF NOT EXISTS flashcards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid TEXT UNIQUE,
        correction_id INTEGER REFERENCES corrections(id) ON DELETE SET NULL,
        front TEXT NOT NULL,
        back TEXT NOT NULL,
        notion TEXT,
        subject TEXT,
        box INTEGER NOT NULL DEFAULT 0,
        due_at TEXT NOT NULL,
        last_review TEXT,
        reviews INTEGER NOT NULL DEFAULT 0,
        lapses INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT
      );
      CREATE TABLE IF NOT EXISTS exercises (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid TEXT UNIQUE,
        title TEXT NOT NULL,
        subject TEXT,
        exercise_type TEXT,
        language TEXT,
        notions TEXT,
        statement TEXT NOT NULL,
        answer_format TEXT,
        difficulty TEXT,
        source_correction_id INTEGER REFERENCES corrections(id) ON DELETE SET NULL,
        done_correction_id INTEGER REFERENCES corrections(id) ON DELETE SET NULL,
        draft TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT
      );
    `);
    // v1 -> v2 : identifiants universels (fusion des sauvegardes), type de correction, date de modification
    const add = (table, col, def) => {
      if (!this.columns(table).includes(col)) this.x(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
    };
    add('folders', 'uuid', 'TEXT');
    add('folders', 'updated_at', 'TEXT');
    add('corrections', 'uuid', 'TEXT');
    add('corrections', 'kind', "TEXT DEFAULT 'correction'");
    add('corrections', 'exercise_id', 'INTEGER');
    add('corrections', 'updated_at', 'TEXT');
    // v3 : pages de la copie (annotations), discussion avec l'IA, file d'attente
    add('corrections', 'pages', 'TEXT');
    add('corrections', 'annotations', 'TEXT');
    // v4 : brouillons (non comptés) et regroupement des tentatives d'un même exercice
    add('corrections', 'counted', 'INTEGER NOT NULL DEFAULT 1');
    add('corrections', 'exercise_key', 'TEXT');
    add('corrections', 'answer_hash', 'TEXT');
    // v5 : corrections faites dans Claude (lien de la conversation, fichiers joints, type d'évaluation)
    add('corrections', 'origin', "TEXT DEFAULT 'api'");
    add('corrections', 'claude_url', 'TEXT');
    add('corrections', 'attachments', 'TEXT');
    add('corrections', 'eval_type', 'TEXT');
    this.x(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid TEXT UNIQUE,
        correction_id INTEGER NOT NULL REFERENCES corrections(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        model TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chat_corr ON chat_messages(correction_id);
      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        payload_file TEXT NOT NULL,
        consigne TEXT,
        folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
        correction_id INTEGER REFERENCES corrections(id) ON DELETE SET NULL,
        error TEXT,
        progress TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );
    `);
    for (const t of ['folders', 'corrections', 'flashcards', 'exercises', 'chat_messages']) {
      for (const r of this.all(`SELECT id FROM ${t} WHERE uuid IS NULL`)) this.x(`UPDATE ${t} SET uuid = ? WHERE id = ?`, [uuid(), r.id]);
    }
    this.x(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_uuid ON folders(uuid);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_corr_uuid ON corrections(uuid);
      CREATE INDEX IF NOT EXISTS idx_corr_folder ON corrections(folder_id);
      CREATE INDEX IF NOT EXISTS idx_corr_date ON corrections(created_at);
      CREATE INDEX IF NOT EXISTS idx_cards_due ON flashcards(due_at);
      CREATE INDEX IF NOT EXISTS idx_corr_key ON corrections(exercise_key);
    `);
    // Empreintes des corrections existantes (tentatives regroupées automatiquement)
    for (const r of this.all('SELECT id, result, sources, exercise_id FROM corrections WHERE exercise_key IS NULL')) {
      try {
        const ex = r.exercise_id ? this.get('SELECT uuid FROM exercises WHERE id = ?', [r.exercise_id]) : null;
        const fp = Database.fingerprints({ result: JSON.parse(r.result || '{}'), sources: JSON.parse(r.sources || '[]'), exerciseUuid: ex?.uuid });
        this.x('UPDATE corrections SET exercise_key = ?, answer_hash = ? WHERE id = ?', [fp.exerciseKey, fp.answerHash, r.id]);
      } catch { /* ignore */ }
    }
    this.x(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  persist(silent = false) {
    if (!this.file) return;
    const data = Buffer.from(this.db.export());
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, this.file);
    if (!silent) this.onChange?.();
  }

  /** sql.js refuse « undefined » : on le convertit en NULL. */
  x(sql, params) {
    this.db.run(sql, params ? params.map((v) => (v === undefined ? null : v)) : undefined);
  }

  all(sql, params = []) {
    const stmt = this.db.prepare(sql);
    stmt.bind(params.map((v) => (v === undefined ? null : v)));
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }

  get(sql, params = []) {
    return this.all(sql, params)[0] || null;
  }

  run(sql, params = []) {
    this.x(sql, params);
    const id = this.get('SELECT last_insert_rowid() AS id').id;
    this.persist();
    return id;
  }

  // ---------- Dossiers ----------
  listFolders() {
    return this.all('SELECT f.*, (SELECT COUNT(*) FROM corrections c WHERE c.folder_id = f.id) AS count FROM folders f ORDER BY name COLLATE NOCASE');
  }

  createFolder(name, parentId = null, color = null) {
    const clean = String(name || '').trim();
    if (!clean) throw new Error('Le nom du dossier est vide.');
    return this.run('INSERT INTO folders (name, parent_id, color, created_at, uuid, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [clean, parentId || null, color, now(), uuid(), now()]);
  }

  renameFolder(id, name) {
    const clean = String(name || '').trim();
    if (!clean) throw new Error('Le nom du dossier est vide.');
    this.run('UPDATE folders SET name = ?, updated_at = ? WHERE id = ?', [clean, now(), id]);
  }

  moveFolder(id, parentId) {
    let cur = parentId;
    while (cur) {
      if (cur === id) throw new Error('Impossible de déplacer un dossier dans lui-même.');
      cur = this.get('SELECT parent_id FROM folders WHERE id = ?', [cur])?.parent_id;
    }
    this.run('UPDATE folders SET parent_id = ?, updated_at = ? WHERE id = ?', [parentId || null, now(), id]);
  }

  /** Supprime un dossier : les corrections qu'il contient restent dans l'historique. */
  deleteFolder(id) {
    const ids = [id];
    for (let i = 0; i < ids.length; i++) {
      for (const c of this.all('SELECT id FROM folders WHERE parent_id = ?', [ids[i]])) ids.push(c.id);
    }
    const ph = ids.map(() => '?').join(',');
    this.x(`UPDATE corrections SET folder_id = NULL WHERE folder_id IN (${ph})`, ids);
    this.x(`DELETE FROM folders WHERE id IN (${ph})`, ids);
    this.persist();
  }

  // ---------- Corrections ----------
  static searchText(rec, r) {
    return normalize([
      rec.name, r.titre, r.matiere, r.type_exercice, r.langage, r.resume,
      ...(r.mots_cles || []), ...(r.a_revoir || []).map((a) => a.notion), ...(r.fautes || []).map((f) => f.notion),
      ...(rec.files || []).map((f) => f.name || f), rec.consigne
    ].filter(Boolean).join(' '));
  }

  /**
   * Empreintes d'une correction :
   *  - exerciseKey : identifie l'EXERCICE (même énoncé => tentatives regroupées) ;
   *  - answerHash  : identifie la RÉPONSE (une re-correction de la même copie n'est pas une nouvelle tentative).
   */
  static fingerprints({ result = {}, sources = [], exerciseUuid = null }) {
    const strong = (s) => normalize(s).replace(/[^a-z0-9]/g, '');
    const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 20);
    const enonceFiles = new Set(result.identification?.enonce || []);
    const isEnonce = (s) => s.role === 'enonce' || s.kind === 'generated' || enonceFiles.has(s.file);
    // Seul le texte stable (pas les transcriptions d'images, qui varient d'une lecture à l'autre)
    const enonceText = strong(sources.filter((s) => isEnonce(s) && !['image', 'audio'].includes(s.kind)).map((s) => s.text).join('\n'));
    let exerciseKey;
    if (exerciseUuid) exerciseKey = `x:${exerciseUuid}`;
    else if (enonceText.length >= 40) exerciseKey = `e:${sha(enonceText.slice(0, 6000))}`;
    else exerciseKey = `t:${sha(strong(`${result.titre || ''}|${result.matiere || ''}`))}`;
    const answerHash = sha(strong(sources.filter((s) => !isEnonce(s)).map((s) => s.text).join('\n')) || String(Math.random()));
    return { exerciseKey, answerHash };
  }

  saveCorrection(rec) {
    const r = rec.result || {};
    const fp = Database.fingerprints({ result: r, sources: rec.sources || [], exerciseUuid: rec.exerciseUuid });
    return this.run(
      `INSERT INTO corrections (uuid, name, folder_id, created_at, updated_at, subject, exercise_type, score, grade, grade_max, files, consigne, result, sources, model, search_text, kind, exercise_id, pages, counted, exercise_key, answer_hash, origin, claude_url, attachments, eval_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        rec.uuid || uuid(), rec.name, rec.folderId || null, rec.createdAt || now(), now(), r.matiere || null, r.type_exercice || null,
        r.score_pourcentage ?? null, r.note?.obtenue ?? null, r.note?.sur ?? null,
        JSON.stringify(rec.files || []), rec.consigne || '', JSON.stringify(r), JSON.stringify(rec.sources || []), rec.model || null,
        Database.searchText(rec, r), rec.kind || 'correction', rec.exerciseId || null, rec.pages ? JSON.stringify(rec.pages) : null,
        rec.counted === false ? 0 : 1, rec.exerciseKey || fp.exerciseKey, rec.answerHash || fp.answerHash,
        rec.origin || 'api', rec.claudeUrl || null, rec.attachments ? JSON.stringify(rec.attachments) : null, rec.evalType || null
      ]
    );
  }

  _hydrate(row) {
    if (!row) return null;
    return {
      ...row,
      files: JSON.parse(row.files || '[]'),
      result: row.result ? JSON.parse(row.result) : null,
      sources: row.sources ? JSON.parse(row.sources) : [],
      pages: row.pages ? JSON.parse(row.pages) : [],
      annotations: row.annotations ? JSON.parse(row.annotations) : [],
      attachments: row.attachments ? JSON.parse(row.attachments) : []
    };
  }

  getCorrection(id) {
    return this._hydrate(this.get('SELECT * FROM corrections WHERE id = ?', [id]));
  }

  /** @param {object} q { folderId: number|'none', search, type, kind, limit, offset } */
  listCorrections(q = {}) {
    const where = [];
    const params = [];
    if (q.folderId === 'none') where.push('folder_id IS NULL');
    else if (q.folderId) { where.push('folder_id = ?'); params.push(q.folderId); }
    if (q.type) { where.push('exercise_type = ?'); params.push(q.type); }
    if (q.kind) { where.push("COALESCE(kind, 'correction') = ?"); params.push(q.kind); }
    if (q.subject) { where.push('subject = ?'); params.push(q.subject); }
    if (q.evalType) { where.push('eval_type = ?'); params.push(q.evalType); }
    // Brouillons : exclus par défaut (non comptés)
    if (q.drafts) where.push('counted = 0');
    else if (!q.all) where.push('counted = 1');
    if (q.search) {
      for (const word of normalize(q.search).split(/\s+/).filter(Boolean)) {
        where.push("(search_text LIKE ? ESCAPE '\\')");
        params.push(`%${word.replace(/[\\%_]/g, (m) => '\\' + m)}%`);
      }
    }
    const sql = `SELECT c.id, c.uuid, c.name, c.folder_id, c.created_at, c.subject, c.exercise_type, c.score, c.grade, c.grade_max, c.files, c.model, c.kind, c.counted, c.exercise_key, c.origin, c.eval_type,
                        f.name AS folder_name
                 FROM corrections c LEFT JOIN folders f ON f.id = c.folder_id
                 ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY c.created_at DESC LIMIT ? OFFSET ?`;
    params.push(q.limit || 1000, q.offset || 0);
    return this.all(sql, params).map((r) => ({ ...r, files: JSON.parse(r.files || '[]') }));
  }

  updateCorrection(id, patch) {
    const row = this.getCorrection(id);
    if (!row) throw new Error('Correction introuvable.');
    if (patch.name !== undefined) {
      const clean = String(patch.name).trim();
      if (!clean) throw new Error('Le nom est vide.');
      this.x('UPDATE corrections SET name = ?, search_text = ? WHERE id = ?', [clean, Database.searchText({ ...row, name: clean }, row.result), id]);
    }
    if (patch.folderId !== undefined) this.x('UPDATE corrections SET folder_id = ? WHERE id = ?', [patch.folderId || null, id]);
    if (patch.claudeUrl !== undefined) this.x('UPDATE corrections SET claude_url = ? WHERE id = ?', [patch.claudeUrl || null, id]);
    if (patch.attachments !== undefined) this.x('UPDATE corrections SET attachments = ? WHERE id = ?', [JSON.stringify(patch.attachments || []), id]);
    if (patch.counted !== undefined) this.x('UPDATE corrections SET counted = ? WHERE id = ?', [patch.counted ? 1 : 0, id]);
    if (patch.exerciseKey !== undefined) {
      // null = détacher : l'exercice redevient une série à part
      this.x('UPDATE corrections SET exercise_key = ? WHERE id = ?', [patch.exerciseKey || `u:${row.uuid}`, id]);
    }
    this.x('UPDATE corrections SET updated_at = ? WHERE id = ?', [now(), id]);
    this.persist();
    return this.getCorrection(id);
  }

  /** Complète le résultat enregistré (ex. correction modèle générée après coup). */
  patchResult(id, fields) {
    const row = this.get('SELECT result FROM corrections WHERE id = ?', [id]);
    if (!row) return null;
    const result = { ...JSON.parse(row.result || '{}'), ...fields };
    this.x('UPDATE corrections SET result = ? WHERE id = ?', [JSON.stringify(result), id]);
    this.persist();
    return result;
  }

  deleteCorrection(id) {
    this.run('DELETE FROM corrections WHERE id = ?', [id]);
  }

  stats() {
    return {
      ...this.get(`SELECT COUNT(*) AS total, ROUND(AVG(score), 1) AS avg_score,
                   SUM(CASE WHEN folder_id IS NOT NULL THEN 1 ELSE 0 END) AS filed FROM corrections WHERE counted = 1`),
      drafts: this.get('SELECT COUNT(*) AS n FROM corrections WHERE counted = 0').n,
      due: this.get('SELECT COUNT(*) AS n FROM flashcards WHERE due_at <= ?', [now()]).n,
      cards: this.get('SELECT COUNT(*) AS n FROM flashcards').n
    };
  }

  /** Données du tableau de bord de progression. */
  dashboard() {
    const rows = this.all('SELECT id, name, created_at, subject, exercise_type, score, result, kind FROM corrections WHERE counted = 1 ORDER BY created_at ASC');
    const timeline = [];
    const subjects = {};
    const notions = {};
    const categories = {};
    for (const r of rows) {
      const res = r.result ? JSON.parse(r.result) : {};
      const subject = (r.subject || 'Sans matière').trim();
      timeline.push({ id: r.id, date: r.created_at, score: r.score, subject, type: r.exercise_type, name: r.name, kind: r.kind || 'correction' });
      const s = (subjects[subject] ||= { subject, count: 0, sum: 0, scores: [], last: null });
      s.count++;
      if (r.score != null) { s.sum += r.score; s.scores.push(r.score); }
      s.last = r.created_at;
      for (const f of res.fautes || []) {
        const key = (f.notion || f.categorie || 'autre').trim();
        const n = (notions[normalize(key)] ||= { notion: key, count: 0, majeures: 0, last: null, subjects: new Set() });
        n.count++;
        if (f.gravite === 'majeure') n.majeures++;
        n.last = r.created_at;
        n.subjects.add(subject);
        categories[f.categorie || 'autre'] = (categories[f.categorie || 'autre'] || 0) + 1;
      }
      for (const a of res.a_revoir || []) {
        const key = (a.notion || '').trim();
        if (!key) continue;
        const n = (notions[normalize(key)] ||= { notion: key, count: 0, majeures: 0, last: null, subjects: new Set() });
        n.count += a.priorite === 'haute' ? 1 : 0.5;
        n.last = r.created_at;
        n.subjects.add(subject);
      }
    }
    const bySubject = Object.values(subjects).map((s) => {
      const half = Math.max(1, Math.floor(s.scores.length / 2));
      const first = s.scores.slice(0, half);
      const last = s.scores.slice(-half);
      const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
      return { subject: s.subject, count: s.count, avg: avg(s.scores), trend: s.scores.length >= 2 ? avg(last) - avg(first) : null, last: s.last };
    }).sort((a, b) => b.count - a.count);
    const topNotions = Object.values(notions)
      .map((n) => ({ ...n, subjects: [...n.subjects] }))
      .sort((a, b) => b.count - a.count || b.majeures - a.majeures)
      .slice(0, 15);
    return {
      timeline,
      bySubject,
      topNotions,
      categories: Object.entries(categories).map(([categorie, count]) => ({ categorie, count })).sort((a, b) => b.count - a.count),
      cards: this.get('SELECT COUNT(*) AS total, SUM(CASE WHEN due_at <= ? THEN 1 ELSE 0 END) AS due, SUM(CASE WHEN box >= 4 THEN 1 ELSE 0 END) AS mastered FROM flashcards', [now()]),
      exercises: this.get('SELECT COUNT(*) AS total, SUM(CASE WHEN done_correction_id IS NOT NULL THEN 1 ELSE 0 END) AS done FROM exercises'),
      attempts: this.attemptStats()
    };
  }

  // ---------- Tentatives : réussite du premier coup et amélioration ----------
  /**
   * Séries de tentatives (corrections ENREGISTRÉES d'un même exercice, dans l'ordre chronologique).
   * Les re-corrections d'une même copie (même réponse) ne comptent que pour une tentative : on garde la dernière note.
   */
  attemptSeries() {
    const rows = this.all(`SELECT id, name, created_at, score, grade, grade_max, subject, exercise_key, answer_hash, result FROM corrections
                           WHERE counted = 1 AND score IS NOT NULL AND exercise_key IS NOT NULL ORDER BY created_at ASC, id ASC`);
    const series = new Map();
    for (const r of rows) {
      const s = series.get(r.exercise_key) || { key: r.exercise_key, attempts: [] };
      const last = s.attempts[s.attempts.length - 1];
      const att = { id: r.id, date: r.created_at, score: r.score, grade: r.grade, gradeMax: r.grade_max, answer: r.answer_hash };
      if (last && last.answer === r.answer_hash) Object.assign(last, att); // re-correction de la même réponse
      else s.attempts.push(att);
      let title = r.name;
      try { title = JSON.parse(r.result).titre || r.name; } catch { /* ignore */ }
      s.title = title;
      s.subject = r.subject;
      series.set(r.exercise_key, s);
    }
    return [...series.values()].map((s) => {
      const first = s.attempts[0];
      const last = s.attempts[s.attempts.length - 1];
      const best = Math.max(...s.attempts.map((a) => a.score));
      return {
        ...s,
        count: s.attempts.length,
        first: first.score,
        last: last.score,
        best,
        firstSuccess: first.score >= SUCCESS_THRESHOLD,
        finalSuccess: last.score >= SUCCESS_THRESHOLD,
        improvement: s.attempts.length > 1 ? last.score - first.score : null,
        lastDate: last.date
      };
    }).sort((a, b) => (b.lastDate || '').localeCompare(a.lastDate || ''));
  }

  attemptStats() {
    const series = this.attemptSeries();
    const multi = series.filter((s) => s.count > 1);
    const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);
    const failedFirst = series.filter((s) => !s.firstSuccess);
    return {
      threshold: SUCCESS_THRESHOLD,
      exercises: series.length,
      firstTryRate: pct(series.filter((s) => s.firstSuccess).length, series.length),
      avgFirstScore: series.length ? Math.round((series.reduce((t, s) => t + s.first, 0) / series.length) * 10) / 10 : null,
      reworked: multi.length,
      avgImprovement: multi.length ? Math.round((multi.reduce((t, s) => t + s.improvement, 0) / multi.length) * 10) / 10 : null,
      improvedRate: pct(multi.filter((s) => s.improvement > 0).length, multi.length),
      // Parmi les exercices ratés du premier coup : combien sont réussis à la dernière tentative ?
      recoveredRate: pct(failedFirst.filter((s) => s.finalSuccess).length, failedFirst.length),
      finalRate: pct(series.filter((s) => s.finalSuccess).length, series.length),
      series: series.slice(0, 50)
    };
  }

  /** Tentatives de l'exercice d'une correction (pour la page de résultat). */
  attemptsFor(id) {
    const row = this.get('SELECT exercise_key FROM corrections WHERE id = ?', [id]);
    if (!row?.exercise_key) return null;
    const s = this.attemptSeries().find((x) => x.key === row.exercise_key);
    if (!s) return null;
    return { ...s, index: s.attempts.findIndex((a) => a.id === id) };
  }

  /** Corrections enregistrées proposées pour « lier à un exercice » (une par série). */
  seriesChoices(excludeId) {
    return this.attemptSeries().filter((s) => !s.attempts.some((a) => a.id === excludeId) || s.count > 1).map((s) => ({ key: s.key, title: s.title, subject: s.subject, count: s.count, last: s.lastDate }));
  }

  /** Brouillons plus vieux que N jours : supprimés (renvoie les dossiers de pages à nettoyer). */
  purgeDrafts(days = 14) {
    const limit = new Date(Date.now() - days * 86400000).toISOString();
    const rows = this.all('SELECT id, pages FROM corrections WHERE counted = 0 AND created_at < ?', [limit]);
    if (!rows.length) return [];
    this.x(`DELETE FROM corrections WHERE id IN (${rows.map(() => '?').join(',')})`, rows.map((r) => r.id));
    this.persist();
    return rows.map((r) => (JSON.parse(r.pages || '[]')[0]?.img || '').split('/')[1]).filter(Boolean);
  }

  // ---------- Fiches de révision (répétition espacée, boîtes de Leitner) ----------
  addFlashcards(cards, { correctionId = null, subject = null } = {}) {
    const ts = now();
    for (const c of cards) {
      this.x('INSERT INTO flashcards (uuid, correction_id, front, back, notion, subject, box, due_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)',
        [uuid(), correctionId, c.front, c.back, c.notion || null, subject || c.subject || null, ts, ts, ts]);
    }
    this.persist();
    return cards.length;
  }

  listFlashcards({ dueOnly = false, correctionId, search, limit = 500 } = {}) {
    const where = [];
    const params = [];
    if (dueOnly) { where.push('due_at <= ?'); params.push(now()); }
    if (correctionId) { where.push('correction_id = ?'); params.push(correctionId); }
    if (search) { where.push('(front LIKE ? OR back LIKE ? OR notion LIKE ? OR subject LIKE ?)'); params.push(...Array(4).fill(`%${search}%`)); }
    params.push(limit);
    return this.all(`SELECT * FROM flashcards ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${dueOnly ? 'due_at ASC' : 'created_at DESC'} LIMIT ?`, params);
  }

  /** grade : 'again' | 'hard' | 'good' | 'easy' */
  reviewFlashcard(id, grade, at = new Date()) {
    const c = this.get('SELECT * FROM flashcards WHERE id = ?', [id]);
    if (!c) throw new Error('Fiche introuvable.');
    let box = c.box;
    let due;
    const day = 86400000;
    if (grade === 'again') {
      box = 1;
      due = new Date(at.getTime() + 10 * 60000);
    } else if (grade === 'hard') {
      box = Math.max(1, box);
      due = new Date(at.getTime() + Math.max(0.5, BOX_DAYS[box] / 2) * day);
    } else {
      box = Math.min(BOX_DAYS.length - 1, box + (grade === 'easy' ? 2 : 1));
      due = new Date(at.getTime() + BOX_DAYS[box] * day);
    }
    this.x('UPDATE flashcards SET box = ?, due_at = ?, last_review = ?, reviews = reviews + 1, lapses = lapses + ?, updated_at = ? WHERE id = ?',
      [box, due.toISOString(), at.toISOString(), grade === 'again' ? 1 : 0, now(), id]);
    this.persist();
    return this.get('SELECT * FROM flashcards WHERE id = ?', [id]);
  }

  updateFlashcard(id, { front, back }) {
    this.run('UPDATE flashcards SET front = COALESCE(?, front), back = COALESCE(?, back), updated_at = ? WHERE id = ?', [front ?? null, back ?? null, now(), id]);
  }

  deleteFlashcard(id) {
    this.run('DELETE FROM flashcards WHERE id = ?', [id]);
  }

  // ---------- Exercices d'entraînement ----------
  saveExercise(ex, sourceCorrectionId = null) {
    return this.run(`INSERT INTO exercises (uuid, title, subject, exercise_type, language, notions, statement, answer_format, difficulty, source_correction_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [uuid(), ex.titre, ex.matiere, ex.type_exercice, ex.langage, JSON.stringify(ex.notions || []), ex.enonce, ex.format_reponse, ex.difficulte, sourceCorrectionId, now(), now()]);
  }

  listExercises() {
    return this.all('SELECT e.*, c.score AS done_score, c.grade AS done_grade, c.grade_max AS done_grade_max FROM exercises e LEFT JOIN corrections c ON c.id = e.done_correction_id ORDER BY e.created_at DESC')
      .map((e) => ({ ...e, notions: JSON.parse(e.notions || '[]') }));
  }

  getExercise(id) {
    const e = this.get('SELECT * FROM exercises WHERE id = ?', [id]);
    return e ? { ...e, notions: JSON.parse(e.notions || '[]') } : null;
  }

  updateExercise(id, patch) {
    if (patch.draft !== undefined) this.x('UPDATE exercises SET draft = ?, updated_at = ? WHERE id = ?', [patch.draft, now(), id]);
    if (patch.doneCorrectionId !== undefined) this.x('UPDATE exercises SET done_correction_id = ?, updated_at = ? WHERE id = ?', [patch.doneCorrectionId, now(), id]);
    this.persist();
    return this.getExercise(id);
  }

  deleteExercise(id) {
    this.run('DELETE FROM exercises WHERE id = ?', [id]);
  }

  setAnnotations(id, annotations) {
    this.run('UPDATE corrections SET annotations = ?, updated_at = ? WHERE id = ?', [JSON.stringify(annotations || []), now(), id]);
  }

  setPages(id, pages) {
    this.run('UPDATE corrections SET pages = ? WHERE id = ?', [JSON.stringify(pages || []), id]);
  }

  // ---------- Discussion avec l'IA ----------
  listChat(correctionId) {
    return this.all('SELECT * FROM chat_messages WHERE correction_id = ? ORDER BY id ASC', [correctionId]);
  }

  addChat(correctionId, role, content, model = null) {
    return this.run('INSERT INTO chat_messages (uuid, correction_id, role, content, model, created_at) VALUES (?, ?, ?, ?, ?, ?)', [uuid(), correctionId, role, content, model, now()]);
  }

  clearChat(correctionId) {
    this.run('DELETE FROM chat_messages WHERE correction_id = ?', [correctionId]);
  }

  // ---------- File d'attente ----------
  addJob({ title, payloadFile, consigne = '', folderId = null }) {
    return this.run('INSERT INTO jobs (title, status, payload_file, consigne, folder_id, created_at) VALUES (?, ?, ?, ?, ?, ?)', [title, 'pending', payloadFile, consigne, folderId, now()]);
  }

  listJobs() {
    return this.all("SELECT j.*, c.score, c.grade, c.grade_max FROM jobs j LEFT JOIN corrections c ON c.id = j.correction_id ORDER BY CASE j.status WHEN 'running' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, j.id DESC LIMIT 300");
  }

  getJob(id) {
    return this.get('SELECT * FROM jobs WHERE id = ?', [id]);
  }

  nextJob() {
    return this.get("SELECT * FROM jobs WHERE status = 'pending' ORDER BY id ASC LIMIT 1");
  }

  updateJob(id, patch) {
    const cols = Object.keys(patch);
    if (!cols.length) return;
    this.run(`UPDATE jobs SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [...cols.map((c) => patch[c]), id]);
  }

  /** Au démarrage : une tâche interrompue par la fermeture de l'application reprend. */
  resumeJobs() {
    this.run("UPDATE jobs SET status = 'pending', progress = 'Reprise après redémarrage' WHERE status = 'running'");
  }

  deleteJob(id) {
    this.run('DELETE FROM jobs WHERE id = ?', [id]);
  }

  clearFinishedJobs() {
    const rows = this.all("SELECT payload_file FROM jobs WHERE status IN ('done', 'cancelled')");
    this.run("DELETE FROM jobs WHERE status IN ('done', 'cancelled')");
    return rows.map((r) => r.payload_file);
  }

  // ---------- Réinitialisation ----------
  /** Efface toutes les données de cette installation (le fichier reste, vide). */
  resetAll() {
    this.x('DELETE FROM chat_messages');
    this.x('DELETE FROM jobs');
    this.x('DELETE FROM flashcards');
    this.x('DELETE FROM exercises');
    this.x('DELETE FROM corrections');
    this.x('DELETE FROM folders');
    this.x("DELETE FROM sqlite_sequence WHERE name IN ('chat_messages', 'jobs', 'flashcards', 'exercises', 'corrections', 'folders')");
    this.persist();
  }

  // ---------- Sauvegarde / fusion ----------
  exportAll() {
    return {
      schema: SCHEMA_VERSION,
      folders: this.all('SELECT * FROM folders'),
      corrections: this.all('SELECT * FROM corrections'),
      flashcards: this.all('SELECT * FROM flashcards'),
      exercises: this.all('SELECT * FROM exercises'),
      chat: this.all('SELECT m.*, c.uuid AS correction_uuid FROM chat_messages m JOIN corrections c ON c.id = m.correction_id')
    };
  }

  /**
   * Fusionne une sauvegarde (d'un autre PC ou d'une ancienne version) sans doublon : les éléments sont
   * reconnus par leur uuid ; pour un élément déjà présent, la version modifiée le plus récemment l'emporte.
   */
  mergeAll(data) {
    const stats = { folders: 0, corrections: 0, flashcards: 0, exercises: 0, updated: 0 };
    const newer = (a, b) => (a || '') > (b || '');
    const folderMap = {};
    const corrMap = {};
    // Dossiers (parents d'abord)
    const pending = [...(data.folders || [])];
    let guard = 0;
    while (pending.length && guard++ < 10000) {
      const f = pending.shift();
      const parent = data.folders.find((p) => p.id === f.parent_id);
      if (parent && folderMap[parent.id] === undefined) { pending.push(f); continue; }
      const local = f.uuid && this.get('SELECT * FROM folders WHERE uuid = ?', [f.uuid]);
      if (local) {
        folderMap[f.id] = local.id;
        if (newer(f.updated_at, local.updated_at)) {
          this.x('UPDATE folders SET name = ?, parent_id = ?, updated_at = ? WHERE id = ?', [f.name, parent ? folderMap[parent.id] : null, f.updated_at, local.id]);
          stats.updated++;
        }
      } else {
        this.x('INSERT INTO folders (uuid, name, parent_id, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
          [f.uuid || uuid(), f.name, parent ? folderMap[parent.id] : null, f.color, f.created_at, f.updated_at || f.created_at]);
        folderMap[f.id] = this.get('SELECT last_insert_rowid() AS id').id;
        stats.folders++;
      }
    }
    for (const c of data.corrections || []) {
      const local = c.uuid && this.get('SELECT id, updated_at FROM corrections WHERE uuid = ?', [c.uuid]);
      const folderId = c.folder_id ? folderMap[c.folder_id] ?? null : null;
      if (local) {
        corrMap[c.id] = local.id;
        if (newer(c.updated_at, local.updated_at)) {
          this.x('UPDATE corrections SET name = ?, folder_id = ?, search_text = ?, counted = ?, exercise_key = COALESCE(?, exercise_key), claude_url = COALESCE(?, claude_url), result = COALESCE(?, result), updated_at = ? WHERE id = ?', [c.name, folderId, c.search_text, c.counted ?? 1, c.exercise_key ?? null, c.claude_url ?? null, c.result ?? null, c.updated_at, local.id]);
          stats.updated++;
        }
        continue;
      }
      this.x(`INSERT INTO corrections (uuid, name, folder_id, created_at, updated_at, subject, exercise_type, score, grade, grade_max, files, consigne, result, sources, model, search_text, kind, pages, annotations, counted, exercise_key, answer_hash, origin, claude_url, attachments, eval_type)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [c.uuid || uuid(), c.name, folderId, c.created_at, c.updated_at || c.created_at, c.subject, c.exercise_type, c.score, c.grade, c.grade_max, c.files, c.consigne, c.result, c.sources, c.model, c.search_text, c.kind || 'correction', c.pages, c.annotations, c.counted ?? 1, c.exercise_key ?? null, c.answer_hash ?? null, c.origin || 'api', c.claude_url ?? null, c.attachments ?? null, c.eval_type ?? null]);
      corrMap[c.id] = this.get('SELECT last_insert_rowid() AS id').id;
      stats.corrections++;
    }
    for (const f of data.flashcards || []) {
      const local = f.uuid && this.get('SELECT id, updated_at FROM flashcards WHERE uuid = ?', [f.uuid]);
      if (local) {
        if (newer(f.updated_at, local.updated_at)) {
          this.x('UPDATE flashcards SET front = ?, back = ?, box = ?, due_at = ?, last_review = ?, reviews = ?, lapses = ?, updated_at = ? WHERE id = ?',
            [f.front, f.back, f.box, f.due_at, f.last_review, f.reviews, f.lapses, f.updated_at, local.id]);
          stats.updated++;
        }
        continue;
      }
      this.x('INSERT INTO flashcards (uuid, correction_id, front, back, notion, subject, box, due_at, last_review, reviews, lapses, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [f.uuid || uuid(), corrMap[f.correction_id] ?? null, f.front, f.back, f.notion, f.subject, f.box, f.due_at, f.last_review, f.reviews, f.lapses, f.created_at, f.updated_at || f.created_at]);
      stats.flashcards++;
    }
    for (const e of data.exercises || []) {
      const local = e.uuid && this.get('SELECT id, updated_at FROM exercises WHERE uuid = ?', [e.uuid]);
      if (local) {
        if (newer(e.updated_at, local.updated_at)) {
          this.x('UPDATE exercises SET draft = ?, done_correction_id = ?, updated_at = ? WHERE id = ?', [e.draft, corrMap[e.done_correction_id] ?? null, e.updated_at, local.id]);
          stats.updated++;
        }
        continue;
      }
      this.x(`INSERT INTO exercises (uuid, title, subject, exercise_type, language, notions, statement, answer_format, difficulty, source_correction_id, done_correction_id, draft, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [e.uuid || uuid(), e.title, e.subject, e.exercise_type, e.language, e.notions, e.statement, e.answer_format, e.difficulty, corrMap[e.source_correction_id] ?? null, corrMap[e.done_correction_id] ?? null, e.draft, e.created_at, e.updated_at || e.created_at]);
      stats.exercises++;
    }
    for (const m of data.chat || []) {
      if (m.uuid && this.get('SELECT id FROM chat_messages WHERE uuid = ?', [m.uuid])) continue;
      const cid = this.get('SELECT id FROM corrections WHERE uuid = ?', [m.correction_uuid])?.id;
      if (!cid) continue;
      this.x('INSERT INTO chat_messages (uuid, correction_id, role, content, model, created_at) VALUES (?, ?, ?, ?, ?, ?)', [m.uuid || uuid(), cid, m.role, m.content, m.model, m.created_at]);
    }
    this.persist(true);
    return stats;
  }

  /** Remplace entièrement la base (restauration). */
  replaceWith(buffer) {
    const test = new this.SQL.Database(buffer);
    test.exec('SELECT COUNT(*) FROM corrections');
    this.db.close();
    this.db = test;
    this.migrate();
    this.persist(true);
  }

  rawExport() {
    return Buffer.from(this.db.export());
  }
}

module.exports = { Database, normalize, BOX_DAYS };
