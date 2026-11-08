'use strict';
/**
 * Pipeline de correction :
 *  1. lecture des images (modèle de vision vérifié, sinon OCR local) et transcription audio ;
 *  2. (option) vérification par exécution réelle du code de l'étudiant ;
 *  3. identification énoncé / réponses / barème + correction détaillée en JSON ;
 * + générateurs : fiches de révision (flashcards) et exercices d'entraînement.
 */
const { AIError } = require('./providers');
const { estimateTokens: est, limitsFromError, isSizeError } = require('./limits');

const DEFAULTS = {
  provider: 'groq',
  correctionModel: 'auto',
  visionModel: 'auto',
  audioModel: 'auto',
  maxInputChars: 400000,
  gradeMax: 20,
  level: 'BUT Informatique — 1re année',
  severity: 'normale',
  reasoningEffort: 'medium',
  executeCode: true,
  autoFlashcards: true
};

/** Règles d'équité : ce qui ne doit JAMAIS coûter de points à l'étudiant (erreurs internes, pas les siennes). */
const FAIRNESS_RULES = `RÈGLES D'ÉQUITÉ (à respecter impérativement)
- Une syntaxe VALIDE dans un SGBD ou une version de langage courants n'est PAS une faute : Oracle (MINUS, NVL, NVL2, DECODE, SYSDATE, DUAL, ROWNUM, VARCHAR2, NUMBER, TO_DATE, séquences .NEXTVAL, jointure (+), PL/SQL, commandes SQL*Plus comme SET SERVEROUTPUT ON, PROMPT, « / »), MySQL (AUTO_INCREMENT, backticks, LIMIT a,b, IFNULL), PostgreSQL, SQL Server (TOP, GETDATE), Python 3, Java, C, JavaScript… Ne la sanctionne que si l'énoncé impose explicitement un autre dialecte.
- Les résultats d'exécution marqués « LIMITE DE L'OUTIL » ne disent RIEN sur la justesse du code : ignore-les et évalue le code par ton propre raisonnement. Ne crée jamais de faute à partir d'eux et ne mentionne pas l'outil (SQLite, PostgreSQL, Pyodide…) comme cause d'une faute.
- Un échec d'exécution peut venir du programme de test généré automatiquement (données de test incomplètes, sortie attendue erronée, entrée non fournie) : vérifie que l'erreur vient bien du code de l'étudiant avant de la compter.
- Ne sanctionne pas l'ordre des lignes d'un résultat SQL sans ORDER BY, les différences d'espaces, de casse des mots-clés, de format d'affichage des nombres ou des dates, sauf si l'énoncé l'exige.
- Les passages marqués « [… tronqué …] » n'ont pas été transmis : ne pénalise pas ce qui pourrait s'y trouver.
- Le texte provenant d'une image (photo, scan, manuscrit) est une transcription automatique qui peut contenir des erreurs (caractère mal lu, indentation perdue, symbole manquant) : ne compte pas comme faute ce qui ressemble à une erreur de lecture ; signale-le dans les remarques.
- Dans le doute sur l'origine d'une erreur (étudiant ou outil), ne retire pas de points et signale-le dans le commentaire.`;

const EXERCISE_TYPES = ['maths', 'developpement', 'base_de_donnees', 'reseau', 'systeme', 'algorithmique', 'web', 'genie_logiciel', 'architecture', 'anglais', 'communication', 'gestion', 'autre'];

const VISION_PROMPT = `Tu es un expert en transcription de documents scolaires d'informatique (BUT Informatique).
Transcris FIDÈLEMENT et INTÉGRALEMENT le contenu de cette image, sans corriger les erreurs : la transcription servira à corriger l'élève.
Règles :
- Texte (imprimé ou manuscrit) : recopie-le mot pour mot, en conservant la numérotation (Exercice 1, Q2, a), b)…). Les fautes de l'élève doivent être conservées.
- Mathématiques : écris toutes les formules en LaTeX entre $…$ (ou $$…$$ pour les formules centrées). Conserve chaque étape de calcul, les ratures significatives (« [barré : …] »).
- Code (manuscrit ou capture) : recopie-le dans un bloc \`\`\`langage en respectant l'indentation.
- Schémas de bases de données (MCD/MLD/MPD, Merise, UML, entité-association) : liste chaque entité/table avec ses attributs (identifiants/clés primaires -> [PK], clés étrangères [FK]), chaque association avec ses cardinalités exactes des deux côtés (ex. « CLIENT (0,n) — passe — (1,1) COMMANDE »).
- Diagrammes UML, automates, arbres, graphes, schémas réseau, algorigrammes : décris la structure de façon exhaustive (nœuds, liens, étiquettes, multiplicités, adresses IP/masques…).
- Tableaux : restitue-les en tableau Markdown.
- Si un passage est illisible, écris [illisible] plutôt que d'inventer.
- Indique en première ligne la nature de l'image entre crochets : [énoncé imprimé], [copie manuscrite], [capture de code], [schéma], [barème], [mélange énoncé + réponses], etc.
Réponds uniquement avec la transcription, sans commentaire ni correction.`;

function buildSystemPrompt(s) {
  return `Tu es un correcteur expert et bienveillant pour des étudiants en ${s.level} (France).
Tu maîtrises tout le programme du BUT Informatique : mathématiques (analyse, algèbre linéaire, probabilités, graphes, logique, arithmétique modulaire), algorithmique et programmation (Python, Java, C, C#, JavaScript/TypeScript, PHP…), développement web, bases de données (Merise MCD/MLD/MPD, modèle relationnel, normalisation, algèbre relationnelle, SQL, PL/SQL, NoSQL), réseaux (adressage IPv4/IPv6, sous-réseaux, routage, modèle OSI/TCP-IP), systèmes (Linux, shell, processus), architecture des ordinateurs, génie logiciel (UML, tests, design patterns, Git), ainsi que les matières transverses (anglais, communication, gestion, droit).

TA MISSION
On te fournit un ou plusieurs documents (déjà convertis en texte ; les images ont été transcrites automatiquement, des erreurs de transcription sont possibles).
1. IDENTIFIE toi-même ce qui relève de l'ÉNONCÉ (sujet, consignes, questions), des RÉPONSES de l'étudiant et, s'il y en a, du BARÈME / CORRIGÉ DU PROFESSEUR. Un même fichier peut contenir plusieurs de ces éléments ; un énoncé peut aussi être absent : dans ce cas, déduis les questions à partir des réponses et signale-le.
2. CORRIGE chaque question/exercice : vérifie l'exactitude (calculs refaits étape par étape, code exécuté mentalement avec des cas limites, requêtes SQL vérifiées sur leur logique, schémas confrontés aux règles de modélisation), la méthode, la rigueur, la rédaction et les bonnes pratiques.
3. Si des RÉSULTATS D'EXÉCUTION RÉELLE du code sont fournis, appuie-toi dessus en priorité (ce sont des faits) et cite-les dans tes commentaires. Attention : un échec peut venir du programme de test et non de l'étudiant ; juge avec discernement.
4. NOTE de façon juste sur ${s.gradeMax}. Si un barème ou un corrigé du professeur est fourni, APPLIQUE-LE STRICTEMENT (mêmes points par question, mêmes attendus) puis ramène la note sur ${s.gradeMax}. Sinon respecte le barème de l'énoncé s'il existe, ou répartis les points de manière cohérente. Sévérité demandée : ${s.severity}. Une erreur de transcription évidente (OCR) ne doit pas être sanctionnée ; signale-la plutôt.
5. Rédige un RAPPORT DE FAUTES précis, des AMÉLIORATIONS possibles et une liste de NOTIONS À REVOIR, puis une CORRECTION MODÈLE complète.

${FAIRNESS_RULES}

RÈGLES DE FORME
- Tout en français, ton pédagogique, direct, concret. Tutoie l'étudiant.
- Markdown autorisé dans les champs texte. Maths en LaTeX entre $…$ ou $$…$$. Code dans des blocs \`\`\`langage.
- Cite des extraits exacts de la réponse de l'étudiant dans "extrait" quand c'est pertinent.
- N'invente pas de questions qui n'existent pas. Si une question n'est pas traitée, statut "non_traite".

FORMAT DE SORTIE : réponds UNIQUEMENT avec un objet JSON valide respectant exactement ce schéma :
{
  "titre": "titre court et précis de l'exercice/du devoir (ex. « TD3 SQL — jointures et agrégats »)",
  "matiere": "matière / ressource (ex. « R1.05 Bases de données », « Mathématiques discrètes »)",
  "type_exercice": "un parmi ${EXERCISE_TYPES.join(' | ')}",
  "langage": "langage ou outil principal (ex. « Python », « SQL », « LaTeX », « Merise ») ou \\"\\"",
  "identification": {
    "enonce": ["noms des fichiers (ou parties) identifiés comme énoncé"],
    "reponses": ["noms des fichiers (ou parties) identifiés comme réponses de l'étudiant"],
    "bareme": ["noms des fichiers (ou parties) identifiés comme barème/corrigé du professeur (souvent vide)"],
    "enonce_present": true,
    "remarques": "comment tu as fait la distinction, problèmes de lisibilité éventuels"
  },
  "note": { "obtenue": 0, "sur": ${s.gradeMax} },
  "score_pourcentage": 0,
  "appreciation": "une phrase d'appréciation générale",
  "resume": "synthèse de 3 à 6 phrases sur la copie : points forts et points faibles",
  "points_forts": ["…"],
  "questions": [
    { "numero": "1.a", "intitule": "résumé de la question", "statut": "correct | partiel | incorrect | non_traite", "points_obtenus": 0, "points_max": 0, "commentaire": "explication de la correction pour cette question" }
  ],
  "fautes": [
    { "question": "1.a", "gravite": "mineure | moyenne | majeure", "categorie": "calcul | raisonnement | syntaxe | logique | modelisation | conception | methode | redaction | notation | performance | securite | bonnes_pratiques | hors_sujet | autre", "notion": "notion du cours concernée (ex. « jointures SQL », « dérivée d'un produit »)", "description": "ce qui est faux et pourquoi", "extrait": "extrait exact de la réponse fautive", "correction": "la bonne version" }
  ],
  "ameliorations": [ { "titre": "…", "detail": "conseil concret et actionnable (avec exemple si utile)" } ],
  "a_revoir": [ { "notion": "…", "priorite": "haute | moyenne | basse", "pourquoi": "…", "ressources": "pistes : chapitre du cours, exercice type, documentation officielle…" } ],
  "correction_modele": "correction complète et rédigée en Markdown de tout l'exercice",
  "mots_cles": ["5 à 12 mots-clés pour retrouver cette correction (notions, langage, matière)"]
}`;
}

