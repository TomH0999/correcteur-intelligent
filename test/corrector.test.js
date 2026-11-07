const test = require('node:test');
const assert = require('node:assert');
const { correct, normalizeResult, buildName, fitSources, parseJsonLoose } = require('../src/main/corrector');

test('normalisation : note recalculée et ramenée au barème', () => {
  const r = normalizeResult({ note: { obtenue: 7, sur: 10 }, questions: [{ statut: 'bizarre', points_obtenus: '1,5', points_max: 2 }] }, 20);
  assert.equal(r.note.obtenue, 14);
  assert.equal(r.score_pourcentage, 70);
  assert.equal(r.questions[0].statut, 'partiel');
  assert.equal(r.questions[0].points_obtenus, 1.5);
  const r2 = normalizeResult({ questions: [{ points_obtenus: 3, points_max: 4 }, { points_obtenus: 0, points_max: 4 }] }, 20);
  assert.equal(r2.note.obtenue, 7.5);
});

test('nom précis pour l\'historique', () => {
  const r = normalizeResult({ titre: 'TP2 Python', matiere: 'R1.01', type_exercice: 'developpement', note: { obtenue: 15.5, sur: 20 } });
  const n = buildName(r, new Date(2026, 0, 5, 9, 7));
  assert.equal(n, '[Dev] — R1.01 — TP2 Python — 15,5/20 — 2026-01-05 09h07');
});

test('JSON entouré de texte', () => {
  assert.deepEqual(parseJsonLoose('Voici :\n```json\n{"a":1}\n```'), { a: 1 });
});

test('budget de caractères', () => {
  const { sources, truncated } = fitSources([{ text: 'a'.repeat(100) }, { text: 'b'.repeat(10000) }], 1000);
  assert.ok(truncated);
  assert.equal(sources[0].text.length, 100);
  assert.ok(sources[1].text.length < 1100);
});

test('pipeline complet avec API simulée (vision + fallback de modèle)', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body.model);
    const json = (status, obj) => ({ ok: status < 300, status, statusText: '', headers: new Map(), json: async () => obj, text: async () => JSON.stringify(obj) });
    if (Array.isArray(body.messages[0].content)) {
      return json(200, { choices: [{ message: { content: '[copie manuscrite]\n$f\'(x) = 2x$' } }] });
    }
    if (body.model === 'openai/gpt-oss-120b') return json(413, { error: { message: 'Request too large', code: 'rate_limit_exceeded' } });
    assert.match(body.messages[1].content, /f'\(x\) = 2x/);
    return json(200, { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ titre: 'Dérivées', type_exercice: 'maths', note: { obtenue: 18, sur: 20 }, fautes: [{ gravite: 'mineure', description: 'notation' }] }) } }] });
  };
  const out = await correct({
    apiKey: 'test',
    fetchImpl,
    files: [
      { name: 'sujet.txt', parts: [{ type: 'text', text: 'Exercice 1 : dériver f(x)=x²', label: 'sujet.txt' }] },
      { name: 'copie.jpg', parts: [{ type: 'image', mime: 'image/jpeg', base64: 'AAAA', label: 'copie.jpg' }] }
    ]
  });
  assert.equal(out.result.note.obtenue, 18);
  assert.equal(out.result.type_exercice, 'maths');
  assert.equal(out.model, 'llama-3.3-70b-versatile');
  assert.ok(out.warnings.some((w) => /modèle principal/.test(w)));
  assert.equal(out.sources.length, 2);
});
