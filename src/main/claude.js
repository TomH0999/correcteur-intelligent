'use strict';
/**
 * Correction avec Claude (claude.ai) : l'application prépare un prompt prêt à coller, Claude corrige,
 * puis tu recopies sa réponse dans l'application qui l'enregistre dans ta base locale.
 *
 * Économie de jetons :
 *  - réponse de Claude = un seul bloc JSON compact (clés courtes, commentaires vides si c'est juste,
 *    solution seulement pour les questions fausses) : l'application se charge de la mise en forme ;
 *  - mode « Projet Claude » : les règles sont collées une seule fois dans les instructions du projet,
 *    le prompt de chaque correction tient alors en 2 lignes.
 */
const { normalizeResult, parseJsonLoose, EXERCISE_TYPES } = require('./corrector');

const VERSION = 1;

// ---------------------------------------------------------------- Types d'évaluation (cas de figure)
const TYPES = [
  { id: 'controle', noun: 'contrôle', label: 'Contrôle / DS', icon: 'fa-file-signature', desc: 'Évaluation notée : correction comme le prof, sévérité d\'examen.',
    rule: 'Contrôle noté : applique le barème comme le ferait le professeur, sévérité d\'examen ; une erreur qui se répercute n\'est pénalisée qu\'une fois.' },
  { id: 'blanc', noun: 'contrôle blanc', label: 'Contrôle blanc', icon: 'fa-hourglass-half', desc: 'Entraînement en conditions réelles : note réaliste + plan de révision.',
    rule: 'Contrôle blanc : note réaliste comme à l\'examen. Dans "resume", indique le niveau estimé et les 2-3 points qui feraient gagner le plus de points. "rv" = plan de révision trié par priorité (h d\'abord).' },
  { id: 'exo', noun: 'exercice', label: 'Exercice / TD', icon: 'fa-pen-to-square', desc: 'Exercice de cours ou feuille de TD : accent sur la méthode.',
    rule: 'Exercice de TD : insiste sur la méthode et sur ce qu\'il faut retenir ; sévérité normale.' },
  { id: 'test', noun: 'interrogation', label: 'Interro / test rapide', icon: 'fa-stopwatch', desc: 'Petit test : correction très courte.',
    rule: 'Interrogation courte : correction très brève (commentaires de quelques mots), pas de "am".' },
  { id: 'qcm', noun: 'QCM', label: 'QCM', icon: 'fa-list-check', desc: 'Questions à choix multiples (points négatifs possibles).',
    rule: 'QCM : une entrée "q" par question ; "t" = réponse(s) cochée(s) → bonne(s) réponse(s) (ex. "B → C") ; "s" = c ou i (p si réponses multiples partiellement justes) ; "c" = pourquoi en une phrase, seulement si faux ; pas de "sol" ; "f" seulement pour les notions mal comprises (regroupées).' },
  { id: 'tp', noun: 'TP', label: 'TP / code', icon: 'fa-code', desc: 'Programme, script, requêtes : vérification par exécution mentale.',
    rule: 'TP de programmation : trace l\'exécution sur des cas normaux ET limites (vide, 0, négatif, doublons, NULL…) et indique la sortie obtenue vs attendue dans "c". "sol" = uniquement les lignes à corriger, pas le programme entier.' },
  { id: 'projet', noun: 'projet', label: 'Projet / SAÉ', icon: 'fa-diagram-project', desc: 'Rendu de projet : évaluation par critères.',
    rule: 'Projet / SAÉ : une entrée "q" par critère d\'évaluation (fonctionnalités, conception, qualité du code, tests, documentation/rapport…) avec ses points ; "am" = améliorations prioritaires concrètes.' },
  { id: 'annale', noun: 'sujet', label: 'Corrigé d\'un sujet', icon: 'fa-book-open', desc: 'Sujet ou annale sans ta copie : Claude rédige le corrigé type.', nocopy: true,
    rule: 'Pas de copie d\'étudiant : rédige le CORRIGÉ TYPE. Pour chaque question : "s":"n", "p":0, "m" = points du barème, "c" = piège à éviter (court), "sol" = réponse attendue complète mais concise. "f" vide, "fi" = fiches des notions clés.' }
];