function parseJsonLoose(text) {
  if (!text) throw new Error('Réponse vide du modèle.');
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  try {
    return JSON.parse(t);
  } catch {
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(t.slice(start, end + 1));
    throw new Error('Le modèle n\'a pas renvoyé de JSON exploitable.');
  }
}

const num = (v, d = 0) => {
  const n = typeof v === 'string' ? Number(v.replace(',', '.')) : Number(v);
  return Number.isFinite(n) ? n : d;
};
const arr = (v) => (Array.isArray(v) ? v : v ? [v] : []);
const str = (v) => (v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v));

/** Une « faute » qui accuse en réalité l'outil d'exécution (moteur SQL, environnement…) n'est pas une faute de l'étudiant. */
const TOOL_BLAME = /\b(sqlite|postgre(s|sql)|pglite|pyodide|l'outil (d'exécution|de test)|environnement (d'exécution|de test)|moteur (sql|d'exécution)|non (reconnu|supporté|pris en charge) par (le moteur|l'outil|sqlite|postgre)|limite de l'outil)\b/i;

/** Valide et complète le JSON renvoyé par le modèle. */
function normalizeResult(raw, gradeMax = 20) {
  const r = raw && typeof raw === 'object' ? raw : {};
  if (Array.isArray(r.fautes)) {
    const before = r.fautes.length;
    r.fautes = r.fautes.filter((f) => !TOOL_BLAME.test(`${f?.description || ''} ${f?.correction || ''}`));
    if (r.fautes.length < before && r.identification && typeof r.identification === 'object') {
      r.identification.remarques = `${r.identification.remarques || ''} (${before - r.fautes.length} remarque(s) liée(s) à l'outil d'exécution retirée(s) : ce ne sont pas des erreurs de l'étudiant.)`.trim();
    }
  }
  const questions = arr(r.questions).map((q) => ({
    numero: str(q.numero),
    intitule: str(q.intitule),
    statut: ['correct', 'partiel', 'incorrect', 'non_traite'].includes(q.statut) ? q.statut : 'partiel',
    points_obtenus: Math.max(0, num(q.points_obtenus)),
    points_max: Math.max(0, num(q.points_max)),
    commentaire: str(q.commentaire)
  }));
  let sur = num(r.note?.sur, gradeMax) || gradeMax;
  let obtenue = r.note?.obtenue != null ? num(r.note.obtenue) : null;
  const totalMax = questions.reduce((s, q) => s + q.points_max, 0);
  const totalGot = questions.reduce((s, q) => s + Math.min(q.points_obtenus, q.points_max || q.points_obtenus), 0);
  if (obtenue == null && totalMax > 0) obtenue = (totalGot / totalMax) * sur;
  if (obtenue == null && r.score_pourcentage != null) obtenue = (num(r.score_pourcentage) / 100) * sur;
  obtenue = Math.min(sur, Math.max(0, obtenue ?? 0));
  if (sur !== gradeMax) {
    obtenue = (obtenue / sur) * gradeMax;
    sur = gradeMax;
  }
  obtenue = Math.round(obtenue * 4) / 4; // au quart de point
  const score = Math.round((obtenue / sur) * 1000) / 10;
  const type = EXERCISE_TYPES.includes(r.type_exercice) ? r.type_exercice : 'autre';
  return {
    titre: str(r.titre) || 'Exercice sans titre',
    matiere: str(r.matiere),
    type_exercice: type,
    langage: str(r.langage),
    identification: {
      enonce: arr(r.identification?.enonce).map(str),
      reponses: arr(r.identification?.reponses).map(str),
      bareme: arr(r.identification?.bareme).map(str),
      enonce_present: r.identification?.enonce_present !== false,
      remarques: str(r.identification?.remarques)
    },
    note: { obtenue, sur },
    score_pourcentage: score,
    appreciation: str(r.appreciation),
    resume: str(r.resume),
    points_forts: arr(r.points_forts).map(str),
    questions,
    fautes: arr(r.fautes).map((f) => ({
      question: str(f.question),
      gravite: ['mineure', 'moyenne', 'majeure'].includes(f.gravite) ? f.gravite : 'moyenne',
      categorie: str(f.categorie) || 'autre',
      notion: str(f.notion),
      description: str(f.description),
      extrait: str(f.extrait),
      correction: str(f.correction)
    })),
    ameliorations: arr(r.ameliorations).map((a) => (typeof a === 'string' ? { titre: a, detail: '' } : { titre: str(a.titre), detail: str(a.detail) })),
    a_revoir: arr(r.a_revoir).map((a) => (typeof a === 'string' ? { notion: a, priorite: 'moyenne', pourquoi: '', ressources: '' } : {
      notion: str(a.notion),
      priorite: ['haute', 'moyenne', 'basse'].includes(a.priorite) ? a.priorite : 'moyenne',
      pourquoi: str(a.pourquoi),
      ressources: str(a.ressources)
    })),
    correction_modele: str(r.correction_modele),
    mots_cles: arr(r.mots_cles).map(str).slice(0, 15),
    executions: arr(r.executions)
  };
}

const TYPE_LABELS = {
  maths: 'Maths', developpement: 'Dev', base_de_donnees: 'BDD', reseau: 'Réseau', systeme: 'Système',
  algorithmique: 'Algo', web: 'Web', genie_logiciel: 'Génie logiciel', architecture: 'Archi', anglais: 'Anglais',
  communication: 'Com', gestion: 'Gestion', autre: 'Autre'
};

