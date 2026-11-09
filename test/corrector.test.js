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
    if (body.model === 'openai/gpt-oss-120b') return json(413, { error: { message: 'Request too large', code: 'rate_limit_exceeded' } });
    const user = body.messages[1].content;
    assert.match(user, /f'\(x\) = 2x/);
    // Les tests d'exécution sont demandés DANS l'appel de correction (plus d'appel séparé)
    assert.match(body.messages[0].content, /TESTS D'EXÉCUTION/);
    assert.doesNotMatch(body.messages[0].content, /correction_modele/);
    return json(200, { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ titre: 'Dérivées', type_exercice: 'maths', note: { obtenue: 18, sur: 20 }, questions: [{ numero: '1', intitule: 'f', statut: 'correct', points_obtenus: 18, points_max: 20 }], fautes: [{ gravite: 'mineure', description: 'notation', notion: 'dérivée' }], tests: [{ question: '1', but: 'f(3)', langage: 'python', code: 'def f(x): return 2*x\nprint(f(3))', sortie_attendue: '6' }] }) } }] });
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
  // Test conforme à la notation : aucun appel de révision
  assert.ok(!log.some((l) => /révis|Confronte/.test(l.system)));
  assert.ok(out.result.timings.total >= 0);
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

// ------------------------------------------------------------ Rattachement des réponses aux questions
const C = require('../src/main/corrector');
const ctxOf = (handler, extra = {}) => ({
  ai: { chat: async (req) => ({ content: JSON.stringify(handler(req)), finishReason: 'stop', model: req.model }) },
  models: { main: 'm', fallbacks: [] }, limits: () => ({ context: 128000, maxOut: 8000, tpm: Infinity }),
  s: { ...C.DEFAULTS }, progress: () => {}, notes: [], ...extra
});

test('numéros canoniques : Q3, 3), Exercice 2 – Question 3.b, II.1', () => {
  assert.equal(C.canonQ('Q3'), '3');
  assert.equal(C.canonQ('3)'), '3');
  assert.equal(C.canonQ('Exercice 2 – Question 3.b'), '2.3.b');
  assert.equal(C.canonQ('II.1'), '2.1');
  assert.equal(C.canonQ('Ex2 Q1'), '2.1');
  assert.equal(C.canonQ('1a'), '1.a');
  assert.equal(C.canonQ('général'), 'general');
});

test('découpage local : énoncé hiérarchique et réponses « Q1 » (blocs de code ignorés)', () => {
  const en = C.segmentLocal('Exercice 1\nQuestion 1 : f\nQuestion 2 : g\nExercice 2\nQuestion 1 : SQL'.split('\n'), 'enonce');
  assert.deepEqual(en.map((g) => C.canonQ(g.question)), ['1', '1.1', '1.2', '2', '2.1']);
  const rep = C.segmentLocal('Q1) def f(): pass\nQ2) x\n```\n1) pas un repère\n```\nQ3) SELECT 1'.split('\n'), 'reponse');
  assert.deepEqual(rep.map((g) => g.question), ['1', '2', '3']);
  assert.equal(C.segmentLocal(['texte libre', 'sans numéro'], 'reponse'), null);
});

