'use strict';
/**
 * Exécution isolée (worker thread) : Python (Pyodide/WebAssembly), JavaScript (vm) et SQL (SQLite/sql.js).
 * Le processus principal termine ce worker si le temps imparti est dépassé (boucle infinie…).
 */
const { parentPort } = require('worker_threads');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

let pyodidePromise = null;
let SQLPromise = null;

const MAX_OUT = 20000;
const cap = (s) => (s.length > MAX_OUT ? s.slice(0, MAX_OUT) + `\n[… sortie tronquée (${s.length} caractères)]` : s);

function unpacked(p) {
  return p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}

async function getPyodide() {
  if (!pyodidePromise) {
    const { loadPyodide } = require('pyodide');
    const indexURL = unpacked(path.dirname(require.resolve('pyodide/package.json'))) + path.sep;
    pyodidePromise = loadPyodide({ indexURL });
  }
  return pyodidePromise;
}

async function runPython(code, stdin) {
  const py = await getPyodide();
  let out = '';
  let err = '';
  const lines = String(stdin || '').split('\n');
  py.setStdout({ batched: (s) => (out += s + '\n') });
  py.setStderr({ batched: (s) => (err += s + '\n') });
  py.setStdin({ stdin: () => (lines.length ? lines.shift() : undefined) });
  // Environnement propre à chaque exécution
  const globals = py.toPy({});
  try {
    await py.runPythonAsync(code, { globals });
    return { ok: true, stdout: cap(out), stderr: cap(err), exitCode: 0 };
  } catch (e) {
    // On ne garde que la partie de la trace concernant le code de l'étudiant
    const raw = String(e.message || e).split('\n');
    const start = raw.findIndex((l) => l.includes('File "<exec>"'));
    const msg = (start > 0 ? ['Traceback (most recent call last):', ...raw.slice(start)] : raw).join('\n');
    return { ok: false, stdout: cap(out), stderr: cap(err + msg), exitCode: 1 };
  } finally {
    globals.destroy();
  }
}

function runJavaScript(code, stdin) {
  let out = '';
  const fmt = (args) => args.map((a) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())).join(' ');
  const lines = String(stdin || '').split('\n');
  const sandbox = {
    console: { log: (...a) => (out += fmt(a) + '\n'), error: (...a) => (out += fmt(a) + '\n'), warn: (...a) => (out += fmt(a) + '\n'), info: (...a) => (out += fmt(a) + '\n'), table: (a) => (out += fmt([a]) + '\n') },
    prompt: () => (lines.length ? lines.shift() : null),
    readline: () => (lines.length ? lines.shift() : null),
    Math, JSON, Date, Array, Object, String, Number, Boolean, Map, Set, RegExp, Error, Promise, parseInt, parseFloat, isNaN, isFinite, Symbol, BigInt
  };
  try {
    vm.runInNewContext(code, sandbox, { timeout: 8000 });
    return { ok: true, stdout: cap(out), stderr: '', exitCode: 0 };
  } catch (e) {
    return { ok: false, stdout: cap(out), stderr: `${e.name}: ${e.message}`, exitCode: 1 };
  }
}

async function runSql(code) {
  if (!SQLPromise) {
    const initSqlJs = require('sql.js');
    SQLPromise = initSqlJs({ wasmBinary: fs.readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm')) });
  }
  const SQL = await SQLPromise;
  const db = new SQL.Database();
  let out = '';
  try {
    const results = db.exec(code);
    for (const r of results) {
      out += r.columns.join(' | ') + '\n' + r.columns.map(() => '---').join(' | ') + '\n';
      for (const row of r.values.slice(0, 200)) out += row.map((v) => (v === null ? 'NULL' : String(v))).join(' | ') + '\n';
      if (r.values.length > 200) out += `[… ${r.values.length - 200} lignes de plus]\n`;
      out += `(${r.values.length} ligne(s))\n\n`;
    }
    return { ok: true, stdout: cap(out || '(requêtes exécutées, aucun résultat à afficher)'), stderr: '', exitCode: 0 };
  } catch (e) {
    return { ok: false, stdout: cap(out), stderr: `Erreur SQL (SQLite) : ${e.message}`, exitCode: 1 };
  } finally {
    db.close();
  }
}

parentPort.on('message', async ({ id, language, code, stdin }) => {
  const t = Date.now();
  let res;
  try {
    if (language === 'python') res = await runPython(code, stdin);
    else if (language === 'javascript') res = runJavaScript(code, stdin);
    else if (language === 'sql') res = await runSql(code);
    else res = { ok: false, stdout: '', stderr: `Langage non pris en charge : ${language}`, exitCode: 1, unavailable: true };
  } catch (e) {
    res = { ok: false, stdout: '', stderr: String(e.message || e), exitCode: 1 };
  }
  parentPort.postMessage({ id, ...res, durationMs: Date.now() - t });
});