/** Nom précis et unique, pour retrouver facilement la correction dans l'historique. */
function buildName(result, date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const d = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}h${pad(date.getMinutes())}`;
  const note = `${String(result.note.obtenue).replace('.', ',')}/${result.note.sur}`;
  return [`[${TYPE_LABELS[result.type_exercice] || 'Autre'}]`, result.matiere, result.titre, note, d]
    .filter(Boolean)
    .join(' — ')
    .replace(/\s+/g, ' ')
    .slice(0, 200);
}

/** Répartit le budget de caractères entre les sources (les plus courtes sont gardées entières). */
function fitSources(sources, maxChars) {
  const total = sources.reduce((s, x) => s + x.text.length, 0);
  if (total <= maxChars) return { sources, truncated: false };
  const sorted = [...sources].sort((a, b) => a.text.length - b.text.length);
  let budget = maxChars;
  const limits = new Map();
  sorted.forEach((s, i) => {
    const share = Math.floor(budget / (sorted.length - i));
    const lim = Math.min(s.text.length, share);
    limits.set(s, lim);
    budget -= lim;
  });
  return {
    truncated: true,
    sources: sources.map((s) => {
      const lim = limits.get(s);
      return lim >= s.text.length ? s : { ...s, text: s.text.slice(0, lim) + `\n[… tronqué : ${s.text.length - lim} caractères non transmis à l'IA …]` };
    })
  };
}

const ROLE_LABEL = {
  enonce: 'ÉNONCÉ (indiqué par l\'utilisateur)',
  reponse: 'RÉPONSES DE L\'ÉTUDIANT (indiqué par l\'utilisateur)',
  bareme: 'BARÈME / CORRIGÉ DU PROFESSEUR (indiqué par l\'utilisateur) — à appliquer strictement',
  auto: 'à déterminer'
};

function documentsBlock(sources) {
  return sources.map((s, i) => {
    const kind = s.kind === 'image' ? 'transcription automatique d\'image' : s.kind === 'audio' ? 'transcription audio' : s.kind === 'pdf-page' ? 'page de PDF' : s.kind === 'generated' ? 'exercice généré par l\'application' : 'texte extrait';
    return `<<<DOCUMENT ${i + 1}
fichier: ${s.file}
partie: ${s.label}
nature: ${kind}
rôle: ${ROLE_LABEL[s.role] || ROLE_LABEL.auto}
---
${s.text}
DOCUMENT ${i + 1}>>>`;
  }).join('\n\n');
}

function executionsBlock(executions) {
  if (!executions?.length) return '';
  return `\n\nRÉSULTATS D'EXÉCUTION RÉELLE (le code de l'étudiant a été exécuté par l'application avec des tests générés automatiquement) :\n${executions.map((e, i) => `--- Test ${i + 1} (${e.langage}) : ${e.but}
${e.internal ? `⚠ LIMITE DE L'OUTIL — PAS UNE ERREUR DE L'ÉTUDIANT : ${e.explication || e.category}. Ignore ce résultat pour la note et évalue ce code par raisonnement.\n` : ''}${e.fromImage ? 'ℹ Code transcrit depuis une image : une erreur de syntaxe peut venir de la transcription.\n' : ''}Sortie attendue : ${e.sortie_attendue || '(non précisée)'}
${e.unavailable ? `Non exécuté : ${e.stderr}` : `Code de retour : ${e.exitCode}${e.timedOut ? ' (TEMPS DÉPASSÉ)' : ''}
Sortie obtenue :
${(e.stdout || '').slice(0, 3000) || '(vide)'}${e.stderr ? `\nErreurs :\n${e.stderr.slice(0, 2000)}` : ''}`}`).join('\n\n')}`;
}

