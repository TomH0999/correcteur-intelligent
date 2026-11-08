'use strict';
/**
 * Classe le résultat d'une exécution : une erreur due à l'OUTIL (dialecte, module ou fichier absent,
 * entrée non fournie, environnement graphique/navigateur, compilateur absent…) n'est PAS une erreur de
 * l'étudiant et ne doit jamais lui coûter de points.
 */

const READS_INPUT = {
  python: /\binput\s*\(|sys\.stdin/,
  java: /\bScanner\b|BufferedReader|System\.in\b|Console\b/,
  c: /\bscanf\s*\(|\bgetchar\s*\(|\bfgets\s*\(|\bgets\s*\(/,
  cpp: /\bcin\b|\bscanf\s*\(|\bgetline\s*\(/,
  javascript: /\bprompt\s*\(|readline|process\.stdin/,
  typescript: /\bprompt\s*\(|readline|process\.stdin/,
  php: /\bfgets\s*\(\s*STDIN|readline\s*\(|fscanf\s*\(\s*STDIN/
};

const THIRD_PARTY_PY = /\b(numpy|pandas|matplotlib|scipy|sklearn|seaborn|requests|bs4|flask|django|pygame|tkinter|turtle|PIL|cv2|tensorflow|torch|sympy|networkx|plotly|openpyxl|mysql|psycopg2|sqlalchemy|pytest)\b/;

function internal(category, explication) {
  return { internal: true, category, explication };
}

/**
 * @param {string} lang langage normalisé
 * @param {object} r résultat d'exécution { ok, stdout, stderr, timedOut, unavailable, ... }
 * @param {string} code code exécuté
 * @param {string} stdin entrée fournie
 */
function classifyExecution(lang, r, code = '', stdin = '') {
  // Exécution réussie, mais certaines instructions ignorées faute de pouvoir être exécutées (ex. syntaxe SQL non convertible)
  if (r.ok) return r.internal ? { internal: true, category: r.category || 'dialecte', explication: r.explication } : { internal: false, category: 'ok' };
  if (r.internal) return { internal: true, category: r.category || 'outil', explication: r.explication || 'Limite de l\'outil d\'exécution.' };
  const err = `${r.stderr || ''}\n${r.stdout || ''}`;
  const noInput = !String(stdin || '').trim();
  if (r.unavailable) return internal('outil_absent', r.stderr || 'Langage non exécutable sur ce PC.');
  // Programme qui attend une saisie alors qu'aucune entrée n'a été fournie par le test
  if (noInput && READS_INPUT[lang]?.test(code)) {
    if (r.timedOut || /EOFError|NoSuchElementException|EOF when reading|end of file|ERR_USE_AFTER_CLOSE|readline was closed/i.test(err)) {
      return internal('entree_manquante', 'Le programme attend une saisie au clavier qui n\'a pas été fournie par le test : ce n\'est pas une erreur du code.');
    }
  }
  if (/EOFError|NoSuchElementException/.test(err) && READS_INPUT[lang]?.test(code)) {
    return internal('entree_manquante', 'Le test n\'a pas fourni assez de valeurs en entrée pour ce programme.');
  }
  switch (lang) {
    case 'python':
      if (/ModuleNotFoundError|No module named|ImportError/.test(err) && THIRD_PARTY_PY.test(err)) return internal('module_absent', 'Bibliothèque Python non disponible dans l\'environnement d\'exécution intégré.');
      if (/FileNotFoundError|No such file or directory/.test(err)) return internal('fichier_absent', 'Le programme lit un fichier de données qui n\'existe pas dans l\'environnement de test.');
      if (/tkinter|turtle|_tkinter|display|TclError/i.test(err)) return internal('interface_graphique', 'Interface graphique impossible à exécuter dans le test automatique.');
      if (/PythonError: .*pyodide|JsException|OSError: \[Errno 52\]|not supported on this platform|Pyodide/i.test(err)) return internal('environnement', 'Fonction non disponible dans l\'environnement Python intégré.');
      break;
    case 'javascript':
    case 'typescript':
      if (/ReferenceError: (document|window|alert|prompt|confirm|localStorage|sessionStorage|navigator|location|HTMLElement|fetch) is not defined/.test(err)) return internal('environnement_navigateur', 'Code prévu pour un navigateur (DOM, alert…) exécuté hors navigateur.');
      if (/Cannot find module '(?!\.)[^']+'|ERR_MODULE_NOT_FOUND|Cannot find package/.test(err)) return internal('module_absent', 'Paquet npm non installé dans l\'environnement de test.');
      if (/ENOENT/.test(err)) return internal('fichier_absent', 'Le programme lit un fichier absent de l\'environnement de test.');
      if (/ERR_UNKNOWN_FILE_EXTENSION|strip-types|experimental/i.test(err)) return internal('environnement', 'Limite de l\'environnement Node.js intégré.');
      break;
    case 'java':
      if (/can't find main\(String\[\]\) method|could not find or load main class|error: no class declared in source file|should be declared in a file named/i.test(err)) return internal('lancement', 'Problème de lancement du programme Java par l\'outil (classe principale).');
      if (/FileNotFoundException|NoSuchFileException/.test(err)) return internal('fichier_absent', 'Le programme lit un fichier absent de l\'environnement de test.');
      if (/HeadlessException|java\.awt|javafx/i.test(err)) return internal('interface_graphique', 'Interface graphique impossible à exécuter dans le test automatique.');
      if (/package [\w.]+ does not exist/.test(err) && !/package java\./.test(err)) return internal('module_absent', 'Bibliothèque Java externe absente de l\'environnement de test.');
      break;
    case 'c':
    case 'cpp':
      if (/(conio|windows|unistd|graphics|SDL|ncurses)\.h: No such file/i.test(err)) return internal('bibliotheque_systeme', 'En-tête système non disponible sur ce compilateur.');
      if (/undefined reference to `(WinMain|_getch|getch|clrscr)/.test(err)) return internal('bibliotheque_systeme', 'Fonction propre à un autre système non disponible sur ce compilateur.');
      if (/'pause'.*not (found|recognized)|sh: 1: pause/i.test(err) && r.exitCode === 0) return internal('environnement', 'system("pause") n\'est pas disponible ici (sans conséquence).');
      break;
    case 'php':
      if (/Failed to open stream|No such file/.test(err)) return internal('fichier_absent', 'Le programme lit un fichier absent de l\'environnement de test.');
      break;
    default:
  }
  if (r.timedOut) return { internal: false, category: 'temps_depasse', explication: 'Temps dépassé : boucle infinie possible ou programme trop lent (à vérifier).' };
  return { internal: false, category: 'erreur_execution' };
}

module.exports = { classifyExecution, READS_INPUT };