// ---------------------------------------------------------------- Familles de matières (règles de correction spécifiques)
const FAMILIES = {
  dev: { label: 'Développement', type: 'developpement', rule: 'Code : exécute-le mentalement sur des cas limites ; vérifie la logique, la complexité, la gestion des erreurs ; ne pénalise pas le style si l\'énoncé ne l\'exige pas.' },
  web: { label: 'Web', type: 'web', rule: 'Web : validité et sémantique HTML, CSS, JavaScript côté client, sécurité de base (injection, XSS) ; un rendu équivalent écrit autrement est juste.' },
  bdd: { label: 'Bases de données', type: 'base_de_donnees', rule: 'BDD : teste chaque requête sur un petit jeu de données imaginé (NULL, doublons, lignes à exclure) ; vérifie jointures, GROUP BY/HAVING, sous-requêtes ; MCD/MLD : cardinalités, clés primaires/étrangères, normalisation. Tout dialecte courant est valide (Oracle MINUS/NVL/DUAL, MySQL, PostgreSQL) sauf si l\'énoncé en impose un.' },
  maths: { label: 'Mathématiques', type: 'maths', rule: 'Maths : refais chaque calcul étape par étape ; vérifie justification et rigueur ; une erreur de calcul isolée avec une méthode juste garde l\'essentiel des points ; résultats équivalents (forme différente) acceptés.' },
  archi: { label: 'Architecture / bas niveau', type: 'architecture', rule: 'Architecture : refais conversions de bases, complément à 2, flottants, tables de vérité, simplifications logiques, assembleur pas à pas.' },
  systeme: { label: 'Systèmes / shell', type: 'systeme', rule: 'Systèmes : vérifie commandes et options, chemins, droits, redirections, scripts shell (cas limites), processus.' },
  reseau: { label: 'Réseaux', type: 'reseau', rule: 'Réseaux : recalcule adresses, masques, plages, broadcast, nombre d\'hôtes, découpage en sous-réseaux ; vérifie tables de routage et couches OSI/TCP-IP.' },
  gl: { label: 'Génie logiciel / qualité', type: 'genie_logiciel', rule: 'Génie logiciel : UML (types de relations, multiplicités, navigabilité), tests (couverture, cas limites), patrons, Git ; plusieurs modélisations peuvent être justes si elles respectent l\'énoncé.' },
  algo: { label: 'Algorithmique / graphes', type: 'algorithmique', rule: 'Algorithmique : déroule l\'algorithme sur un exemple, vérifie terminaison, correction et complexité ; graphes : parcours, plus courts chemins, arbres couvrants recalculés.' },
  gestion: { label: 'Gestion / éco / droit', type: 'gestion', rule: 'Gestion, économie, droit : exactitude des notions et définitions, qualité de l\'argumentation, exemples pertinents.' },
  anglais: { label: 'Anglais', type: 'anglais', rule: 'Anglais : grammaire, vocabulaire technique, compréhension ; "sol" en anglais correct, explications en français.' },
  com: { label: 'Communication / PPP', type: 'communication', rule: 'Communication : structure, argumentation, adaptation au destinataire, expression écrite.' },
  autre: { label: 'Autre', type: 'autre', rule: '' }
};

// Ressources du BUT Informatique (modifiables dans les Réglages)
const DEFAULT_SUBJECTS = [
  { id: 'R1.01', label: 'R1.01 Initiation au développement', family: 'dev' },
  { id: 'R1.02', label: 'R1.02 Développement d\'interfaces web', family: 'web' },
  { id: 'R1.03', label: 'R1.03 Architecture des ordinateurs', family: 'archi' },
  { id: 'R1.04', label: 'R1.04 Systèmes d\'exploitation', family: 'systeme' },
  { id: 'R1.05', label: 'R1.05 Bases de données et SQL', family: 'bdd' },
  { id: 'R1.06', label: 'R1.06 Mathématiques discrètes', family: 'maths' },
  { id: 'R1.07', label: 'R1.07 Outils mathématiques fondamentaux', family: 'maths' },
  { id: 'R1.08', label: 'R1.08 Gestion de projet et des organisations', family: 'gestion' },
  { id: 'R1.09', label: 'R1.09 Économie durable et numérique', family: 'gestion' },
  { id: 'R1.10', label: 'R1.10 Anglais', family: 'anglais' },
  { id: 'R1.11', label: 'R1.11 Communication', family: 'com' },
  { id: 'R2.01', label: 'R2.01 Développement orienté objets', family: 'dev' },
  { id: 'R2.02', label: 'R2.02 Développement d\'applications avec IHM', family: 'dev' },
  { id: 'R2.03', label: 'R2.03 Qualité de développement', family: 'gl' },
  { id: 'R2.04', label: 'R2.04 Communication et fonctionnement bas niveau', family: 'archi' },
  { id: 'R2.05', label: 'R2.05 Services réseaux', family: 'reseau' },
  { id: 'R2.06', label: 'R2.06 Exploitation d\'une base de données', family: 'bdd' },
  { id: 'R2.07', label: 'R2.07 Graphes', family: 'algo' },
  { id: 'R2.08', label: 'R2.08 Statistiques descriptives', family: 'maths' },
  { id: 'R2.09', label: 'R2.09 Méthodes numériques', family: 'maths' },
  { id: 'SAE', label: 'SAÉ (projet)', family: 'dev' },
  { id: 'AUTRE', label: 'Autre matière', family: 'autre' }
];

