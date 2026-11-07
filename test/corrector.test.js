const test = require('node:test');
const assert = require('node:assert');
const { correct, normalizeResult, buildName, fitSources, parseJsonLoose, hasRunnableCode } = require('../src/main/corrector');
const { createProvider } = require('../src/main/providers');
const { ModelResolver } = require('../src/main/models');
const runner = require('../src/main/runner');

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
  assert.equal(buildName(r, new Date(2026, 0, 5, 9, 7)), '[Dev] — R1.01 — TP2 Python — 15,5/20 — 2026-01-05 09h07');
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

test('détection de code exécutable', () => {
  assert.ok(hasRunnableCode([{ text: '```python\nprint(1)\n```' }]));
  assert.ok(!hasRunnableCode([{ text: 'Calculer la dérivée de f' }]));
});

/** Faux serveur Groq : liste de modèles, vision réservée à un modèle, 413 sur le modèle principal. */
function fakeGroq(log) {
  const json = (status, obj) => ({ ok: status < 300, status, statusText: '', headers: new Map(), json: async () => obj, text: async () => JSON.stringify(obj) });
  return async (url, init) => {
    if (url.endsWith('/models')) {
      return json(200, { data: ['openai/gpt-oss-120b', 'qwen/qwen3-32b', 'qwen/qwen3.8-27b', 'whisper-large-v3', 'meta-llama/llama-guard-4-12b'].map((id) => ({ id })) });
    }
    const body = JSON.parse(init.body);
    const hasImage = body.messages.some((m) => Array.isArray(m.content) && m.content.some((c) => c.type === 'image_url'));
    log.push({ model: body.model, hasImage, system: body.messages[0].content.slice(0, 40) });
    if (hasImage) {
      if (body.model !== 'qwen/qwen3.8-27b') return json(400, { error: { message: 'messages[0].content must be a string', code: 'invalid' } });
      return json(200, { choices: [{ message: { content: '[copie manuscrite]\n$f\'(x) = 2x$\n```python\ndef f(x): return 2*x\n```' } }] });
    }
    if (/tests d'exécution/.test(body.messages[0].content)) {
      return json(200, { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ executions: [{ but: 'f(3)', langage: 'python', code: 'def f(x): return 2*x\nprint(f(3))', sortie_attendue: '6' }] }) } }] });
    }
    if (body.model === 'openai/gpt-oss-120b') return json(413, { error: { message: 'Request too large', code: 'rate_limit_exceeded' } });
    const user = body.messages[1].content;
    assert.match(user, /f'\(x\) = 2x/);
    assert.match(user, /RÉSULTATS D'EXÉCUTION RÉELLE/);
    assert.match(user, /Sortie obtenue :\n6/);
    return json(200, { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ titre: 'Dérivées', type_exercice: 'maths', note: { obtenue: 18, sur: 20 }, fautes: [{ gravite: 'mineure', description: 'notation', notion: 'dérivée' }] }) } }] });
  };
}

test('pipeline complet : modèles détectés en direct, vision testée, exécution réelle, bascule de modèle', async () => {
  const log = [];
  const ai = createProvider('groq', 'test', { fetchImpl: fakeGroq(log) });
  let cache = {};
  const resolver = new ModelResolver({ get: () => cache, set: (c) => { cache = c; } });
  const corr = await resolver.resolveCorrection(ai, 'meta-llama/llama-4-scout-17b-16e-instruct');
  assert.equal(corr.main, 'openai/gpt-oss-120b');
  assert.ok(corr.notes[0].includes("n'existe plus"));
  assert.ok(!corr.fallbacks.includes('meta-llama/llama-guard-4-12b'));
  const vision = await resolver.resolveVision(ai, 'auto', corr.main);
  assert.equal(vision.model, 'qwen/qwen3.8-27b');
  assert.equal(cache.groq.vision['qwen/qwen3.8-27b'], true);
  const ctx = { ai, models: { main: corr.main, fallbacks: corr.fallbacks, vision: vision.model }, s: { ...require('../src/main/corrector').DEFAULTS }, progress: () => {}, notes: [] };
  const out = await correct(ctx, {
    files: [
      { name: 'sujet.txt', parts: [{ type: 'text', text: 'Exercice 1 : dériver f(x)=x² ; écrire f en Python', label: 'sujet.txt' }] },
      { name: 'copie.jpg', parts: [{ type: 'image', mime: 'image/jpeg', base64: 'AAAA', label: 'copie.jpg' }] }
    ],
    runCode: runner.runCode
  });
  await runner.shutdown();
  assert.equal(out.result.note.obtenue, 18);
  assert.equal(out.model, 'qwen/qwen3-32b');
  assert.equal(out.result.executions[0].stdout.trim(), '6');
  assert.ok(out.warnings.some((w) => /modèle principal/.test(w)));
});