test('réponses numérotées autrement que l\'énoncé : rattachées à la bonne question (gros devoir)', async () => {
  const { AIError } = require('../src/main/providers');
  const lots = [];
  const ctx = ctxOf((req) => {
    const sys = req.system;
    if (sys.includes('UNE PARTIE')) {
      const blocks = req.messages[0].content.split('### Question ').slice(1);
      lots.push(...blocks);
      return { questions: blocks.map((b) => {
        const vide = /aucune réponse trouvée/.test(b);
        return { numero: b.split('\n')[0], intitule: 'q', statut: vide ? 'non_traite' : 'correct', points_obtenus: vide ? 0 : 2, points_max: 2 };
      }) };
    }
    if (sys.includes('synthèse finale')) return { titre: 'Devoir' };
    // L'appel unique est « trop gros » : on passe en correction découpée
    throw new AIError('Request too large for model', 413, 'rate_limit_exceeded');
  });
  const enonce = ['Exercice 1', 'Question 1 : écrire f', 'Question 2 : écrire g', 'Exercice 2', 'Question 1 : requête A', 'Question 2 : requête B'].join('\n');
  const copie = ['Q1) def f(): return 1', 'Q2) def g(): return 2', 'Q3) SELECT a FROM t', 'Q4) SELECT b FROM t'].join('\n');
  const out = await C.recorrect(ctx, { sources: [
    { file: 'sujet.txt', role: 'auto', label: 'sujet.txt', kind: 'text', text: enonce },
    { file: 'mes_reponses.txt', role: 'auto', label: 'mes_reponses.txt', kind: 'text', text: copie }
  ] });
  assert.equal(out.mode, 'chunked');
  assert.equal(lots.length, 4, lots.join('\n---\n'));
  assert.ok(lots.every((l) => !/aucune réponse trouvée/.test(l)), lots.join('\n---\n'));
  assert.ok(lots.find((l) => l.startsWith('2.1')).includes('SELECT a FROM t'));
  assert.equal(out.result.note.obtenue, 20);
});

test('alignement : Q1..Q4 rattachées à 1.1, 1.2, 2.1, 2.2 (et pas aux en-têtes d\'exercice)', async () => {
  const ctx = ctxOf(() => { throw new Error('aucun appel IA attendu'); });
  const U = (key, e, r) => ({ key, label: key, enonce: e ? [`énoncé ${key}`] : [], reponse: r ? [`réponse ${key}`] : [], bareme: [] });
  const units = await C.alignUnits(ctx, [U('1.1', 1, 0), U('1.2', 1, 0), U('2.1', 1, 0), U('2.2', 1, 0), U('1', 0, 1), U('2', 0, 1), U('3', 0, 1), U('4', 0, 1)]);
  assert.deepEqual(units.map((u) => [u.key, u.reponse[0]]), [['1.1', 'réponse 1'], ['1.2', 'réponse 2'], ['2.1', 'réponse 3'], ['2.2', 'réponse 4']]);
});

test('alignement par l\'IA quand la numérotation ne suffit pas', async () => {
  const ctx = ctxOf((req) => {
    assert.match(req.system, /rattaches les réponses/);
    return { correspondances: [{ reponse: 'R1', question: 'b' }, { reponse: 'R2', question: 'a' }, { reponse: 'R3', question: null }] };
  });
  const U = (key, e, r) => ({ key, label: key, enonce: e ? [`énoncé ${key}`] : [], reponse: r ? [`réponse ${key}`] : [], bareme: [] });
  const units = await C.alignUnits(ctx, [U('a', 1, 0), U('b', 1, 0), U('x', 0, 1), U('y', 0, 1), U('z', 0, 1)]);
  assert.equal(units.find((u) => u.key === 'b').reponse[0], 'réponse x');
  assert.equal(units.find((u) => u.key === 'a').reponse[0], 'réponse y');
  assert.ok(units.find((u) => u.key === 'z'));
});

