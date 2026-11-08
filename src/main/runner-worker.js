'use strict';
/**
 * Exécution isolée (worker thread) :
 *  - Python : Pyodide (WebAssembly), bibliothèques (numpy, pandas…) téléchargées à la demande puis en cache ;
 *  - SQL : vrai PostgreSQL embarqué (PGlite) avec traduction automatique Oracle / MySQL / SQL Server ;
 *    SQLite en secours si PostgreSQL ne peut pas démarrer.
 * Le processus principal termine ce worker si le temps imparti est dépassé (boucle infinie…).
 */
const { parentPort } = require('worker_threads');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { prepareScript, COMPAT_SETUP, SEARCH_PATH } = require('./sqlcompat');

let pyodidePromise = null;
let pgPromise = null;
let SQLPromise = null;

const MAX_OUT = 20000;
const cap = (s) => (s.length > MAX_OUT ? s.slice(0, MAX_OUT) + `\n[… sortie tronquée (${s.length} caractères)]` : s);

function unpacked(p) {
  return p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}

// ================================================================ Python

async function getPyodide() {
  if (!pyodidePromise) {
    const { loadPyodide } = require('pyodide');
    const indexURL = unpacked(path.dirname(require.resolve('pyodide/package.json'))) + path.sep;
    const packageCacheDir = path.join(process.env.CORRECTEUR_DATA || os.tmpdir(), 'pyodide-packages');
    try { fs.mkdirSync(packageCacheDir, { recursive: true }); } catch { /* ignore */ }
    pyodidePromise = loadPyodide({ indexURL, packageCacheDir });
  }
  return pyodidePromise;
}

const EXIT_WRAPPER = `
__exit_code__ = None
try:
    exec(compile(__student_code__, "<exec>", "exec"), globals())
except SystemExit as __e:
    __exit_code__ = 0 if __e.code is None else (__e.code if isinstance(__e.code, int) else 1)
`;

async function runPython(code, stdin, files = {}) {
  const py = await getPyodide();
  let out = '';
  let err = '';
  const lines = String(stdin || '').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  py.setStdout({ batched: (s) => (out += s + '\n') });
  py.setStderr({ batched: (s) => (err += s + '\n') });
  py.setStdin({ stdin: () => (lines.length ? lines.shift() : undefined) });
  // Fichiers de données fournis par le test (open('notes.txt')…)
  const cwd = py.FS.cwd();
  for (const [name, content] of Object.entries(files || {})) {
    try {
      const full = `${cwd}/${name}`;
      const dir = full.slice(0, full.lastIndexOf('/'));
      py.FS.mkdirTree(dir);
      py.FS.writeFile(full, String(content));
    } catch { /* ignore */ }
  }
  // Bibliothèques importées (numpy, pandas…) : chargées si disponibles
  let pkgNote = '';
  try {
    await Promise.race([py.loadPackagesFromImports(code, { messageCallback: () => {}, errorCallback: () => {} }), new Promise((r) => setTimeout(r, 45000))]);
  } catch (e) {
    pkgNote = `[outil] Bibliothèque non chargée : ${String(e.message || e).split('\n')[0]}\n`;
  }
  // Environnement propre à chaque exécution, comme un script lancé directement (__name__ == "__main__")
  const globals = py.toPy({ __name__: '__main__', __student_code__: code });
  try {
    // sys.exit() / exit() : intercepté ici (sinon Pyodide arrête tout le moteur)
    await py.runPythonAsync(EXIT_WRAPPER, { globals });
    const exitCode = globals.get('__exit_code__');
    if (exitCode !== undefined && exitCode !== null && exitCode !== 0) {
      return { ok: false, stdout: cap(out), stderr: cap(`${err}Programme arrêté par sys.exit(${exitCode})`), exitCode: Number(exitCode) || 1 };
    }
    return { ok: true, stdout: cap(out), stderr: cap(err), exitCode: 0 };
  } catch (e) {
    // sys.exit() / exit() / quit() : fin normale du programme, pas une erreur
    const exitMatch = String(e.message || e).match(/SystemExit:?\s*(\S*)\s*$/m);
    if (exitMatch || e.type === 'SystemExit') {
      const code = exitMatch?.[1] || '';
      const ok = !code || code === '0' || code === 'None';
      return { ok, stdout: cap(out), stderr: cap(err + (ok ? '' : `SystemExit: ${code}`)), exitCode: ok ? 0 : Number(code) || 1 };
    }
    // On ne garde que la partie de la trace concernant le code de l'étudiant
    const raw = String(e.message || e).split('\n');
    const start = raw.findIndex((l) => l.includes('File "<exec>"'));
    const msg = (start > 0 ? ['Traceback (most recent call last):', ...raw.slice(start)] : raw).join('\n');
    return { ok: false, stdout: cap(out), stderr: cap(pkgNote + err + msg), exitCode: 1 };
  } finally {
    globals.destroy();
    for (const name of Object.keys(files || {})) {
      try { py.FS.unlink(`${cwd}/${name}`); } catch { /* ignore */ }
    }
  }
}

