const test = require('node:test');
const assert = require('node:assert');
const C = require('../src/main/claude');
const { Database } = require('../src/main/db');

const compact = (extra = {}) => ({
  ci: 1, titre: 'DS SQL', matiere: 'R1.05 Bases de données et SQL', sur: 20, appr: 'Bien', resume: 'Solide.',
  q: [
    { n: '1', t: 'Liste des clients', s: 'c', p: 4, m: 4, c: '' },
    { n: '2', t: 'Commandes par client', s: 'p', p: 2, m: 4, c: 'HAVING manquant', sol: '```sql\nSELECT client_id, COUNT(*) FROM commande GROUP BY client_id HAVING COUNT(*) > 2;\n```' },
    { n: '3', t: 'Sous-requête', s: 'n', p: 0, m: 2, c: 'Pas de réponse', sol: '`SELECT … WHERE id IN (…)`' }
  ],
  f: [{ q: '2', g: 2, cat: 'logique', no: 'HAVING', d: 'Filtre sur un agrégat dans WHERE', x: 'WHERE COUNT(*) > 2', co: 'HAVING COUNT(*) > 2' }],
  pf: ['Jointures maîtrisées'], am: [['Agrégats', 'Revoir WHERE vs HAVING']], rv: [['HAVING', 'h', 'Erreur à l\'examen']],
  fi: [['WHERE ou HAVING pour filtrer un COUNT ?', 'HAVING']], mc: ['SQL', 'HAVING'],
  ...extra
});
const wrap = (obj) => `Voici ta correction :\n\n\`\`\`json\n${JSON.stringify(obj, null, 1)}\n\`\`\`\n\nBon courage !`;

test('prompt complet : règles du type et de la matière, schéma compact, peu de jetons', () => {
  const p = C.buildPrompt({ type: 'controle', matiere: 'R1.05' });
  assert.match(p, /Corrige ce contrôle de R1\.05 Bases de données et SQL/);
  assert.match(p, /Contrôle noté/);
  assert.match(p, /BDD : teste chaque requête/);
  assert.match(p, /"ci":1/);
  assert.match(p, /cherche dans TOUTE la copie/);
  assert.ok(C.estimateTokens(p) < 900, `prompt trop long : ${C.estimateTokens(p)} jetons`);
  const qcm = C.buildPrompt({ type: 'qcm', matiere: 'R1.06', negatif: '-0,5' });
  assert.match(qcm, /QCM : une entrée/);
  assert.match(qcm, /Réponse fausse : -0,5/);
  assert.match(qcm, /Maths : refais chaque calcul/);
  assert.match(C.buildPrompt({ type: 'annale', matiere: 'R1.01' }), /Pièces jointes : le sujet/);
});

test('mode projet : prompt de quelques lignes, instructions complètes une seule fois', () => {
  const p = C.buildPrompt({ type: 'blanc', matiere: 'R2.05', project: true, consignes: 'exercice 2 seulement' });
  assert.ok(C.estimateTokens(p) < 90, `prompt projet trop long : ${C.estimateTokens(p)}`);
  assert.match(p, /Contrôle blanc — R2\.05 Services réseaux/);
  assert.match(p, /exercice 2 seulement/);
  const instr = C.projectInstructions();
  for (const t of C.TYPES) assert.ok(instr.includes(t.label), t.label);
  assert.match(instr, /Réseaux : recalcule adresses/);
  assert.match(instr, /"ci":1/);
});

test('import du format compact : note recalculée, solutions, fiches, priorités', () => {
  const { result, flashcards, warnings } = C.parseClaudeResult(wrap(compact()));
  assert.equal(result.note.obtenue, 6 / 10 * 20);
  assert.equal(result.note.sur, 20);
  assert.equal(result.questions.length, 3);
  assert.deepEqual(result.questions.map((q) => q.statut), ['correct', 'partiel', 'non_traite']);
  assert.equal(result.fautes[0].gravite, 'moyenne');
  assert.equal(result.a_revoir[0].priorite, 'haute');
  assert.equal(result.ameliorations[0].titre, 'Agrégats');
  assert.equal(result.type_exercice, 'base_de_donnees'); // déduit de la matière
  assert.match(result.correction_modele, /Question 2/);
  assert.ok(!/Question 1 /.test(result.correction_modele));
  assert.equal(result.solutions['2'].includes('HAVING'), true);
  assert.equal(flashcards.length, 1);
  assert.deepEqual(warnings, []);
});