test('rattrapage : questions marquées « non traitée » à tort retrouvées, note recalculée (bug 6/100)', async () => {
  const seen = [];
  const ctx = ctxOf((req) => {
    seen.push(req.system.slice(0, 40));
    if (/TESTS D'EXÉCUTION|IDENTIFIE/.test(req.system)) {
      // Première lecture : le modèle n'a pas vu que « Q2 », « Q3 » répondent à « Exercice 1 – 2/3 »
      return { titre: 'TD', note: { obtenue: 1.2, sur: 20 }, questions: [
        { numero: '1.1', intitule: 'a', statut: 'correct', points_obtenus: 2, points_max: 2 },
        { numero: '1.2', intitule: 'b', statut: 'non_traite', points_obtenus: 0, points_max: 4 },
        { numero: '1.3', intitule: 'c', statut: 'non_traite', points_obtenus: 0, points_max: 4 }
      ], fautes: [{ question: '1.2', description: 'question non traitée' }] };
    }
    assert.match(req.system, /non traitée/);
    assert.match(req.messages[0].content, /Q2\) SELECT/);
    return { questions: [
      { numero: '1.2', intitule: 'b', statut: 'correct', points_obtenus: 4, points_max: 4, commentaire: 'juste' },
      { numero: '1.3', intitule: 'c', statut: 'partiel', points_obtenus: 3, points_max: 4, commentaire: 'presque' }
    ], fautes: [{ question: '1.3', gravite: 'mineure', description: 'alias manquant' }] };
  });
  const { result } = await C.recorrect(ctx, { sources: [
    { file: 'sujet.txt', role: 'enonce', label: 'sujet.txt', kind: 'text', text: 'Exercice 1\n1. a\n2. b\n3. c' },
    { file: 'copie.txt', role: 'reponse', label: 'copie.txt', kind: 'text', text: `Q1) réponse a ${'x'.repeat(60)}\nQ2) SELECT nom FROM client WHERE ville = 'Paris';\nQ3) SELECT COUNT(*) FROM commande GROUP BY client_id;` }
  ] });
  assert.equal(seen.length, 2);
  assert.equal(result.questions.filter((q) => q.statut === 'non_traite').length, 0);
  assert.equal(result.note.obtenue, 18); // (2+4+3)/10 * 20
  assert.ok(!result.fautes.some((f) => /non traitée/.test(f.description)));
  assert.ok(ctx.notes.some((n) => /retrouvées/.test(n)));
});

test('révision par les tests seulement si un test contredit la notation', async () => {
  const calls = [];
  const ctx = ctxOf((req) => {
    calls.push(req.system.includes('RÉELLEMENT exécuté') ? 'revision' : 'correction');
    if (req.system.includes('RÉELLEMENT exécuté')) return { questions: [{ numero: '1', intitule: 'f', statut: 'incorrect', points_obtenus: 0, points_max: 2 }], fautes: [{ question: '1', description: 'f(3) renvoie 7' }] };
    return { titre: 'T', questions: [{ numero: '1', intitule: 'f', statut: 'correct', points_obtenus: 2, points_max: 2 }], fautes: [], tests: [{ question: '1', langage: 'python', code: 'print(7)', sortie_attendue: '6' }] };
  });
  const runCode = async () => ({ language: 'python', ok: true, stdout: '7\n', stderr: '', exitCode: 0 });
  const { result } = await C.recorrect(ctx, { sources: [{ file: 'c.py', role: 'auto', label: 'c.py', kind: 'text', text: '```python\ndef f(x): return x+4\n```' }], runCode });
  assert.deepEqual(calls, ['correction', 'revision']);
  assert.equal(result.note.obtenue, 0);
  assert.equal(result.executions.length, 1);
});

test('sorties comparées sans tenir compte de la mise en forme', () => {
  assert.ok(C.outputsMatch('6', '6\n'));
  assert.ok(C.outputsMatch('Alice | 3\nBob | 5', ' nom  | n\n-----\nBob | 5\nAlice | 3\n(2 ligne(s))'));
  assert.ok(!C.outputsMatch('6', '7'));
});

test('résultat partiel lu pendant le flux', () => {
  const p = C.extractPartial('{"titre":"TD SQL","note":{"obtenue":12,"sur":20},"questions":[{"numero":"1","intitule":"a","statut":"correct","points_obtenus":2,"points_max":2},{"numero":"2","intit');
  assert.equal(p.titre, 'TD SQL');
  assert.equal(p.note.obtenue, 12);
  assert.equal(p.questions.length, 1);
});

test('rôle deviné d\'après le nom du fichier', () => {
  assert.equal(C.roleHint({ file: 'Mes_réponses_TD3.pdf' }), 'reponse');
  assert.equal(C.roleHint({ file: 'sujet-TD3.pdf' }), 'enonce');
  assert.equal(C.roleHint({ file: 'bareme.pdf' }), 'bareme');
  assert.equal(C.roleHint({ file: 'scan.jpg', role: 'enonce' }), 'enonce');
});
