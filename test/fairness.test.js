const test = require('node:test');
const assert = require('node:assert');
const { prepareScript, splitStatements } = require('../src/main/sqlcompat');
const { classifyExecution } = require('../src/main/execclass');
const { normalizeResult, buildSystemPrompt, DEFAULTS } = require('../src/main/corrector');
const { prepareJava } = require('../src/main/runner');

test('découpage SQL*Plus : commandes client ignorées, blocs PL/SQL gardés entiers', () => {
  const { statements, skipped } = splitStatements("SET SERVEROUTPUT ON\nPROMPT go\nSELECT 'a;b' FROM dual;\nBEGIN\n  x := 1;\n  y := 2;\nEND;\n/\nSELECT 1 FROM dual;");
  assert.equal(skipped.length, 2);
  assert.equal(statements.length, 3);
  assert.match(statements[1], /x := 1;\s+y := 2;/);
});

test('traductions Oracle / MySQL / SQL Server', () => {
  const sql = (s) => prepareScript(s).items.map((i) => i.sql.join(';')).join('\n');
  assert.match(sql('SELECT a FROM t MINUS SELECT a FROM u;'), /EXCEPT/);
  assert.match(sql("SELECT NVL(a, 'x'), DECODE(b, 1, 'un', 'autre') FROM t;"), /COALESCE\(a, 'x'\)[\s\S]*CASE WHEN \(b\) = 1 THEN 'un' ELSE 'autre' END/);
  assert.match(sql('SELECT * FROM t WHERE ROWNUM <= 3;'), /LIMIT 3/);
  assert.match(sql('SELECT TOP 2 * FROM t;'), /LIMIT 2/);
  assert.match(sql('INSERT INTO t VALUES (s.NEXTVAL);'), /nextval\('s'\)/);
  assert.match(sql('CREATE TABLE t (id INT AUTO_INCREMENT PRIMARY KEY) ENGINE=InnoDB;'), /SERIAL\s+PRIMARY KEY\)$/);
  // Le texte des chaînes n'est jamais modifié
  assert.match(sql("SELECT 'MINUS NVL(x)' FROM dual;"), /'MINUS NVL\(x\)'/);
});

test('classement : erreurs de l\'outil excusées, vraies erreurs gardées', () => {
  assert.equal(classifyExecution('python', { ok: false, stderr: 'EOFError: EOF when reading a line' }, 'x = input()', '').category, 'entree_manquante');
  assert.equal(classifyExecution('python', { ok: false, stderr: "ModuleNotFoundError: No module named 'numpy'" }, 'import numpy').internal, true);
  assert.equal(classifyExecution('javascript', { ok: false, stderr: 'ReferenceError: document is not defined' }, '').internal, true);
  assert.equal(classifyExecution('java', { ok: false, stderr: 'java.util.NoSuchElementException' }, 'new Scanner(System.in)', '').internal, true);
  assert.equal(classifyExecution('python', { ok: false, stderr: 'ZeroDivisionError: division by zero' }, 'print(1/0)').internal, false);
  assert.equal(classifyExecution('python', { ok: false, stderr: "NameError: name 'x' is not defined" }, 'print(x)').internal, false);
});

test('Java : la classe contenant main passe en premier, package retiré', () => {
  const { src, mainClass } = prepareJava('package a.b;\nclass Aide { int x; }\npublic class Appli {\n  public static void main(String[] a) {}\n}\n');
  assert.equal(mainClass, 'Appli');
  assert.ok(src.indexOf('class Appli') < src.indexOf('class Aide'));
  assert.ok(!/package/.test(src));
});

test('règles d\'équité dans le prompt + fautes accusant l\'outil retirées', () => {
  assert.match(buildSystemPrompt(DEFAULTS), /MINUS[\s\S]*LIMITE DE L'OUTIL/);
  const r = normalizeResult({
    identification: {},
    fautes: [
      { description: 'MINUS n\'est pas reconnu par SQLite, utilise EXCEPT.', gravite: 'majeure' },
      { description: 'La jointure oublie les clients sans commande.', gravite: 'moyenne' }
    ]
  });
  assert.equal(r.fautes.length, 1);
  assert.match(r.fautes[0].description, /jointure/);
  assert.match(r.identification.remarques, /outil/);
});