// ---------------------------------------------------------------- Format de réponse compact
const SCHEMA = `{"ci":${VERSION},"titre":"court et précis","matiere":"…","lang":"langage/outil ou \\"\\"","sur":20,
"appr":"1 phrase","resume":"2-4 phrases",
"q":[{"n":"1.a","t":"intitulé court","s":"c|p|i|n","p":1.5,"m":2,"c":"","sol":""}],
"f":[{"q":"1.a","g":2,"cat":"calcul|logique|syntaxe|modelisation|methode|redaction|autre","no":"notion","d":"erreur et pourquoi","x":"extrait exact","co":"bonne version"}],
"pf":["point fort"],"am":[["conseil","détail concret"]],"rv":[["notion","h|m|b","pourquoi"]],"fi":[["question","réponse"]],"mc":["mot-clé"]}`;

const LEGEND = 'Légende : s c=correct p=partiel i=incorrect n=non traité ; p/m = points obtenus/max (Σp/Σm ramené sur "sur" = la note) ; "c" vide si juste ; "sol" = réponse attendue, UNIQUEMENT si p<m ; g 1=mineure 2=moyenne 3=majeure ; rv h=haute m=moyenne b=basse ; "fi" = 2 à 5 fiches de révision sur les erreurs ; "mc" = 4 à 8 mots-clés.';

const CORE_RULES = (o) => `RÈGLES
- Repère toi-même énoncé, copie et barème dans les pièces jointes. Rattache chaque réponse à sa question même si la numérotation diffère (« Q3 » ↔ « Ex.2 Q1 », ordre changé, réponse non numérotée) ; cherche dans TOUTE la copie avant de mettre "n".
- Vérifie vraiment chaque réponse avant de juger ; ne fais pas confiance à l'apparence.
- Barème du prof prioritaire, sinon celui de l'énoncé, sinon répartition cohérente. Note sur ${o.gradeMax}. Sévérité : ${o.severity}.
- Ne pénalise pas : une réponse juste écrite autrement, un dialecte/langage valide, une erreur de lecture probable d'une photo, la mise en forme. Dans le doute, ne retire rien et dis-le dans "c".
- Sois bref et précis : pas de reformulation de l'énoncé ni de la copie, pas de politesse.
- Français, tutoiement, Markdown dans les textes, maths en $…$, code en \`\`\`.`;

function familyOf(subjects, matiere) {
  const m = String(matiere || '').trim();
  const s = subjects.find((x) => x.id === m || x.label === m) || subjects.find((x) => m && (m.startsWith(x.id) || x.label.startsWith(m)));
  return FAMILIES[s?.family] ? s.family : 'autre';
}

/** Instructions à coller UNE fois dans un projet Claude (mode économe). */
function projectInstructions(o = {}) {
  const opts = { gradeMax: 20, severity: 'normale', level: 'BUT Informatique', ...o };
  return `Tu es mon correcteur pour le ${opts.level}. Chaque message te donne : le type d'évaluation, la matière, des options, et des pièces jointes (énoncé, ma copie, parfois le barème).
${CORE_RULES({ gradeMax: 'celle indiquée (20 par défaut)', severity: 'celle indiquée (normale par défaut)' })}

SELON LE TYPE
${TYPES.map((t) => `- ${t.label} : ${t.rule}`).join('\n')}

SELON LA MATIÈRE
${Object.values(FAMILIES).filter((f) => f.rule).map((f) => `- ${f.label} : ${f.rule}`).join('\n')}

SORTIE : UNIQUEMENT un bloc \`\`\`json, sans texte avant ni après (sauf si je demande « version lisible »), selon ce schéma :
${SCHEMA}
${LEGEND}
Si je pose ensuite une question sur la correction, réponds normalement en texte.`;
}