test('aucun modèle de vision : OCR local signalé', async () => {
  const ai = createProvider('groq', 'test', { fetchImpl: async (url) => ({ ok: true, status: 200, headers: new Map(), json: async () => ({ data: [{ id: 'openai/gpt-oss-120b' }] }) }) });
  let cache = {};
  const resolver = new ModelResolver({ get: () => cache, set: (c) => { cache = c; } });
  const v = await resolver.resolveVision(ai, 'auto', 'openai/gpt-oss-120b');
  assert.equal(v.model, null);
  assert.match(v.notes[0], /OCR local/);
});

test('gros devoir + petit modèle (sortie max 4096, 8000 jetons/min) : correction découpée sans erreur', async () => {
  const { LimitBook } = require('../src/main/limits');
  const calls = [];
  const json = (status, obj) => ({ ok: status < 300, status, statusText: '', headers: new Map(), json: async () => obj, text: async () => JSON.stringify(obj) });
  const fetchImpl = async (url, init) => {
    if (url.endsWith('/models')) return json(200, { data: [{ id: 'small-model', context_window: 131072, max_completion_tokens: 4096 }] });
    const body = JSON.parse(init.body);
    const sys = body.messages[0].content;
    const user = body.messages[1].content;
    if (body.max_completion_tokens > 4096) {
      return json(400, { error: { message: '`max_completion_tokens` must be less than or equal to `4096`, the maximum value for `max_completion_tokens` is less than the `context_window` for this model', type: 'invalid_request_error' } });
    }
    const requested = Math.ceil((sys.length + user.length) / 4) + body.max_completion_tokens;
    if (requested > 8000) {
      return json(413, { error: { message: `Request too large for model \`small-model\` in organization on tokens per minute (TPM): Limit 8000, Requested ${requested}, please reduce your message size and try again.`, code: 'rate_limit_exceeded' } });
    }
    let content;
    if (sys.includes('Découpe-le en segments')) {
      // Chaque ligne « Question N » ouvre un segment d'énoncé, « Réponse N » un segment de réponse
      const segs = [];
      user.split('\n').forEach((l) => {
        const m = l.match(/^L(\d+)\| (Question|Réponse) (\d+)/);
        if (m) segs.push({ de: Number(m[1]), a: Number(m[1]), nature: m[2] === 'Question' ? 'enonce' : 'reponse', question: m[3] });
      });
      calls.push('index');
      content = { segments: segs };
    } else if (sys.includes('UNE PARTIE')) {
      const nums = [...user.matchAll(/### Question (\d+)/g)].map((m) => m[1]);
      calls.push(`lot:${nums.join(',')}`);
      content = { questions: nums.map((n) => ({ numero: n, intitule: `Q${n}`, statut: 'correct', points_obtenus: 2, points_max: 2, commentaire: 'ok' })), fautes: [], correction_modele: `Corrigé ${nums.join(',')}` };
    } else if (sys.includes('synthèse finale')) {
      calls.push('synthese');
      content = { titre: 'Gros devoir', matiere: 'Algo', type_exercice: 'algorithmique', resume: 'Bien.' };
    } else {
      calls.push('single');
      content = { titre: 'x' };
    }
    return json(200, { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }] });
  };
  let limitsStore = {};
  const book = new LimitBook({ get: () => limitsStore, set: (v) => { limitsStore = v; } });
  const ai = createProvider('groq', 'k', { fetchImpl, book });
  await ai.listModels();
  // Énoncé et réponses volumineux : 12 questions de ~2 500 caractères chacune
  const filler = (n) => ` ${'détail '.repeat(n)}`;
  const enonce = Array.from({ length: 12 }, (_, i) => `Question ${i + 1} : écrire la fonction f${i + 1}.${filler(300)}`).join('\n');
  const reponses = Array.from({ length: 12 }, (_, i) => `Réponse ${i + 1} : def f${i + 1}(): pass${filler(300)}`).join('\n');
  const ctx = {
    ai, models: { main: 'small-model', fallbacks: [] }, limits: (m) => book.limits('groq', m),
    s: { ...require('../src/main/corrector').DEFAULTS, executeCode: false }, progress: () => {}, notes: []
  };
  const out = await correct(ctx, { files: [
    { name: 'sujet.txt', parts: [{ type: 'text', text: enonce, label: 'sujet.txt' }] },
    { name: 'copie.txt', parts: [{ type: 'text', text: reponses, label: 'copie.txt' }] }
  ] });
  assert.equal(out.mode, 'chunked');
  assert.equal(out.result.questions.length, 12);
  assert.equal(out.result.note.obtenue, 20);
  assert.equal(out.result.titre, 'Gros devoir');
  assert.ok(calls.filter((c) => c.startsWith('lot')).length >= 2, calls.join(' '));
  assert.equal(book.limits('groq', 'small-model').maxOut, 4096);
  assert.equal(book.limits('groq', 'small-model').tpm, 8000);
});
