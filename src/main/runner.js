'use strict';
/**
 * Exécution réelle de code pour vérifier les réponses :
 *  - Python, SQL : intégrés (aucune installation nécessaire), dans un worker isolé ;
 *  - JavaScript / TypeScript : vrai Node.js (celui embarqué dans l'application) ;
 *  - Java, C, C++, PHP : via les outils installés sur le PC (java, gcc, g++, php) s'ils sont présents.
 * Chaque exécution est limitée dans le temps, et son résultat est CLASSÉ : une erreur due à l'outil
 * (dialecte, entrée non fournie, module absent…) n'est jamais comptée comme une erreur de l'étudiant.
 */
const { Worker } = require('worker_threads');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { classifyExecution } = require('./execclass');

const BUILTIN = ['python', 'sql'];
const ALIASES = {
  py: 'python', python3: 'python', js: 'javascript', node: 'javascript', nodejs: 'javascript', ts: 'typescript',
  sqlite: 'sql', mysql: 'sql', postgresql: 'sql', postgres: 'sql', 'pl/sql': 'sql', plsql: 'sql', oracle: 'sql', mariadb: 'sql', tsql: 'sql',
  'c++': 'cpp', cxx: 'cpp'
};
const MAX_OUT = 20000;

function normalizeLanguage(l) {
  const k = String(l || '').trim().toLowerCase();
  return ALIASES[k] || k;
}

let worker = null;
let dataDir = null;
/** Dossier de données de l'application (cache des bibliothèques Python). */
function setDataDir(d) {
  dataDir = d;
}
let seq = 0;
let stopping = false;
const pending = new Map();

function getWorker() {
  if (worker) return worker;
  // Le worker est décompressé hors de l'archive asar (voir build.asarUnpack)
  const w = new Worker(path.join(__dirname.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`), 'runner-worker.js'), { env: { ...process.env, CORRECTEUR_DATA: dataDir || '' } });
  worker = w;
  w.loaded = new Set(); // moteurs déjà chargés dans ce worker
  w.unref();
  w.on('message', (m) => {
    const p = pending.get(m.id);
    if (p && m.started) {
      p.start?.();
      return;
    }
    if (p) {
      pending.delete(m.id);
      if (p.language) w.loaded.add(p.language);
      p.resolve(m);
    }
  });
  w.on('error', (err) => {
    for (const p of pending.values()) p.resolve({ ok: false, stdout: '', stderr: String(err.message || err), exitCode: 1 });
    pending.clear();
    if (worker === w) worker = null;
  });
  w.on('exit', () => {
    // Exécutions en attente derrière un programme coupé (boucle infinie) : relancées sur un nouveau moteur
    const waiting = [...pending.entries()].filter(([, p]) => p.w === w);
    if (worker === w) worker = null;
    for (const [id, p] of waiting) {
      pending.delete(id);
      if (stopping) p.resolve({ ok: false, stdout: '', stderr: 'Exécution interrompue.', exitCode: 1, internal: true, category: 'outil', explication: 'Moteur d\'exécution arrêté.' });
      else p.retry();
    }
  });
  return worker;
}

// Bibliothèques Python téléchargées à la première utilisation (délai supplémentaire)
const PY_PACKAGES = /^\s*(?:import|from)\s+(numpy|pandas|matplotlib|scipy|sympy|networkx|sklearn|scikit|PIL|regex|bs4|yaml|lxml|statsmodels|seaborn|pytz|dateutil)\b/m;

/** Délai supplémentaire pour charger le moteur (et les bibliothèques) quand il ne l'est pas encore. */
function loadAllowance(w, language, code) {
  if (language === 'python') return !w.loaded.has('python') || PY_PACKAGES.test(code) ? 50000 : 0;
  if (language === 'sql') return w.loaded.has('sql') ? 0 : 15000;
  return 0;
}

function runBuiltin(language, code, stdin, timeoutMs, files) {
  return new Promise((resolve) => {
    const id = ++seq;
    const msg = { id, language, code, stdin, files };
    let timer = null;
    const send = (w) => {
      // extra : marge pendant l'attente dans la file du worker ; remise à zéro quand l'exécution démarre
      const arm = (extra = 0) => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          pending.delete(id);
          w.terminate(); // boucle infinie : on détruit le worker (il sera recréé)
          if (worker === w) worker = null;
          resolve({ ok: false, stdout: '', stderr: `Temps d'exécution dépassé (${timeoutMs / 1000} s) : boucle infinie ou programme trop lent.`, exitCode: -1, timedOut: true, durationMs: timeoutMs });
        }, timeoutMs + loadAllowance(w, language, code) + extra);
      };
      arm(120000); // sécurité si le worker ne répond plus du tout
      pending.set(id, {
        start: () => arm(),
        w,
        language,
        resolve: (r) => { clearTimeout(timer); resolve(r); },
        // Le worker a été relancé (programme précédent coupé) : on réexécute sur le nouveau
        retry: () => send(getWorker())
      });
      w.postMessage(msg);
    };
    send(getWorker());
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

