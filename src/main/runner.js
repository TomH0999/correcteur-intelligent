'use strict';
/**
 * Exécution réelle de code pour vérifier les réponses :
 *  - Python, JavaScript, SQL : intégrés (aucune installation nécessaire), dans un worker isolé ;
 *  - Java, C, C++, PHP : via les outils installés sur le PC (java, gcc, g++, php) s'ils sont présents.
 * Chaque exécution est limitée dans le temps.
 */
const { Worker } = require('worker_threads');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BUILTIN = ['python', 'javascript', 'sql'];
const ALIASES = {
  py: 'python', python3: 'python', js: 'javascript', node: 'javascript', nodejs: 'javascript', typescript: 'javascript', ts: 'javascript',
  sqlite: 'sql', mysql: 'sql', postgresql: 'sql', postgres: 'sql', 'pl/sql': 'sql', oracle: 'sql', 'c++': 'cpp', cxx: 'cpp'
};
const MAX_OUT = 20000;

function normalizeLanguage(l) {
  const k = String(l || '').trim().toLowerCase();
  return ALIASES[k] || k;
}

let worker = null;
let seq = 0;
const pending = new Map();

function getWorker() {
  if (worker) return worker;
  // Le worker est décompressé hors de l'archive asar (voir build.asarUnpack)
  worker = new Worker(path.join(__dirname.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`), 'runner-worker.js'));
  worker.unref();
  worker.on('message', (m) => {
    const p = pending.get(m.id);
    if (p) {
      pending.delete(m.id);
      p.resolve(m);
    }
  });
  worker.on('error', (err) => {
    for (const p of pending.values()) p.resolve({ ok: false, stdout: '', stderr: String(err.message || err), exitCode: 1 });
    pending.clear();
    worker = null;
  });
  worker.on('exit', () => { worker = null; });
  return worker;
}

function runBuiltin(language, code, stdin, timeoutMs) {
  return new Promise((resolve) => {
    const id = ++seq;
    const w = getWorker();
    const timer = setTimeout(() => {
      pending.delete(id);
      w.terminate(); // boucle infinie : on détruit le worker (il sera recréé)
      worker = null;
      resolve({ ok: false, stdout: '', stderr: `Temps d'exécution dépassé (${timeoutMs / 1000} s) : boucle infinie ou programme trop lent.`, exitCode: -1, timedOut: true, durationMs: timeoutMs });
    }, timeoutMs + (language === 'python' ? 8000 : 0)); // + temps de chargement de Python la 1re fois
    pending.set(id, { resolve: (r) => { clearTimeout(timer); resolve(r); } });
    w.postMessage({ id, language, code, stdin });
  });
}

const toolCache = {};
function hasTool(cmd, args = ['--version']) {
  if (toolCache[cmd] !== undefined) return Promise.resolve(toolCache[cmd]);
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5000, windowsHide: true }, (err) => {
      toolCache[cmd] = !err;
      resolve(!err);
    });
  });
}

function runProcess(cmd, args, { cwd, stdin, timeoutMs }) {
  return new Promise((resolve) => {
    const t = Date.now();
    const child = spawn(cmd, args, { cwd, windowsHide: true });
    let out = '';
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (d) => { if (out.length < MAX_OUT) out += d; });
    child.stderr.on('data', (d) => { if (err.length < MAX_OUT) err += d; });
    child.on('error', (e) => { err += e.message; });
    child.on('close', (code) => {
      clearTimeout(timer);
      err = err.split('\n').filter((l) => !/^Picked up (JAVA_TOOL_OPTIONS|_JAVA_OPTIONS)/.test(l)).join('\n');
      resolve({
        ok: code === 0 && !timedOut,
        stdout: out,
        stderr: timedOut ? `${err}\nTemps d'exécution dépassé (${timeoutMs / 1000} s).` : err,
        exitCode: code,
        timedOut,
        durationMs: Date.now() - t
      });
    });
    if (stdin) child.stdin.write(stdin);
    child.stdin.end();
  });
}

async function runNative(language, code, stdin, timeoutMs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'correcteur-run-'));
  try {
    if (language === 'java') {
      if (!(await hasTool('java', ['-version']))) return unavailable('Java (JDK 11+) n\'est pas installé sur ce PC.');
      const cls = (code.match(/public\s+(?:final\s+)?class\s+(\w+)/) || [])[1] || 'Main';
      const file = path.join(dir, `${cls}.java`);
      fs.writeFileSync(file, code);
      return await runProcess('java', [file], { cwd: dir, stdin, timeoutMs: timeoutMs + 5000 });
    }
    if (language === 'c' || language === 'cpp') {
      const cc = language === 'c' ? 'gcc' : 'g++';
      if (!(await hasTool(cc))) return unavailable(`Le compilateur ${cc} n'est pas installé sur ce PC (MinGW / MSYS2).`);
      const src = path.join(dir, language === 'c' ? 'main.c' : 'main.cpp');
      const exe = path.join(dir, process.platform === 'win32' ? 'main.exe' : 'main');
      fs.writeFileSync(src, code);
      const comp = await runProcess(cc, [src, '-o', exe, '-lm'], { cwd: dir, timeoutMs: 30000 });
      if (!comp.ok) return { ...comp, stderr: `Erreur de compilation :\n${comp.stderr}` };
      return await runProcess(exe, [], { cwd: dir, stdin, timeoutMs });
    }
    if (language === 'php') {
      if (!(await hasTool('php', ['-v']))) return unavailable('PHP n\'est pas installé sur ce PC.');
      const file = path.join(dir, 'main.php');
      fs.writeFileSync(file, code);
      return await runProcess('php', [file], { cwd: dir, stdin, timeoutMs });
    }
    return unavailable(`Exécution du langage « ${language} » non prise en charge.`);
  } finally {
    fs.rm(dir, { recursive: true, force: true }, () => {});
  }
}

function unavailable(msg) {
  return { ok: false, stdout: '', stderr: msg, exitCode: null, unavailable: true, durationMs: 0 };
}

async function runCode({ language, code, stdin = '', timeoutMs = 10000 }) {
  const lang = normalizeLanguage(language);
  if (BUILTIN.includes(lang)) return { language: lang, ...(await runBuiltin(lang, code, stdin, timeoutMs)) };
  return { language: lang, ...(await runNative(lang, code, stdin, timeoutMs)) };
}

const RUNNABLE = ['python', 'javascript', 'sql', 'java', 'c', 'cpp', 'php'];

async function shutdown() {
  if (worker) await worker.terminate();
  worker = null;
}

module.exports = { runCode, normalizeLanguage, RUNNABLE, shutdown };