/**
 * Prompt d'une correction.
 * o = { type, matiere, subjects, gradeMax, severity, level, consignes, negatif, readable, project, hasBareme }
 */
function buildPrompt(o = {}) {
  const opts = { type: 'exo', matiere: 'AUTRE', subjects: DEFAULT_SUBJECTS, gradeMax: 20, severity: 'normale', level: 'BUT Informatique — 1re année', consignes: '', negatif: '', readable: false, project: false, hasBareme: false, ...o };
  const type = TYPES.find((t) => t.id === opts.type) || TYPES[2];
  const subj = opts.subjects.find((s) => s.id === opts.matiere) || { label: opts.matiere || 'non précisée' };
  const fam = FAMILIES[familyOf(opts.subjects, opts.matiere)];
  const pieces = type.nocopy ? `le sujet${opts.hasBareme ? ' et le barème' : ''}` : `l'énoncé, ma copie${opts.hasBareme ? ' et le barème du prof' : ''}`;
  const extras = [
    opts.type === 'qcm' && opts.negatif ? `Réponse fausse : ${opts.negatif} point(s).` : '',
    opts.consignes ? `Consignes : ${opts.consignes}` : '',
    opts.readable ? 'Donne d\'abord une version lisible courte (note + erreurs principales), puis le bloc JSON.' : ''
  ].filter(Boolean);
  if (opts.project) {
    return `${type.label} — ${subj.label} — ${opts.level} — sur ${opts.gradeMax} — sévérité ${opts.severity}.${extras.length ? `\n${extras.join('\n')}` : ''}
Pièces jointes : ${pieces}. Réponds selon les instructions du projet (bloc JSON "ci").`;
  }
  return `Corrige ce ${type.noun} de ${subj.label} (${opts.level}). Pièces jointes : ${pieces}.
${CORE_RULES(opts)}
- ${type.rule}${fam.rule ? `\n- ${fam.rule}` : ''}${extras.length ? `\n${extras.map((e) => `- ${e}`).join('\n')}` : ''}

SORTIE : ${opts.readable ? 'la version lisible courte, puis ' : 'UNIQUEMENT '}un bloc \`\`\`json selon ce schéma (rien d'autre) :
${SCHEMA.replace('"sur":20', `"sur":${opts.gradeMax}`).replace('"matiere":"…"', `"matiere":"${subj.label.replace(/"/g, '')}"`)}
${LEGEND}`;
}

// ---------------------------------------------------------------- Suites (réexplication, entraînement)
function digest(rec, max = 2500) {
  const r = rec.result;
  const wrong = r.questions.filter((q) => q.statut !== 'correct').map((q) => `- ${q.numero} (${q.points_obtenus}/${q.points_max}) ${q.intitule} : ${q.commentaire}`).join('\n');
  const fautes = r.fautes.map((f) => `- ${f.notion || f.categorie} : ${f.description}`).join('\n');
  return `${r.titre} (${r.matiere}) — ${r.note.obtenue}/${r.note.sur}\nQuestions à revoir :\n${wrong || '(aucune)'}\nFautes :\n${fautes || '(aucune)'}`.slice(0, max);
}

function followUpPrompt(kind, rec, extra = '') {
  const d = digest(rec);
  if (kind === 'explain') {
    return `Voici la correction de mon devoir. Réexplique-moi simplement mes erreurs, une par une, avec pour chacune : la règle à retenir, un mini-exemple juste, et le piège à éviter. Sois concis.${extra ? `\nJe bloque surtout sur : ${extra}` : ''}\n\n${d}`;
  }
  if (kind === 'similar') {
    return `Crée-moi UN exercice d'entraînement du même type et du même niveau que ce devoir, ciblé sur mes erreurs ci-dessous. Donne seulement l'énoncé (avec barème). Je te renverrai ma réponse : corrige-la alors au format JSON "ci" habituel.\n\n${d}`;
  }
  if (kind === 'flash') {
    return `À partir de cette correction, fais-moi 8 questions flash (réponse en une ligne) pour vérifier que j'ai compris mes erreurs. Pose-les une par une et attends ma réponse avant de corriger.\n\n${d}`;
  }
  return d;
}

