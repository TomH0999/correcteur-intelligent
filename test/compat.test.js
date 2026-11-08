/**
 * Corpus de code CORRECT d'étudiant (Oracle, MySQL, PostgreSQL, SQL Server, Python, JavaScript, TypeScript,
 * Java, C, C++) : aucune exécution ne doit produire une « fausse erreur » comptée contre l'étudiant.
 * Un cas peut être classé « limite de l'outil » (non compté) seulement s'il est marqué allowInternal.
 */
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const runner = require('../src/main/runner');
const cases = require('./fixtures/compat-cases.js');

const has = (cmd, args) => {
  try { execFileSync(cmd, args, { stdio: 'ignore', timeout: 5000 }); return true; } catch { return false; }
};
const tools = { java: has('java', ['-version']), gcc: has('gcc', ['--version']), 'g++': has('g++', ['--version']) };

test('corpus de compatibilité : pas de fausse erreur', { timeout: 600000 }, async (t) => {
  t.after(() => runner.shutdown());
  for (const c of cases) {
    if (c.needs && !tools[c.needs]) continue;
    await t.test(`[${c.lang}] ${c.name}`, async () => {
      const r = await runner.runCode({ language: c.lang, code: c.code, stdin: c.stdin || '', files: c.files, timeoutMs: 15000 });
      if (c.expectError) {
        assert.ok(!r.ok, 'une vraie erreur de l\'étudiant doit rester une erreur');
        assert.ok(!r.internal, 'une vraie erreur ne doit pas être excusée comme limite de l\'outil');
        return;
      }
      const ok = (r.ok && c.expect.test(r.stdout || '')) || (c.allowInternal && r.internal);
      assert.ok(ok, `${r.internal ? `(limite : ${r.category}) ` : ''}${(r.stdout || '').slice(0, 300)}\n${(r.stderr || '').slice(0, 500)}`);
    });
  }
});