test('import robuste : texte autour, bloc non fermé, note annoncée incohérente', () => {
  const half = `Correction :\n\`\`\`json\n${JSON.stringify(compact())}`;
  assert.equal(C.parseClaudeResult(half).result.questions.length, 3);
  const bad = C.parseClaudeResult(wrap(compact({ note: [18, 20] })));
  assert.equal(bad.result.note.obtenue, 12);
  assert.ok(bad.warnings.some((w) => /somme des points/.test(w)));
  assert.throws(() => C.parseClaudeResult('Je ne peux pas lire la copie.'), /Aucun bloc JSON/);
  // Format complet (ancien) accepté aussi
  const full = C.parseClaudeResult(JSON.stringify({ titre: 'X', note: { obtenue: 10, sur: 20 }, questions: [{ numero: '1', statut: 'partiel', points_obtenus: 1, points_max: 2 }] }));
  assert.equal(full.result.note.obtenue, 10);
});

test('corrigé de sujet (sans copie) : reconnu, solutions conservées', () => {
  const out = C.parseClaudeResult(wrap({ ci: 1, titre: 'Annale 2025', sur: 20, q: [{ n: '1', t: 'Dériver', s: 'n', p: 0, m: 5, sol: "$f'(x)=2x$" }], f: [], fi: [['Dérivée de x²', '2x']] }), { typeId: 'annale' });
  assert.ok(out.annale);
  assert.match(out.result.correction_modele, /2x/);
});

test('détection dans le presse-papiers et lien vers Claude', () => {
  assert.ok(C.looksLikeResult(wrap(compact())));
  assert.ok(!C.looksLikeResult('{"a":1}'));
  assert.match(C.claudeUrl('Corrige'), /^https:\/\/claude\.ai\/new\?q=Corrige$/);
  assert.equal(C.claudeUrl('x'.repeat(8000)), 'https://claude.ai/new');
  assert.equal(C.claudeUrl('x', { projectUrl: 'https://claude.ai/project/abc' }), 'https://claude.ai/project/abc');
  assert.equal(C.claudeUrl('x', { projectUrl: 'https://evil.example/' }), 'https://claude.ai/new?q=x');
});

test('suites : réexplication et entraînement ciblés sur les erreurs', () => {
  const { result } = C.parseClaudeResult(wrap(compact()));
  const rec = { result };
  assert.match(C.followUpPrompt('explain', rec, 'HAVING'), /Je bloque surtout sur : HAVING/);
  assert.match(C.followUpPrompt('similar', rec), /format JSON "ci"/);
  assert.match(C.followUpPrompt('explain', rec), /2 \(2\/4\) Commandes par client/);
  const t = C.trainingPrompt({ notions: [{ notion: 'HAVING', count: 3 }], matiere: 'R1.05', type: 'blanc' });
  assert.match(t, /HAVING \(3 erreur/);
  assert.match(t, /contrôle blanc/);
});

test('base : correction Claude enregistrée avec lien, fichiers joints et type, filtrable', async () => {
  const db = await new Database(null).open();
  const { result } = C.parseClaudeResult(wrap(compact()));
  const id = db.saveCorrection({ name: 'DS SQL', result, origin: 'claude', claudeUrl: 'https://claude.ai/chat/1', attachments: [{ name: 'copie.pdf', path: 'attachments/u/copie.pdf' }], evalType: 'controle', files: [] });
  const rec = db.getCorrection(id);
  assert.equal(rec.origin, 'claude');
  assert.equal(rec.claude_url, 'https://claude.ai/chat/1');
  assert.equal(rec.attachments[0].name, 'copie.pdf');
  assert.equal(db.listCorrections({ evalType: 'controle' }).length, 1);
  assert.equal(db.listCorrections({ evalType: 'qcm' }).length, 0);
  assert.equal(db.listCorrections({ search: 'having' }).length, 1);
  db.updateCorrection(id, { claudeUrl: 'https://claude.ai/chat/2' });
  assert.equal(db.getCorrection(id).claude_url, 'https://claude.ai/chat/2');
  // Fusion d'une sauvegarde : champs Claude conservés
  const other = await new Database(null).open();
  other.mergeAll(db.exportAll());
  const copy = other.listCorrections({})[0];
  assert.equal(copy.origin, 'claude');
  assert.equal(other.getCorrection(copy.id).claude_url, 'https://claude.ai/chat/2');
});

test('le prompt copié n\'est pas pris pour une réponse de Claude', () => {
  const p = C.buildPrompt({ type: 'controle', matiere: 'R1.05' });
  assert.ok(!C.looksLikeResult(p));
  assert.ok(!C.looksLikeResult(C.buildPrompt({ type: 'qcm', project: true })));
  assert.throws(() => C.parseClaudeResult(p), /prompt que tu as collé/);
  // Une vraie réponse reste reconnue, même si l'utilisateur a copié le prompt avec
  assert.ok(C.looksLikeResult(wrap(compact())));
});