/** Plan d'entraînement sur les points faibles (tirés de la base). */
function trainingPrompt({ notions = [], matiere = '', level = 'BUT Informatique', type = 'exo' }) {
  const list = notions.slice(0, 8).map((n) => `- ${n.notion} (${n.count} erreur(s))`).join('\n') || '- (pas encore assez de corrections)';
  return `Je suis en ${level}${matiere ? `, matière ${matiere}` : ''}. Mes notions les plus souvent ratées :\n${list}\n\nCrée-moi ${type === 'blanc' ? 'un contrôle blanc de 1 h (barème sur 20)' : 'une série de 3 exercices progressifs (barème indiqué)'} qui cible ces notions. Donne seulement l'énoncé. Quand je t'enverrai mes réponses, corrige-les au format JSON "ci" habituel.`;
}

// ---------------------------------------------------------------- Lecture de la réponse de Claude
function extractJson(text) {
  const t = String(text || '');
  const blocks = [...t.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1]);
  // Bloc non fermé (copie partielle) : à partir de la première accolade
  const candidates = [...blocks, t, t.slice(t.indexOf('{'))];
  let best = null;
  for (const c of candidates) {
    try {
      const j = parseJsonLoose(c);
      if (j && typeof j === 'object' && j.titre === 'court et précis') continue; // exemple du prompt
      if (j && typeof j === 'object' && (Array.isArray(j.q) || Array.isArray(j.questions))) return j;
      best ||= j;
    } catch { /* suivant */ }
  }
  if (best && typeof best === 'object') return best;
  throw new Error('Aucun bloc JSON de correction trouvé. Copie toute la réponse de Claude (ou le bloc ```json).');
}

const STATUT = { c: 'correct', p: 'partiel', i: 'incorrect', n: 'non_traite', correct: 'correct', partiel: 'partiel', incorrect: 'incorrect', non_traite: 'non_traite' };
const GRAV = { 1: 'mineure', 2: 'moyenne', 3: 'majeure', mineure: 'mineure', moyenne: 'moyenne', majeure: 'majeure' };
const PRIO = { h: 'haute', m: 'moyenne', b: 'basse', haute: 'haute', moyenne: 'moyenne', basse: 'basse' };
const s = (v) => (v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v));
const list = (v) => (Array.isArray(v) ? v : v ? [v] : []);

/**
 * Convertit la réponse de Claude (format compact "ci" ou format complet) en résultat de l'application.
 * Renvoie { result, flashcards, warnings }.
 */