async function mapLimit(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

/**
 * Contexte d'exécution : fournisseur IA, modèles résolus (vérifiés sur le compte), réglages.
 * ctx = { ai, audioAi, models: { main, fallbacks, vision, audio }, s, progress, signal, notes, ocr }
 */
async function readImage(ctx, j) {
  if (ctx.models.vision) {
    try {
      const r = await ctx.ai.chat({
        model: ctx.models.vision,
        temperature: 0,
        maxTokens: Math.min(4096, limitsFor(ctx, ctx.models.vision).maxOut),
        signal: ctx.signal,
        onWait: (ms) => ctx.progress({ step: 'vision', message: `Pause de ${Math.ceil(ms / 1000)} s (limite de jetons par minute)…` }),
        messages: [{ role: 'user', content: [{ type: 'text', text: VISION_PROMPT + `\n(Fichier : ${j.part.label})` }, { type: 'image', mime: j.part.mime || 'image/jpeg', base64: j.part.base64 }] }]
      });
      if (r.content.trim()) return { text: r.content.trim(), via: ctx.models.vision };
    } catch (err) {
      if (err.code === 'aborted' || err.status === 401) throw err;
      ctx.notes.push(`Vision indisponible pour « ${j.part.label} » (${err.message}) : OCR local utilisé.`);
    }
  }
  if (ctx.ocr) return { text: await ctx.ocr(j.part.base64), via: 'ocr' };
  throw new Error('aucun lecteur d\'image disponible');
}

async function buildSources(files, ctx) {
  const jobs = [];
  for (const f of files) for (const p of f.parts) jobs.push({ file: f.name, role: f.role || 'auto', part: p });
  const images = jobs.filter((j) => j.part.type === 'image');
  const audios = jobs.filter((j) => j.part.type === 'audio');
  let done = 0;
  if (images.length) ctx.progress({ step: 'vision', message: `Lecture de ${images.length} image(s) avec ${ctx.models.vision || 'l\'OCR local'}…`, done, total: images.length });
  await mapLimit(images, 2, async (j) => {
    try {
      const r = await readImage(ctx, j);
      j.text = r.text;
    } catch (err) {
      if (err.code === 'aborted' || err.status === 401) throw err;
      ctx.notes.push(`Image « ${j.part.label} » non lue : ${err.message}`);
      j.text = '';
    }
    done++;
    ctx.progress({ step: 'vision', message: `Image ${done}/${images.length} lue`, done, total: images.length });
  });
  for (const [k, j] of audios.entries()) {
    ctx.progress({ step: 'audio', message: `Transcription audio ${k + 1}/${audios.length}…` });
    try {
      if (!ctx.audioAi || !ctx.models.audio) throw new Error('aucun service de transcription audio (ajoute une clé Groq ou OpenAI)');
      j.text = await ctx.audioAi.transcribe({ base64: j.part.base64, filename: j.part.filename, mime: j.part.mime, model: ctx.models.audio, signal: ctx.signal });
    } catch (err) {
      if (err.code === 'aborted') throw err;
      ctx.notes.push(`Audio « ${j.part.label} » non transcrit : ${err.message}`);
      j.text = '';
    }
  }
  return jobs
    .map((j) => ({
      file: j.file,
      role: j.role,
      label: j.part.label || j.file,
      kind: j.part.type === 'text' ? (j.part.fromPdf ? 'pdf-page' : j.part.generated ? 'generated' : 'text') : j.part.type,
      text: j.part.type === 'text' ? (j.part.lang && !/markdown/.test(j.part.lang) ? '```' + j.part.lang + '\n' + j.part.text + '\n```' : j.part.text) : j.text
    }))
    .filter((x) => x.text && x.text.trim());
}

// ================================================================ Appels au modèle (budget de jetons)

/** Limites du modèle (fenêtre de contexte, sortie max, jetons/minute) connues pour ce compte. */
function limitsFor(ctx, model) {
  return ctx.limits ? ctx.limits(model) : { context: 32768, maxOut: 8192, tpm: Infinity };
}

/** Budget d'un appel : jetons d'entrée disponibles et sortie réservée, selon les limites du modèle. */
function budgetFor(ctx, model, system, wantOut) {
  const l = limitsFor(ctx, model);
  const cap = Math.min(l.context, Number.isFinite(l.tpm) ? Math.floor(l.tpm * 0.9) : Infinity);
  const out = Math.max(512, Math.min(wantOut, l.maxOut, Math.floor(cap * 0.5)));
  const input = Math.max(400, Math.floor(cap - out - est(system) - 150));
  return { out, input, cap };
}

class TooLarge extends AIError {
  constructor(message) {
    super(message || 'Requête trop volumineuse pour ce modèle.', 413, 'too_large');
  }
}

/**
 * Appel au modèle principal avec :
 *  - sortie limitée au maximum autorisé par le modèle (appris automatiquement) ;
 *  - attente automatique quand le quota de jetons par minute est atteint ;
 *  - bascule sur les modèles de secours en cas de modèle indisponible ;
 *  - signal « trop gros » (TooLarge) si sizeSensitive : l'appelant découpe alors le travail.
 */
async function chatWithFallback(ctx, { system, user, json = true, wantOut = 6000, step = 'correction', label = 'Correction', sizeSensitive = false, effort }) {
  const models = [ctx.models.main, ...(ctx.models.fallbacks || [])].filter(Boolean);
  let lastErr;
  for (const [mi, model] of models.entries()) {
    let boost = 1;
    let parseFails = 0;
    for (let attempt = 0; attempt < 5; attempt++) {
      const b = budgetFor(ctx, model, system, wantOut * boost);
      if (est(user) > b.input) {
        // Le modèle principal est trop petit pour cette requête : on découpe plutôt que de dégrader
        if (sizeSensitive && mi === 0) throw new TooLarge(`Entrée estimée à ${est(user)} jetons pour ${b.input} disponibles.`);
        if (sizeSensitive) break;
      }
      ctx.progress({ step, message: `${label} avec ${model}${attempt ? ' (nouvel essai)' : ''}…` });
      try {
        const r = await ctx.ai.chat({
          model, system, messages: [{ role: 'user', content: user }], json, maxTokens: b.out,
          effort: effort || ctx.s.reasoningEffort, signal: ctx.signal,
          onWait: (ms) => ctx.progress({ step, message: `Pause de ${Math.ceil(ms / 1000)} s (limite de jetons par minute de ton offre)…` })
        });
        if (r.finishReason === 'length') {
          if (b.out < limitsFor(ctx, model).maxOut && boost < 4) { boost *= 2; continue; }
          if (json) {
            try {
              return { parsed: parseJsonLoose(r.content), model: r.model || model };
            } catch {
              if (sizeSensitive) throw new TooLarge('La réponse attendue dépasse la sortie maximale du modèle.');
              break;
            }
          }
        }
        const parsed = json ? parseJsonLoose(r.content) : r.content;
        if (mi > 0) ctx.notes.push(`Le modèle principal n'a pas pu être utilisé ; ${label.toLowerCase()} réalisée avec ${model}.`);
        return { parsed, model: r.model || model };
      } catch (err) {
        lastErr = err;
        if (err instanceof TooLarge || err.code === 'aborted' || err.status === 401) throw err;
        if (err instanceof AIError) {
          if (limitsFromError(err.message).maxOut) continue; // sortie max apprise : même modèle, sortie réduite
          if (isSizeError(err)) {
            // Les limites réelles viennent d'être apprises (message d'erreur / en-têtes) : on recalcule le budget
            const nb = budgetFor(ctx, model, system, wantOut * boost);
            if (est(user) > nb.input && sizeSensitive && mi === 0) throw new TooLarge(err.message);
            if (nb.out < b.out && est(user) <= nb.input && attempt < 3) continue; // même modèle, sortie réduite
            break; // limite inconnue ou modèle trop petit : modèle suivant
          }
          if (!err.canFallback && err.status !== 400 && err.status !== 422) throw err;
          break; // modèle suivant
        }
        // JSON invalide : nouvel essai, puis modèle suivant
        if (++parseFails >= 2) break;
      }
    }
  }
  if (lastErr && isSizeError(lastErr) && sizeSensitive) throw new TooLarge(lastErr.message);
  throw new Error(`${label} impossible : ${lastErr?.message || 'erreur inconnue'}.`);
}

const CODE_LANGS = /```(python|py|javascript|js|sql|java|c|cpp|c\+\+|php|typescript|ts|plsql|mysql)\b/i;

function hasRunnableCode(sources) {
  return sources.some((s) => CODE_LANGS.test(s.text) || /\b(def |public class |#include|SELECT .+ FROM|CREATE TABLE|function\s*\w*\s*\(|console\.log|System\.out)/i.test(s.text));
}

const TESTS_SYSTEM = `Tu prépares des tests d'exécution pour vérifier le code écrit par un étudiant en informatique.
Langages exécutables : python (3.14, bibliothèque standard, numpy/pandas si besoin), javascript et typescript (Node.js), sql, java (un fichier, plusieurs classes possibles), c, cpp, php.
Pour chaque réponse de code de l'ÉTUDIANT (pas l'énoncé), écris un programme COMPLET et AUTONOME qui reprend son code TEL QUEL — sans corriger ses erreurs NI changer sa syntaxe — et ajoute des appels de test qui AFFICHENT les résultats (cas normaux et cas limites demandés par l'énoncé).
SQL : écris le script dans le dialecte de l'étudiant (Oracle, MySQL, PostgreSQL, SQL Server… l'application convertit automatiquement : ne modifie JAMAIS sa syntaxe). Commence par créer les tables et insérer un jeu de données cohérent avec l'énoncé, assez riche pour distinguer une requête juste d'une fausse (cas avec NULL, doublons, lignes qui ne doivent pas sortir), puis ses requêtes telles quelles.
Si le programme lit au clavier (input, Scanner, scanf, cin, readline…), fournis TOUTES les valeurs nécessaires dans "entree" (une par ligne). S'il lit des fichiers, fournis-les dans "fichiers" ({"nom.txt": "contenu"}).
Si la réponse est un fragment (une fonction seule), ajoute le code d'appel nécessaire autour, sans toucher au fragment.
Indique la sortie attendue si le code était correct. Au maximum 4 tests, les plus révélateurs. Si rien n'est exécutable, renvoie une liste vide.
Réponds UNIQUEMENT en JSON : {"executions":[{"but":"ce que le test vérifie","langage":"python|javascript|typescript|sql|java|c|cpp|php","code":"programme complet","entree":"texte envoyé sur l'entrée standard","fichiers":{},"sortie_attendue":"…"}]}`;

/** Demande à l'IA un plan de tests pour un bloc de documents, puis exécute réellement le code de l'étudiant. */
async function verifyByExecution(ctx, docsText, consigne, runCode, { sizeSensitive = false } = {}) {
  if (!ctx.s.executeCode || !runCode || !hasRunnableCode([{ text: docsText }])) return [];
  // Code lu sur une image : une faute de syntaxe peut venir de la transcription
  const fromImage = /nature: transcription automatique d'image/.test(docsText) && !/nature: (texte extrait|page de PDF)[\s\S]*?(```|def |class |SELECT)/.test(docsText);
  try {
    const { parsed } = await chatWithFallback(ctx, { system: TESTS_SYSTEM, user: `${consigne ? `Indications : ${consigne}\n\n` : ''}${docsText}`, wantOut: 3500, step: 'tests', label: 'Préparation des tests', sizeSensitive, effort: 'low' });
    const plan = arr(parsed.executions).filter((e) => e && e.code).slice(0, 4);
    const out = [];
    for (const [i, e] of plan.entries()) {
      ctx.progress({ step: 'tests', message: `Exécution du test ${i + 1}/${plan.length} (${e.langage})…` });
      const files = e.fichiers && typeof e.fichiers === 'object' && !Array.isArray(e.fichiers) ? Object.fromEntries(Object.entries(e.fichiers).map(([k, v]) => [String(k).replace(/[\\/]+/g, '_'), str(v)])) : {};
      const r = await runCode({ language: e.langage, code: str(e.code), stdin: str(e.entree), timeoutMs: 10000, files });
      out.push({
        but: str(e.but), langage: r.language, code: str(e.code), entree: str(e.entree), sortie_attendue: str(e.sortie_attendue),
        stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode, timedOut: !!r.timedOut, unavailable: !!r.unavailable, ok: r.ok, durationMs: r.durationMs,
        // Erreur due à l'outil (dialecte, entrée non fournie, module absent…) : jamais comptée
        internal: !!r.internal, category: r.category || null, explication: r.explication || null, fromImage
      });
    }
    return out;
  } catch (err) {
    if (err instanceof TooLarge) throw err;
    if (err.code === 'aborted' || err.status === 401) throw err;
    ctx.notes.push(`Vérification par exécution impossible : ${err.message}`);
    return [];
  }
}

// ================================================================ Correction en un seul appel