// ================================================================ SQL

async function getPg() {
  if (!pgPromise) {
    pgPromise = (async () => {
      const { PGlite } = await import('@electric-sql/pglite');
      const pg = await PGlite.create();
      await pg.exec(COMPAT_SETUP);
      return pg;
    })().catch((e) => {
      pgPromise = null;
      throw e;
    });
  }
  return pgPromise;
}

function formatValue(v) {
  if (v === null || v === undefined) return 'NULL';
  if (v instanceof Date) {
    const iso = v.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.replace('T', ' ').replace(/\.\d+Z$/, '');
  }
  if (typeof v === 'number' && !Number.isInteger(v)) return String(Math.round(v * 1e6) / 1e6);
  if (typeof v === 'string' && /^-?\d+\.\d+$/.test(v)) return v.replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function formatResult(res) {
  if (!res.fields?.length) return res.affectedRows != null ? '' : '';
  const cols = res.fields.map((f) => f.name);
  let out = `${cols.join(' | ')}\n${cols.map(() => '---').join(' | ')}\n`;
  for (const row of res.rows.slice(0, 200)) out += `${cols.map((c) => formatValue(row[c])).join(' | ')}\n`;
  if (res.rows.length > 200) out += `[… ${res.rows.length - 200} lignes de plus]\n`;
  return `${out}(${res.rows.length} ligne(s))\n\n`;
}

const DIALECT_FUNCS = /function (regexp_substr|regexp_replace_oracle|next_day|sys_guid|wm_concat|dateadd|datepart|datename|datediff_big|iif|charindex|convert|format_number|stuff|patindex|isdate|newid|lag_oracle|nvl\w*|decode|months_between|add_months|to_number|instr|year|month|day|date_format|str_to_date|curdate|getdate|last_day|trunc)\(/i;
const DIALECT_SYNTAX = /syntax error at or near "(CONNECT|PRIOR|PIVOT|UNPIVOT|MERGE|QUALIFY|NOCOPY|BULK|FORALL|MODIFY|ENGINE|AUTO_INCREMENT|IDENTITY|TOP|GO|PACKAGE|BODY|IS|REF|CURSOR|TYPE|RECORD|VARRAY|%|:|\[)"/i;

/** Exécute un script SQL instruction par instruction (une erreur n'empêche pas d'exécuter la suite). */
async function runSqlPg(code) {
  const pg = await getPg();
  const { dialect, items, skipped } = prepareScript(code);
  // Base vierge à chaque exécution
  await pg.exec(`DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; TRUNCATE compat.output; ${SEARCH_PATH};`);
  let out = '';
  const errors = [];
  for (const [i, item] of items.entries()) {
    for (const sql of item.sql) {
      try {
        const results = await pg.exec(sql);
        for (const r of results) out += formatResult(r);
      } catch (e) {
        const message = String(e.message || e);
        const head = item.original.replace(/\s+/g, ' ').slice(0, 120);
        // Erreur due à l'outil (syntaxe d'un autre SGBD non convertible) ou erreur réelle de l'étudiant ?
        const dialectIssue = item.unsupported || (item.plsql && dialect !== 'postgres') || DIALECT_FUNCS.test(message) || DIALECT_SYNTAX.test(message);
        errors.push({ index: i + 1, statement: head, message, internal: !!dialectIssue, reason: item.unsupported || (item.plsql ? 'bloc PL/SQL converti automatiquement' : dialectIssue ? `syntaxe propre à ${dialect}` : null) });
        out += `[Erreur à l'instruction ${i + 1} : ${head}]\n${message}\n\n`;
        // Instruction suivante, avec une session saine
        try { await pg.exec(`ROLLBACK; ${SEARCH_PATH};`); } catch { /* ignore */ }
        break;
      }
      // Sortie DBMS_OUTPUT.PUT_LINE
      try {
        const o = await pg.query('SELECT line FROM compat.output ORDER BY id');
        if (o.rows.length) {
          out += `${o.rows.map((r) => r.line).join('\n')}\n`;
          await pg.exec('TRUNCATE compat.output');
        }
      } catch { /* ignore */ }
    }
  }
  const studentErrors = errors.filter((e) => !e.internal);
  const internalErrors = errors.filter((e) => e.internal);
  const notes = [];
  notes.push(`[outil] Exécuté avec PostgreSQL ${dialect !== 'postgres' && dialect !== 'standard' ? `après adaptation automatique de la syntaxe ${dialect === 'oracle' ? 'Oracle' : dialect === 'mysql' ? 'MySQL' : 'SQL Server'}` : ''}.`);
  if (skipped.length) notes.push(`[outil] Commandes du client SQL ignorées (sans effet sur le résultat) : ${skipped.slice(0, 8).map((s) => s.split(/\s+/).slice(0, 2).join(' ')).join(', ')}${skipped.length > 8 ? '…' : ''}.`);
  for (const e of internalErrors) notes.push(`[limite de l'outil, pas une erreur de l'étudiant] Instruction ${e.index} (${e.reason}) : ${e.message}`);
  return {
    ok: studentErrors.length === 0,
    stdout: cap(out || '(instructions exécutées, aucun résultat à afficher)'),
    stderr: cap([...studentErrors.map((e) => `Erreur SQL à l'instruction ${e.index} : ${e.message}`), ...notes].join('\n')),
    exitCode: studentErrors.length ? 1 : 0,
    internal: internalErrors.length > 0,
    category: internalErrors.length && !studentErrors.length ? 'dialecte' : undefined,
    explication: internalErrors.length ? `Certaines instructions utilisent une syntaxe ${dialect} que l'outil ne sait pas exécuter : elles ne doivent pas être comptées comme fausses.` : undefined,
    sqlErrors: errors,
    dialect
  };
}

/** Secours : SQLite (si PostgreSQL embarqué indisponible). */
async function runSqlLite(code) {
  if (!SQLPromise) {
    const initSqlJs = require('sql.js');
    SQLPromise = initSqlJs({ wasmBinary: fs.readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm')) });
  }
  const SQL = await SQLPromise;
  const db = new SQL.Database();
  const { items } = prepareScript(code);
  let out = '';
  const errors = [];
  try {
    for (const [i, item] of items.entries()) {
      const sql = item.sql.join(';\n').replace(/\bLOCALTIMESTAMP(\(0\))?/gi, 'CURRENT_TIMESTAMP').replace(/::\w+/g, '').replace(/\bcompat\./g, '');
      try {
        for (const r of db.exec(sql)) {
          out += `${r.columns.join(' | ')}\n${r.columns.map(() => '---').join(' | ')}\n${r.values.slice(0, 200).map((row) => row.map((v) => (v === null ? 'NULL' : String(v))).join(' | ')).join('\n')}\n(${r.values.length} ligne(s))\n\n`;
        }
      } catch (e) {
        errors.push(`Instruction ${i + 1} : ${e.message}`);
      }
    }
  } finally {
    db.close();
  }
  return {
    ok: errors.length === 0,
    stdout: cap(out || '(instructions exécutées, aucun résultat à afficher)'),
    stderr: errors.length ? `[outil] Exécuté avec SQLite (PostgreSQL indisponible) : certaines syntaxes peuvent ne pas être reconnues.\n${errors.join('\n')}` : '',
    exitCode: errors.length ? 1 : 0,
    internal: errors.length > 0,
    category: errors.length ? 'dialecte' : undefined,
    explication: errors.length ? 'Moteur SQL de secours (SQLite) : les erreurs peuvent venir de l\'outil.' : undefined
  };
}

async function runSql(code) {
  try {
    return await runSqlPg(code);
  } catch (e) {
    if (/PGlite|wasm|import/i.test(String(e.message || e)) || !pgPromise) return runSqlLite(code);
    throw e;
  }
}

parentPort.on('message', async ({ id, language, code, stdin, files }) => {
  const t = Date.now();
  let res;
  try {
    if (language === 'python') res = await runPython(code, stdin, files);
    else if (language === 'sql') res = await runSql(code);
    else res = { ok: false, stdout: '', stderr: `Langage non pris en charge : ${language}`, exitCode: 1, unavailable: true };
  } catch (e) {
    res = { ok: false, stdout: '', stderr: String(e.message || e), exitCode: 1 };
  }
  parentPort.postMessage({ id, ...res, durationMs: Date.now() - t });
});