function parseClaudeResult(text, { gradeMax = 20, typeId = null, subjects = DEFAULT_SUBJECTS, matiere = '' } = {}) {
  if (isPrompt(text) && !/```json[\s\S]*"ci"[\s\S]*```[\s\S]*$/.test(String(text).split('Légende')[1] || '')) {
    throw new Error('C\'est le prompt que tu as collé, pas la réponse de Claude. Envoie-le à Claude, puis copie sa réponse.');
  }
  const j = extractJson(text);
  const warnings = [];
  // Format complet de l'application (déjà au bon format)
  if (Array.isArray(j.questions)) {
    return { result: normalizeResult(j, num(j.note?.sur) || gradeMax), flashcards: [], warnings };
  }
  const sur = num(j.sur) || num(Array.isArray(j.note) ? j.note[1] : j.note?.sur) || gradeMax;
  const questions = list(j.q).map((q, i) => ({
    numero: s(q.n ?? i + 1),
    intitule: s(q.t),
    statut: STATUT[String(q.s || '').toLowerCase()] || 'partiel',
    points_obtenus: num(q.p),
    points_max: num(q.m),
    commentaire: s(q.c),
    sol: s(q.sol)
  }));
  if (!questions.length) warnings.push('Aucune question dans la réponse : vérifie que tu as copié tout le bloc JSON.');
  const totalMax = questions.reduce((a, q) => a + q.points_max, 0);
  const given = Array.isArray(j.note) ? num(j.note[0], null) : j.note?.obtenue != null ? num(j.note.obtenue) : null;
  if (totalMax > 0 && given != null) {
    const computed = (questions.reduce((a, q) => a + Math.min(q.points_obtenus, q.points_max), 0) / totalMax) * sur;
    if (Math.abs(computed - given) > 0.26) warnings.push(`Note annoncée par Claude (${given}/${sur}) différente de la somme des points (${Math.round(computed * 4) / 4}/${sur}) : la somme des points est retenue.`);
  }
  // Correction modèle : uniquement les solutions des questions non réussies (économe)
  const sols = questions.filter((q) => q.sol).map((q) => `#### Question ${q.numero}${q.intitule ? ` — ${q.intitule}` : ''}\n${q.sol}`);
  const isAnnale = typeId === 'annale' || questions.every((q) => q.statut === 'non_traite' && q.sol);
  const raw = {
    titre: j.titre,
    matiere: j.matiere,
    type_exercice: EXERCISE_TYPES.includes(j.type) ? j.type : FAMILIES[familyOf(subjects, matiere || j.matiere)].type,
    langage: j.lang,
    note: totalMax > 0 ? { sur } : { obtenue: given ?? 0, sur },
    appreciation: j.appr,
    resume: j.resume,
    points_forts: list(j.pf),
    questions: questions.map(({ sol, ...q }) => q),
    fautes: list(j.f).map((f) => ({ question: s(f.q), gravite: GRAV[f.g] || 'moyenne', categorie: s(f.cat) || 'autre', notion: s(f.no), description: s(f.d), extrait: s(f.x), correction: s(f.co) })),
    ameliorations: list(j.am).map((a) => (Array.isArray(a) ? { titre: s(a[0]), detail: s(a[1]) } : typeof a === 'string' ? a : { titre: s(a.titre || a.t), detail: s(a.detail || a.d) })),
    a_revoir: list(j.rv).map((a) => (Array.isArray(a) ? { notion: s(a[0]), priorite: PRIO[a[1]] || 'moyenne', pourquoi: s(a[2]), ressources: s(a[3]) } : typeof a === 'string' ? a : { notion: s(a.notion || a.no), priorite: PRIO[a.priorite || a.pr] || 'moyenne', pourquoi: s(a.pourquoi || a.pq) })),
    correction_modele: sols.length ? `${isAnnale ? '' : '_Solutions des questions à reprendre :_\n\n'}${sols.join('\n\n')}` : undefined,
    mots_cles: list(j.mc)
  };
  const result = normalizeResult(raw, sur);
  result.solutions = Object.fromEntries(questions.filter((q) => q.sol).map((q) => [q.numero, q.sol]));
  const flashcards = list(j.fi).map((f) => (Array.isArray(f) ? { front: s(f[0]), back: s(f[1]), notion: s(f[2]) } : { front: s(f.recto || f.r || f.q), back: s(f.verso || f.v || f.a), notion: s(f.notion) })).filter((f) => f.front && f.back);
  return { result, flashcards, warnings, annale: isAnnale };
}

function num(v, d = 0) {
  if (v == null || v === '') return d;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : d;
}

/** Le texte ressemble-t-il à une réponse de correction de Claude ? (détection dans le presse-papiers) */
function looksLikeResult(text) {
  const t = String(text || '');
  if (isPrompt(t)) return false;
  return /"ci"\s*:\s*\d/.test(t) && /"q"\s*:\s*\[/.test(t);
}

/** Le texte est-il un prompt de l'application (et non la réponse de Claude) ? */
function isPrompt(t) {
  return /Légende : s c=correct|selon les instructions du projet|"titre":"court et précis"/.test(String(t || ''));
}

/** Adresse claude.ai à ouvrir (avec le prompt prérempli quand c'est possible). */
function claudeUrl(prompt, { projectUrl = '' } = {}) {
  if (projectUrl && /^https:\/\/claude\.ai\//.test(projectUrl)) return projectUrl;
  const q = encodeURIComponent(prompt || '');
  return q && q.length < 6000 ? `https://claude.ai/new?q=${q}` : 'https://claude.ai/new';
}

const estimateTokens = (t) => Math.ceil(String(t || '').length / 3.6);

module.exports = { TYPES, FAMILIES, DEFAULT_SUBJECTS, SCHEMA, buildPrompt, projectInstructions, followUpPrompt, trainingPrompt, parseClaudeResult, extractJson, looksLikeResult, claudeUrl, estimateTokens, familyOf, VERSION };