async function correctSingle(ctx, sources, consigne, runCode) {
  const { sources: fitted, truncated } = fitSources(sources, ctx.s.maxInputChars);
  const docs = documentsBlock(fitted);
  const system = buildSystemPrompt(ctx.s);
  const user = (ex) => `${consigne ? `INDICATIONS DE L'ÉTUDIANT : ${consigne}\n\n` : ''}Voici les ${fitted.length} document(s) fournis. Identifie l'énoncé, les réponses et l'éventuel barème, puis corrige.\n\n${docs}${executionsBlock(ex)}\n\nRéponds uniquement avec l'objet JSON demandé.`;
  // Vérification préalable : si tout ne tient pas dans un appel, on passe directement au mode découpé
  if (est(user([])) > budgetFor(ctx, ctx.models.main, system, 6000).input) throw new TooLarge();
  const executions = await verifyByExecution(ctx, docs, consigne, runCode, { sizeSensitive: true });
  const { parsed, model } = await chatWithFallback(ctx, { system, user: user(executions), sizeSensitive: true });
  if (truncated) ctx.notes.push(`Les documents dépassent ${ctx.s.maxInputChars.toLocaleString('fr-FR')} caractères : la fin a été tronquée (réglable dans les Réglages).`);
  const result = normalizeResult(parsed, ctx.s.gradeMax);
  result.executions = executions;
  return { result, model, mode: 'single' };
}

// ================================================================ Correction découpée (gros devoirs, petites limites)
//  1. INDEXATION : chaque document est lu morceau par morceau (un appel à la fois) ; l'IA renvoie seulement
//     des plages de lignes (énoncé / réponse / barème + numéro de question) — le texte reste intact localement.
//  2. REGROUPEMENT : énoncé, barème et réponse de chaque question sont réunis.
//  3. CORRECTION PAR LOTS : chaque lot de questions est corrigé par un appel indépendant (sous-tâche) qui tient
//     dans les limites du modèle, avec exécution du code du lot.
//  4. SYNTHÈSE : un dernier appel, très court, produit l'appréciation globale ; la note est recalculée localement.

const INDEX_SYSTEM = `Tu prépares la correction d'un devoir d'informatique. On te donne un extrait d'un document dont chaque ligne est numérotée (L1, L2…).
Découpe-le en segments consécutifs et indique pour chacun :
- "nature" : "enonce" (sujet, consignes, questions, données fournies), "reponse" (ce que l'étudiant a écrit), "bareme" (barème ou corrigé du professeur) ou "autre" (en-tête, pagination, sans intérêt) ;
- "question" : le numéro de la question concernée, au format court cohérent avec l'énoncé (ex. "1", "2.b", "3.1") ; "general" pour un contexte commun à plusieurs questions (présentation, données, schéma de tables, consignes générales).
Réutilise exactement les numéros déjà rencontrés quand il s'agit des mêmes questions. Couvre toutes les lignes, sans chevauchement.
Réponds UNIQUEMENT en JSON : {"segments":[{"de":1,"a":12,"nature":"enonce","question":"general"}]}`;

function buildPartialPrompt(s) {
  return `Tu es un correcteur expert et bienveillant pour des étudiants en ${s.level} (France), spécialiste de tout le programme du BUT Informatique.
Tu corriges UNE PARTIE d'un devoir : uniquement les questions fournies ci-dessous (le reste est corrigé séparément).
Pour chaque question : vérifie l'exactitude (calculs refaits, code exécuté mentalement, requêtes SQL, schémas), la méthode et la rédaction. Appuie-toi en priorité sur les RÉSULTATS D'EXÉCUTION RÉELLE s'ils sont fournis.
Attribue des points : applique STRICTEMENT le barème du professeur s'il est fourni, sinon celui de l'énoncé, sinon un barème cohérent. Sévérité : ${s.severity}.
${FAIRNESS_RULES}
- Le contexte commun de l'énoncé a pu être résumé : ne pénalise pas l'absence d'un élément qui n'est pas fourni ici.
- Si la réponse à une question est notée « aucune réponse trouvée », vérifie d'abord dans les « RÉPONSES SANS NUMÉRO » fournies avant de conclure qu'elle n'est pas traitée.
Tout en français, tutoiement, Markdown, maths en LaTeX $…$, code dans des blocs \`\`\`.
Réponds UNIQUEMENT en JSON :
{"questions":[{"numero":"1.a","intitule":"…","statut":"correct | partiel | incorrect | non_traite","points_obtenus":0,"points_max":0,"commentaire":"…"}],
 "fautes":[{"question":"1.a","gravite":"mineure | moyenne | majeure","categorie":"calcul | raisonnement | syntaxe | logique | modelisation | conception | methode | redaction | notation | performance | securite | bonnes_pratiques | hors_sujet | autre","notion":"…","description":"…","extrait":"extrait exact fautif","correction":"…"}],
 "points_forts":["…"],
 "ameliorations":[{"titre":"…","detail":"…"}],
 "a_revoir":[{"notion":"…","priorite":"haute | moyenne | basse","pourquoi":"…","ressources":"…"}],
 "correction_modele":"correction rédigée en Markdown des questions de ce lot"}`;
}

const SYNTH_SYSTEM = `Tu rédiges la synthèse finale d'une correction de devoir d'informatique (BUT Informatique), à partir des résultats déjà établis question par question.
Ne modifie pas les points. Consolide les conseils (sans doublons) et rédige en français, en tutoyant.
Réponds UNIQUEMENT en JSON :
{"titre":"titre court et précis du devoir","matiere":"matière / ressource","type_exercice":"${EXERCISE_TYPES.join(' | ')}","langage":"langage ou outil principal ou \\"\\"",
 "appreciation":"une phrase","resume":"3 à 6 phrases","points_forts":["…"],
 "ameliorations":[{"titre":"…","detail":"…"}],"a_revoir":[{"notion":"…","priorite":"haute | moyenne | basse","pourquoi":"…","ressources":"…"}],
 "remarques_identification":"comment l'énoncé, les réponses et le barème ont été repérés","mots_cles":["5 à 12 mots-clés"]}`;

function normQ(q) {
  let s = String(q ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  if (!s || /^(general|commun|contexte|global|intro|presentation|tout|toutes|all)/.test(s)) return 'general';
  s = s.replace(/\b(exercice|exo|ex|question|questions|partie|part|q)\b\.?/g, ' ').replace(/[()\-–:/\\]+/g, ' ').trim().replace(/\s+/g, '.').replace(/\.+/g, '.').replace(/^\.|\.$/g, '');
  return s || 'general';
}

/** Découpe un texte en morceaux d'au plus maxTokens (par lignes ; les lignes trop longues sont coupées). */
function splitIntoChunks(text, maxTokens) {
  const maxChars = Math.max(400, Math.floor(maxTokens * 3.2));
  const lines = [];
  for (const l of String(text).split('\n')) {
    if (l.length <= 600) lines.push(l);
    else for (let i = 0; i < l.length; i += 600) lines.push(l.slice(i, i + 600));
  }
  const chunks = [];
  let cur = [];
  let size = 0;
  for (const l of lines) {
    const add = l.length + 8;
    if (cur.length && size + add > maxChars) {
      chunks.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(l);
    size += add;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

const sliceText = (text, maxTokens) => (est(text) <= maxTokens ? text : `${text.slice(0, Math.floor(maxTokens * 3.2))}\n[… suite tronquée pour tenir dans les limites du modèle …]`);

async function indexDocuments(ctx, sources) {
  const units = new Map(); // clé -> { label, enonce: [], reponse: [], bareme: [] }
  const general = { enonce: [], reponse: [], bareme: [] };
  const seen = { enonce: new Set(), reponse: new Set(), bareme: new Set() };
  const known = [];
  const indexBudget = budgetFor(ctx, ctx.models.main, INDEX_SYSTEM, 2000);
  let chunkTokens = Math.min(6000, indexBudget.input - 300);
  for (const [si, src] of sources.entries()) {
    let chunks = splitIntoChunks(src.text, chunkTokens);
    for (let ci = 0; ci < chunks.length; ci++) {
      const lines = chunks[ci];
      const user = `Fichier : ${src.file} — ${src.label}\nRôle indiqué par l'étudiant : ${ROLE_LABEL[src.role] || ROLE_LABEL.auto}\nNuméros de questions déjà rencontrés : ${known.slice(-60).join(', ') || 'aucun'}\n\n${lines.map((l, i) => `L${i + 1}| ${l}`).join('\n')}`;
      let segments;
      try {
        ({ parsed: { segments } = {} } = await chatWithFallback(ctx, { system: INDEX_SYSTEM, user, wantOut: 2000, step: 'index', label: `Lecture de « ${src.label} » (${si + 1}/${sources.length}${chunks.length > 1 ? `, partie ${ci + 1}/${chunks.length}` : ''})`, sizeSensitive: true, effort: 'low' }));
      } catch (err) {
        if (err instanceof TooLarge && chunkTokens > 500) {
          // Morceau encore trop gros pour les limites réelles : on le redécoupe
          chunkTokens = Math.floor(chunkTokens / 2);
          const rest = chunks.slice(ci).flat().join('\n');
          chunks = [...chunks.slice(0, ci), ...splitIntoChunks(rest, chunkTokens)];
          ci--;
          continue;
        }
        if (err.code === 'aborted' || err.status === 401) throw err;
        ctx.notes.push(`Découpage automatique impossible pour « ${src.label} » (${err.message}) : document traité d'un bloc.`);
        segments = [{ de: 1, a: lines.length, nature: src.role === 'auto' ? 'reponse' : src.role, question: 'general' }];
      }
      // Segments -> texte local intact (les lignes non couvertes suivent le segment précédent)
      const segs = arr(segments).map((g) => ({ de: Math.max(1, Math.floor(num(g.de, 1))), a: Math.min(lines.length, Math.floor(num(g.a, lines.length))), nature: str(g.nature), question: str(g.question) }))
        .filter((g) => g.a >= g.de).sort((x, y) => x.de - y.de);
      if (!segs.length) segs.push({ de: 1, a: lines.length, nature: 'reponse', question: 'general' });
      segs[0].de = 1;
      for (let k = 0; k < segs.length; k++) segs[k].a = k + 1 < segs.length ? Math.max(segs[k].de, segs[k + 1].de - 1) : lines.length;
      for (const g of segs) {
        let nature = ['enonce', 'reponse', 'bareme', 'autre'].includes(g.nature) ? g.nature : 'reponse';
        if (src.role && src.role !== 'auto' && nature !== 'autre') nature = src.role;
        // Un long passage classé « autre » dans une copie est gardé comme réponse (évite de perdre du travail)
        if (nature === 'autre' && (g.a - g.de >= 3) && src.role !== 'enonce') nature = 'reponse';
        if (nature === 'autre') continue;
        const text = lines.slice(g.de - 1, g.a).join('\n').trim();
        if (!text) continue;
        seen[nature].add(src.file);
        const key = normQ(g.question);
        const tagged = `(${src.label})\n${text}`;
        if (key === 'general') general[nature].push(tagged);
        else {
          if (!units.has(key)) {
            units.set(key, { key, label: g.question.trim() || key, enonce: [], reponse: [], bareme: [] });
            known.push(g.question.trim() || key);
          }
          units.get(key)[nature].push(tagged);
        }
      }
    }
  }
  return { units: [...units.values()], general, seen };
}

/** Contexte commun trop long : condensé (données et schémas conservés). */
async function condense(ctx, text, maxTokens) {
  if (est(text) <= maxTokens) return text;
  const system = 'Tu condenses le contexte commun d\'un énoncé d\'informatique pour un correcteur. Conserve INTÉGRALEMENT les données chiffrées, schémas de tables, signatures de fonctions, contraintes et barème ; supprime les répétitions et le texte décoratif. Réponds en texte brut (Markdown autorisé).';
  const parts = splitIntoChunks(text, Math.max(800, budgetFor(ctx, ctx.models.main, system, 1500).input - 200));
  const per = Math.max(200, Math.floor(maxTokens / parts.length));
  const out = [];
  for (const [i, p] of parts.entries()) {
    try {
      const { parsed } = await chatWithFallback(ctx, { system, user: `Condense en ${per * 3} caractères maximum :\n\n${p.join('\n')}`, json: false, wantOut: Math.min(1500, per + 200), step: 'index', label: `Résumé du contexte (${i + 1}/${parts.length})`, effort: 'low' });
      out.push(parsed);
    } catch (err) {
      if (err.code === 'aborted' || err.status === 401) throw err;
      out.push(p.join('\n'));
    }
  }
  return sliceText(out.join('\n\n'), maxTokens);
}

function unitText(u, maxTokens) {
  const block = (title, list) => (list.length ? `[${title}]\n${list.join('\n\n')}\n` : '');
  let enonce = u.enonce.join('\n\n');
  let bareme = u.bareme.join('\n\n');
  let reponse = u.reponse.join('\n\n');
  const total = () => est(enonce) + est(bareme) + est(reponse) + 30;
  // Si une seule question dépasse le budget : on raccourcit d'abord l'énoncé et le barème, puis la réponse
  if (total() > maxTokens) enonce = sliceText(enonce, Math.max(300, Math.floor(maxTokens * 0.25)));
  if (total() > maxTokens) bareme = sliceText(bareme, Math.max(200, Math.floor(maxTokens * 0.15)));
  if (total() > maxTokens) reponse = sliceText(reponse, Math.max(400, maxTokens - est(enonce) - est(bareme) - 30));
  return `### Question ${u.label}\n${block('ÉNONCÉ', enonce ? [enonce] : [])}${block('BARÈME / CORRIGÉ DU PROFESSEUR', bareme ? [bareme] : [])}${block('RÉPONSE DE L\'ÉTUDIANT', reponse ? [reponse] : ['(aucune réponse trouvée pour cette question)'])}`;
}

async function correctChunked(ctx, sources, consigne, runCode) {
  ctx.progress({ step: 'index', message: 'Documents volumineux : correction découpée, un document puis un lot de questions à la fois…' });
  const { sources: capped, truncated } = fitSources(sources, ctx.s.maxInputChars);
  if (truncated) ctx.notes.push(`Les documents dépassent ${ctx.s.maxInputChars.toLocaleString('fr-FR')} caractères : la fin a été ignorée (réglable dans les Réglages).`);
  const { units, general, seen } = await indexDocuments(ctx, capped);
  const partialSystem = buildPartialPrompt(ctx.s);
  const b = budgetFor(ctx, ctx.models.main, partialSystem, 6000);
  // Contexte commun (présentation, données…) : au plus 30 % du budget de chaque lot
  const sharedRaw = [...general.enonce, ...general.bareme.map((t) => `[BARÈME / CORRIGÉ]\n${t}`)].join('\n\n');
  const shared = sharedRaw ? await condense(ctx, sharedRaw, Math.floor(b.input * 0.3)) : '';
  // Réponses sans numéro : jointes aux questions dont la réponse n'a pas été repérée (au lieu de les compter « non traitées »)
  const looseAnswers = general.reponse.length ? sliceText(general.reponse.join('\n\n'), Math.floor(b.input * 0.25)) : '';
  if (looseAnswers) for (const u of units) if (!u.reponse.length) u.reponse.push(`[Réponse non numérotée — à chercher parmi les RÉPONSES SANS NUMÉRO ci-dessous]\n${looseAnswers}`);
  if (general.reponse.length && units.every((u) => u.reponse.length && !u.reponse[0].startsWith('[Réponse non numérotée'))) units.push({ key: 'general', label: 'Réponses sans numéro', enonce: [], bareme: [], reponse: general.reponse });
  if (!units.length) throw new Error('Aucune question ni réponse n\'a pu être repérée dans les documents.');
  const head = `${consigne ? `INDICATIONS DE L'ÉTUDIANT : ${consigne}\n\n` : ''}${shared ? `CONTEXTE COMMUN DE L'ÉNONCÉ :\n${shared}\n\n` : ''}QUESTIONS À CORRIGER DANS CE LOT :\n\n`;
  const room = Math.max(600, b.input - est(head) - 400);
  // Lots de questions qui tiennent dans le budget
  const batches = [];
  let cur = [];
  let size = 0;
  for (const u of units) {
    const t = unitText(u, room);
    if (cur.length && size + est(t) > room) {
      batches.push(cur);
      cur = [];
      size = 0;
    }
    cur.push({ u, t });
    size += est(t);
  }
  if (cur.length) batches.push(cur);

  const merged = { questions: [], fautes: [], points_forts: [], ameliorations: [], a_revoir: [], modele: [], executions: [] };
  let model = ctx.models.main;
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const labels = batch.map((x) => x.u.label).join(', ');
    const docs = batch.map((x) => x.t).join('\n\n');
    let executions = [];
    try {
      executions = await verifyByExecution(ctx, `${head}${docs}`, '', runCode, { sizeSensitive: true });
    } catch (err) {
      if (!(err instanceof TooLarge)) throw err;
    }
    const user = `${head}${docs}${executionsBlock(executions)}\n\nRéponds uniquement avec l'objet JSON demandé.`;
    let parsed;
    try {
      ({ parsed, model } = await chatWithFallback(ctx, { system: partialSystem, user, step: 'correction', label: `Correction des questions ${labels} (lot ${i + 1}/${batches.length})`, sizeSensitive: true }));
    } catch (err) {
      if (err instanceof TooLarge && batch.length > 1) {
        // Lot encore trop gros pour les limites réelles : on le coupe en deux
        const half = Math.ceil(batch.length / 2);
        batches.splice(i, 1, batch.slice(0, half), batch.slice(half));
        i--;
        continue;
      }
      if (err instanceof TooLarge) {
        // Une seule question trop grosse : on la raccourcit fortement
        batch[0].t = unitText(batch[0].u, Math.floor(room / 2));
        if (room > 1200 && !batch[0].shrunk) {
          batch[0].shrunk = true;
          i--;
          continue;
        }
      }
      throw err;
    }
    merged.questions.push(...arr(parsed.questions));
    merged.fautes.push(...arr(parsed.fautes));
    merged.points_forts.push(...arr(parsed.points_forts));
    merged.ameliorations.push(...arr(parsed.ameliorations));
    merged.a_revoir.push(...arr(parsed.a_revoir));
    if (parsed.correction_modele) merged.modele.push(str(parsed.correction_modele));
    merged.executions.push(...executions);
  }

  // Synthèse (entrée compacte : résultats déjà établis)
  const pts = (q) => `${num(q.points_obtenus)}/${num(q.points_max)}`;
  const synthUser = sliceText(`Fichiers : ${capped.map((s) => s.file).filter((v, i, a) => a.indexOf(v) === i).join(', ')}
Énoncé repéré dans : ${[...seen.enonce].join(', ') || 'aucun fichier (questions déduites des réponses)'}
Réponses repérées dans : ${[...seen.reponse].join(', ') || '—'}
Barème repéré dans : ${[...seen.bareme].join(', ') || '—'}

RÉSULTATS PAR QUESTION :
${merged.questions.map((q) => `- ${str(q.numero)} [${str(q.statut)}] ${pts(q)} — ${str(q.intitule).slice(0, 120)} : ${str(q.commentaire).slice(0, 200)}`).join('\n')}

FAUTES :
${merged.fautes.map((f) => `- (${str(f.gravite)}) ${str(f.notion || f.categorie)} : ${str(f.description).slice(0, 180)}`).join('\n') || '(aucune)'}

POINTS FORTS : ${merged.points_forts.map(str).join(' ; ').slice(0, 1500)}
CONSEILS : ${merged.ameliorations.map((a) => str(a.titre || a)).join(' ; ').slice(0, 1500)}
NOTIONS À REVOIR : ${merged.a_revoir.map((a) => `${str(a.notion || a)} (${str(a.priorite)})`).join(' ; ').slice(0, 1500)}`, Math.max(1500, budgetFor(ctx, ctx.models.main, SYNTH_SYSTEM, 2500).input - 100));
  let synth = {};
  try {
    ({ parsed: synth } = await chatWithFallback(ctx, { system: SYNTH_SYSTEM, user: synthUser, wantOut: 2500, step: 'synthese', label: 'Synthèse finale' }));
  } catch (err) {
    if (err.code === 'aborted' || err.status === 401) throw err;
    ctx.notes.push(`Synthèse finale incomplète (${err.message}).`);
  }
  const raw = {
    titre: synth.titre,
    matiere: synth.matiere,
    type_exercice: synth.type_exercice,
    langage: synth.langage,
    identification: { enonce: [...seen.enonce], reponses: [...seen.reponse], bareme: [...seen.bareme], enonce_present: seen.enonce.size > 0, remarques: `${str(synth.remarques_identification)} (Correction découpée en ${batches.length} lot(s) pour respecter les limites du modèle.)`.trim() },
    // La note est recalculée à partir des points des questions
    appreciation: synth.appreciation,
    resume: synth.resume,
    points_forts: arr(synth.points_forts).length ? synth.points_forts : merged.points_forts.slice(0, 6),
    questions: dedupeQuestions(merged.questions),
    fautes: merged.fautes,
    ameliorations: arr(synth.ameliorations).length ? synth.ameliorations : merged.ameliorations.slice(0, 8),
    a_revoir: arr(synth.a_revoir).length ? synth.a_revoir : merged.a_revoir.slice(0, 10),
    correction_modele: merged.modele.join('\n\n---\n\n'),
    mots_cles: synth.mots_cles
  };
  const result = normalizeResult(raw, ctx.s.gradeMax);
  result.executions = merged.executions;
  ctx.notes.push(`Documents volumineux : correction réalisée en ${batches.length} lot(s) successifs pour respecter les limites de ${ctx.models.main}.`);
  return { result, model, mode: 'chunked' };
}

/** Une même question corrigée dans deux lots (copie en plusieurs fichiers) ne doit compter qu'une fois. */
function dedupeQuestions(questions) {
  const rank = { correct: 3, partiel: 2, incorrect: 1, non_traite: 0 };
  const byKey = new Map();
  for (const q of arr(questions)) {
    const key = normQ(q.numero) || `#${byKey.size}`;
    const prev = byKey.get(key);
    // On garde la version où la réponse a été trouvée (pas « non traitée ») et la mieux notée
    if (!prev || (rank[q.statut] ?? 1) > (rank[prev.statut] ?? 1) || ((rank[q.statut] ?? 1) === (rank[prev.statut] ?? 1) && num(q.points_obtenus) > num(prev.points_obtenus))) byKey.set(key, q);
  }
  return [...byKey.values()];
}

/** Choisit automatiquement : un seul appel si tout tient dans les limites du modèle, sinon correction découpée. */
async function runCorrection(ctx, sources, consigne, runCode) {
  try {
    return await correctSingle(ctx, sources, consigne, runCode);
  } catch (err) {
    if (!(err instanceof TooLarge)) throw err;
    return correctChunked(ctx, sources, consigne, runCode);
  }
}

async function correct(ctx, { files, consigne, runCode }) {
  const sources = await buildSources(files, ctx);
  if (!sources.length) throw new Error("Aucun contenu exploitable n'a pu être extrait des fichiers fournis.");
  const out = await runCorrection(ctx, sources, consigne, runCode);
  return { ...out, sources, warnings: ctx.notes };
}

async function recorrect(ctx, { sources, consigne, runCode }) {
  const out = await runCorrection(ctx, sources, consigne, runCode);
  return { ...out, sources, warnings: ctx.notes };
}

// ---------------------------------------------------------------- Fiches de révision
async function generateFlashcards(ctx, result) {
  const system = `Tu crées des fiches de révision (flashcards) pour un étudiant en ${ctx.s.level}, à partir de ses erreurs.
Chaque fiche : une question courte et précise au recto, une réponse claire au verso (avec exemple, formule LaTeX $…$ ou petit bloc de code si utile).
Cible les notions mal maîtrisées, pas les détails anecdotiques. 4 à 10 fiches.
Réponds UNIQUEMENT en JSON : {"fiches":[{"recto":"…","verso":"…","notion":"…"}]}`;
  const user = `Exercice : ${result.titre} (${result.matiere})
Fautes :
${result.fautes.map((f) => `- [${f.gravite}] ${f.notion || f.categorie} : ${f.description} → ${f.correction}`).join('\n') || '(aucune)'}
Notions à revoir :
${result.a_revoir.map((a) => `- ${a.notion} : ${a.pourquoi}`).join('\n') || '(aucune)'}`;
  const { parsed } = await chatWithFallback(ctx, { system, user: sliceText(user, budgetFor(ctx, ctx.models.main, system, 3000).input - 50), wantOut: 3000, step: 'flashcards', label: 'Création des fiches', effort: 'low' });
  return arr(parsed.fiches).map((f) => ({ front: str(f.recto), back: str(f.verso), notion: str(f.notion) })).filter((f) => f.front && f.back);
}

// ---------------------------------------------------------------- Exercices d'entraînement
async function generateExercise(ctx, { notions, matiere, type, difficulte = 'moyenne', consigne = '' }) {
  const system = `Tu es enseignant en ${ctx.s.level}. Tu crées un exercice d'entraînement ORIGINAL ciblé sur des notions précises, pour qu'un étudiant progresse.
L'exercice doit être faisable en 15 à 40 minutes, avec 2 à 5 questions progressives, un barème sur ${ctx.s.gradeMax} et des consignes claires (données, schéma de tables, signature de fonction attendue, etc.).
Markdown, maths en LaTeX $…$, code dans des blocs \`\`\`.
Réponds UNIQUEMENT en JSON : {"titre":"…","matiere":"…","type_exercice":"${EXERCISE_TYPES.join(' | ')}","langage":"…","notions":["…"],"enonce":"énoncé complet en Markdown avec le barème par question","format_reponse":"comment rédiger la réponse (texte, code, schéma…)"}`;
  const user = `Notions à travailler : ${notions.join(', ')}
Matière : ${matiere || 'au choix'}
Type : ${type || 'au choix'}
Difficulté : ${difficulte}
${consigne ? `Demande particulière : ${consigne}` : ''}`;
  const { parsed, model } = await chatWithFallback(ctx, { system, user, wantOut: 4000, step: 'exercise', label: 'Création de l\'exercice' });
  return {
    titre: str(parsed.titre) || 'Exercice d\'entraînement',
    matiere: str(parsed.matiere) || matiere || '',
    type_exercice: EXERCISE_TYPES.includes(parsed.type_exercice) ? parsed.type_exercice : type || 'autre',
    langage: str(parsed.langage),
    notions: arr(parsed.notions).map(str),
    enonce: str(parsed.enonce),
    format_reponse: str(parsed.format_reponse),
    difficulte,
    model
  };
}

// ---------------------------------------------------------------- Discussion avec l'IA (tuteur)
const TUTOR_SYSTEM = (s) => `Tu es le tuteur personnel d'un étudiant en ${s.level}. Il vient de recevoir la correction d'un devoir (fournie ci-dessous avec ses documents) et te pose des questions dessus.
Réponds en français, en le tutoyant, de façon claire, pédagogique et concise : explique le pourquoi, donne des exemples, propose une petite question de vérification si utile.
Appuie-toi sur sa copie et sur la correction ; si tu n'es pas d'accord avec la correction, dis-le honnêtement et explique pourquoi.
Markdown autorisé, maths en LaTeX $…$, code dans des blocs \`\`\`. Ne recopie pas toute la correction : réponds à la question posée.`;

function correctionDigest(rec, maxTokens) {
  const r = rec.result;
  const lines = [
    `DEVOIR : ${r.titre} (${r.matiere || 'matière non précisée'}) — note ${r.note.obtenue}/${r.note.sur}`,
    `Appréciation : ${r.appreciation}`,
    `Résumé : ${r.resume}`,
    'QUESTIONS :',
    ...r.questions.map((q) => `- ${q.numero} [${q.statut}] ${q.points_obtenus}/${q.points_max} — ${q.intitule} : ${q.commentaire}`),
    'FAUTES :',
    ...r.fautes.map((f, i) => `${i + 1}. (${f.gravite}, question ${f.question}) ${f.notion || f.categorie} : ${f.description}${f.extrait ? ` | extrait : ${f.extrait}` : ''}${f.correction ? ` | correction : ${f.correction}` : ''}`),
    `À REVOIR : ${r.a_revoir.map((a) => a.notion).join(', ')}`,
    ...(r.executions?.length ? ['TESTS EXÉCUTÉS :', ...r.executions.map((e) => `- ${e.but} : ${e.ok ? 'OK' : 'échec'} — sortie : ${(e.stdout || e.stderr || '').slice(0, 300)}`)] : [])
  ];
  const digest = sliceText(lines.join('\n'), Math.floor(maxTokens * 0.6));
  const modele = r.correction_modele ? sliceText(`CORRECTION MODÈLE :\n${r.correction_modele}`, Math.floor(maxTokens * 0.4)) : '';
  return `${digest}\n\n${modele}`;
}

/**
 * Réponse du tuteur. Le contexte (correction + documents + historique) est dimensionné pour
 * tenir dans les limites du modèle : documents tronqués et anciens messages résumés si nécessaire.
 */
async function chatAbout(ctx, rec, history, question) {
  const system = TUTOR_SYSTEM(ctx.s);
  const b = budgetFor(ctx, ctx.models.main, system, 2500);
  const room = b.input - est(question) - 200;
  const digest = correctionDigest(rec, Math.floor(room * 0.35));
  // Historique récent (du plus récent au plus ancien, tant que ça tient)
  const histRoom = Math.floor(room * 0.25);
  const hist = [];
  let used = 0;
  for (const m of [...history].reverse()) {
    const t = `${m.role === 'user' ? 'ÉTUDIANT' : 'TUTEUR'} : ${m.content}`;
    if (used + est(t) > histRoom) break;
    hist.unshift(t);
    used += est(t);
  }
  const docsRoom = Math.max(300, room - est(digest) - used);
  const { sources: docs } = fitSources(rec.sources || [], Math.floor(docsRoom * 3.2));
  const user = `${digest}\n\nDOCUMENTS DE L'ÉTUDIANT :\n${documentsBlock(docs)}\n\n${hist.length ? `DISCUSSION PRÉCÉDENTE :\n${hist.join('\n\n')}\n\n` : ''}NOUVELLE QUESTION DE L'ÉTUDIANT :\n${question}`;
  const { parsed, model } = await chatWithFallback(ctx, { system, user, json: false, wantOut: 2500, step: 'chat', label: 'Réponse du tuteur' });
  return { content: String(parsed).trim(), model };
}

// ---------------------------------------------------------------- Annotation de la copie (localisation des fautes sur les photos)
const LOCATE_PROMPT = (fautes) => `Voici la photo d'une page de copie d'un étudiant et la liste des fautes relevées par le correcteur.
Pour chaque faute VISIBLE sur cette page, donne la zone où elle se trouve, sous forme de rectangle(s) [x0, y0, x1, y1] en coordonnées normalisées de 0 à 1000 (origine en haut à gauche). Ignore les fautes absentes de cette page. Encadre précisément le passage fautif (une ligne ou un bloc), pas toute la page.
FAUTES :
${fautes.map((f, i) => `${i + 1}. ${f.extrait ? `« ${f.extrait.slice(0, 160)} » — ` : ''}${f.description.slice(0, 160)}`).join('\n')}
Réponds UNIQUEMENT en JSON : {"annotations":[{"faute":1,"boites":[[x0,y0,x1,y1]]}]}`;

async function locateFaultsOnImage(ctx, base64, fautes) {
  if (!ctx.models.vision) throw new Error('Aucun modèle de vision disponible pour localiser les fautes sur les photos.');
  const r = await ctx.ai.chat({
    model: ctx.models.vision,
    temperature: 0,
    maxTokens: Math.min(2000, limitsFor(ctx, ctx.models.vision).maxOut),
    json: true,
    signal: ctx.signal,
    messages: [{ role: 'user', content: [{ type: 'text', text: LOCATE_PROMPT(fautes) }, { type: 'image', mime: 'image/jpeg', base64 }] }]
  });
  const parsed = parseJsonLoose(r.content);
  return arr(parsed.annotations).map((a) => ({
    faute: Math.floor(num(a.faute)) - 1,
    boxes: arr(a.boites || a.boxes).filter((x) => Array.isArray(x) && x.length === 4).map((x) => x.map((v) => Math.max(0, Math.min(1000, num(v))) / 1000))
  })).filter((a) => a.faute >= 0 && a.faute < fautes.length && a.boxes.length);
}

module.exports = {
  correct, recorrect, generateFlashcards, generateExercise, normalizeResult, buildName, fitSources, parseJsonLoose,
  buildSystemPrompt, hasRunnableCode, chatWithFallback, chatAbout, locateFaultsOnImage, budgetFor, sliceText, splitIntoChunks, normQ, TooLarge,
  DEFAULTS, EXERCISE_TYPES, TYPE_LABELS, VISION_PROMPT
};