function runProcess(cmd, args, { cwd, stdin, timeoutMs, env }) {
  return new Promise((resolve) => {
    const t = Date.now();
    const child = spawn(cmd, args, { cwd, windowsHide: true, env: { ...process.env, ...env } });
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

/**
 * Java (lancement direct d'un fichier source) : le lanceur exécute la PREMIÈRE classe du fichier.
 * On place donc en tête la classe qui contient main(), et on retire la déclaration de package.
 */
function prepareJava(code) {
  let src = code.replace(/^\s*package\s+[\w.]+\s*;\s*$/m, '');
  const types = [];
  const re = /(^|\n)([ \t]*(?:(?:public|final|abstract|sealed|non-sealed|static|strictfp)\s+)*(?:class|interface|enum|record)\s+(\w+)[^{]*\{)/g;
  let m;
  while ((m = re.exec(src))) {
    const start = m.index + m[1].length;
    let depth = 0;
    let i = src.indexOf('{', start);
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) break;
    }
    types.push({ name: m[3], start, end: i + 1, text: src.slice(start, i + 1) });
    re.lastIndex = i + 1;
  }
  const main = types.find((t) => /static\s+(?:final\s+)?void\s+main\s*\(/.test(t.text) || /^\s*void\s+main\s*\(\s*\)/m.test(t.text));
  if (main && types[0] !== main) {
    const head = src.slice(0, types[0].start);
    const others = types.filter((t) => t !== main).map((t) => t.text);
    src = `${head}${main.text}\n\n${others.join('\n\n')}\n`;
  }
  return { src, mainClass: main?.name || types[0]?.name || 'Main' };
}

function writeFiles(dir, files) {
  for (const [name, content] of Object.entries(files || {})) {
    const target = path.join(dir, name);
    if (!target.startsWith(dir)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, String(content));
  }
}

/** JavaScript / TypeScript : vrai Node.js (Electron en mode Node), avec require, ESM, setTimeout, stdin… */
async function runNode(language, code, stdin, timeoutMs, dir) {
  const isTs = language === 'typescript';
  const esm = /^\s*(import\s[\s\S]*?from\s|import\s*['"{*]|export\s)/m.test(code) || /^\s*await\s/m.test(code);
  const file = path.join(dir, `main.${isTs ? (esm ? 'mts' : 'ts') : esm ? 'mjs' : 'js'}`);
  fs.writeFileSync(file, code);
  const args = ['--no-warnings', ...(isTs ? ['--experimental-strip-types'] : []), file];
  const env = { ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' };
  const r = await runProcess(process.execPath, args, { cwd: dir, stdin, timeoutMs, env });
  // TypeScript non pris en charge (Node trop ancien) : on retente en retirant les annotations simples
  if (isTs && /strip-types|ERR_UNKNOWN_FILE_EXTENSION|bad option/i.test(r.stderr)) {
    return { ...r, internal: true, category: 'environnement', explication: 'Exécution TypeScript non disponible dans cet environnement.' };
  }
  return r;
}

async function runNative(language, code, stdin, timeoutMs, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'correcteur-run-'));
  try {
    writeFiles(dir, files);
    if (language === 'javascript' || language === 'typescript') return await runNode(language, code, stdin, timeoutMs, dir);
    if (language === 'java') {
      if (!(await hasTool('java', ['-version']))) return unavailable('Java (JDK 11+) n\'est pas installé sur ce PC.');
      const { src, mainClass } = prepareJava(code);
      const file = path.join(dir, `${mainClass}.java`);
      fs.writeFileSync(file, src);
      return await runProcess('java', ['-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8', '-Duser.language=fr', file], { cwd: dir, stdin, timeoutMs: timeoutMs + 5000, env: { JAVA_TOOL_OPTIONS: '' } });
    }
    if (language === 'c' || language === 'cpp') {
      const cc = language === 'c' ? 'gcc' : 'g++';
      if (!(await hasTool(cc))) return unavailable(`Le compilateur ${cc} n'est pas installé sur ce PC (MinGW / MSYS2).`);
      const src = path.join(dir, language === 'c' ? 'main.c' : 'main.cpp');
      const exe = path.join(dir, process.platform === 'win32' ? 'main.exe' : 'main');
      fs.writeFileSync(src, code);
      const kbd = ['-Dgetch=getchar', '-D_getch=getchar', '-Dgetche=getchar', '-D_getche=getchar'];
      const std = language === 'cpp' ? ['-std=c++17'] : [];
      const usesKbd = /\b_?getche?\s*\(/.test(code);
      let comp = await runProcess(cc, [src, '-o', exe, '-lm', ...(usesKbd ? kbd : []), ...std], { cwd: dir, timeoutMs: 30000 });
      // Redirection de getch() refusée par ce compilateur : compilation normale
      if (!comp.ok && usesKbd) comp = await runProcess(cc, [src, '-o', exe, '-lm', ...std], { cwd: dir, timeoutMs: 30000 });
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

async function runCode({ language, code, stdin = '', timeoutMs = 10000, files = {} }) {
  const lang = normalizeLanguage(language);
  const r = BUILTIN.includes(lang) ? await runBuiltin(lang, code, stdin, timeoutMs, files) : await runNative(lang, code, stdin, timeoutMs, files);
  const cls = classifyExecution(lang, r, code, stdin);
  return { language: lang, ...r, internal: cls.internal, category: cls.category, explication: cls.explication };
}

/** Charge Python et PostgreSQL en arrière-plan pour que la 1re exécution soit immédiate. */
async function warmup() {
  await runBuiltin('python', 'pass', '', 10000, {}).catch(() => {});
  await runBuiltin('sql', 'SELECT 1;', '', 10000, {}).catch(() => {});
}

const RUNNABLE = ['python', 'javascript', 'typescript', 'sql', 'java', 'c', 'cpp', 'php'];

async function shutdown() {
  stopping = true;
  if (worker) await worker.terminate();
  worker = null;
  stopping = false;
}

module.exports = { runCode, normalizeLanguage, RUNNABLE, shutdown, setDataDir, prepareJava, warmup };
