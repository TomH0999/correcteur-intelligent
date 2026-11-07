'use strict';
/**
 * Pipeline de correction :
 *  1. lecture des images (modèle de vision vérifié, sinon OCR local) et transcription audio ;
 *  2. (option) vérification par exécution réelle du code de l'étudiant ;
 *  3. identification énoncé / réponses / barème + correction détaillée en JSON ;
 * + générateurs : fiches de révision (flashcards) et exercices d'entraînement.
 */
const { AIError } = require('./providers');

const DEFAULTS = {
  provider: 'groq',
  correctionModel: 'auto',
  visionModel: 'auto',
  audioModel: 'auto',
  maxInputChars: 60000,
  gradeMax: 20,
  level: 'BUT Informatique — 1re année',
  severity: 'normale',
  reasoningEffort: 'medium',
  executeCode: true,
  autoFlashcards: true
};

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

/** Valide et complète le JSON renvoyé par le modèle. */
function normalizeResult(raw, gradeMax = 20) {
  const r = raw && typeof raw === 'object' ? raw : {};
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
  return `\n\nRÉSULTATS D'EXÉCUTION RÉELLE (le code de l'étudiant a été exécuté par l'application avec des tests) :\n${executions.map((e, i) => `--- Test ${i + 1} (${e.langage}) : ${e.but}
Sortie attendue : ${e.sortie_attendue || '(non précisée)'}
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
        maxTokens: 4096,
        signal: ctx.signal,
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

/** Appel au modèle principal avec bascule automatique sur les modèles de secours. */
async function chatWithFallback(ctx, { system, user, json = true, maxTokens = 8192, step = 'correction', label = 'Correction' }) {
  const models = [ctx.models.main, ...(ctx.models.fallbacks || [])].filter(Boolean);
  let lastErr;
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      ctx.progress({ step, message: `${label} en cours avec ${model}${attempt ? ' (nouvel essai)' : ''}…` });
      try {
        const r = await ctx.ai.chat({ model, system, messages: [{ role: 'user', content: user }], json, maxTokens: attempt ? maxTokens * 2 : maxTokens, effort: ctx.s.reasoningEffort, signal: ctx.signal });
        if (r.finishReason === 'length' && attempt === 0) continue;
        const parsed = json ? parseJsonLoose(r.content) : r.content;
        if (model !== ctx.models.main) ctx.notes.push(`Le modèle principal n'a pas pu être utilisé ; ${label.toLowerCase()} réalisée avec ${model}.`);
        return { parsed, model: r.model || model };
      } catch (err) {
        lastErr = err;
        if (err.code === 'aborted' || err.status === 401) throw err;
        if (err instanceof AIError && !err.canFallback && err.status !== 400 && err.status !== 422) throw err;
        if (err instanceof AIError) break; // modèle suivant
        // JSON invalide : nouvel essai, puis modèle suivant
      }
    }
  }
  const hint = lastErr && /tokens|too large|413|context/i.test(`${lastErr.message} ${lastErr.code}`)
    ? ' Les documents sont trop volumineux pour les limites de ton offre : réduis le nombre de fichiers ou la limite de caractères dans les Paramètres.'
    : '';
  throw new Error(`${label} impossible : ${lastErr?.message || 'erreur inconnue'}.${hint}`);
}

const CODE_LANGS = /```(python|py|javascript|js|sql|java|c|cpp|c\+\+|php|typescript|ts|plsql|mysql)\b/i;

function hasRunnableCode(sources) {
  return sources.some((s) => CODE_LANGS.test(s.text) || /\b(def |public class |#include|SELECT .+ FROM|CREATE TABLE|function\s*\w*\s*\(|console\.log|System\.out)/i.test(s.text));
}

/** Demande à l'IA un plan de tests, puis exécute réellement le code de l'étudiant. */
async function verifyByExecution(ctx, sources, consigne, runCode) {
  if (!ctx.s.executeCode || !runCode || !hasRunnableCode(sources)) return [];
  const { sources: fitted } = fitSources(sources, Math.min(ctx.s.maxInputChars, 30000));
  const system = `Tu prépares des tests d'exécution pour vérifier le code écrit par un étudiant en informatique.
Langages exécutables : python, javascript, sql (SQLite), java (fichier unique avec main), c, cpp, php.
Pour chaque réponse de code de l'ÉTUDIANT (pas l'énoncé), écris un programme COMPLET et AUTONOME qui reprend son code TEL QUEL (sans corriger ses erreurs) et ajoute des appels de test qui AFFICHENT les résultats (cas normaux et cas limites demandés par l'énoncé).
Pour le SQL : crée d'abord les tables et insère un petit jeu de données cohérent avec l'énoncé (en SQLite), puis exécute les requêtes de l'étudiant telles quelles. Adapte uniquement la syntaxe spécifique à un SGBD (ex. Oracle) si c'est indispensable pour SQLite.
Indique la sortie attendue si le code était correct. Au maximum 5 tests, les plus révélateurs. Si rien n'est exécutable, renvoie une liste vide.
Réponds UNIQUEMENT en JSON : {"executions":[{"but":"ce que le test vérifie","langage":"python|javascript|sql|java|c|cpp|php","code":"programme complet","entree":"texte envoyé sur l'entrée standard (souvent vide)","sortie_attendue":"…"}]}`;
  try {
    const { parsed } = await chatWithFallback(ctx, { system, user: `${consigne ? `Indications : ${consigne}\n\n` : ''}${documentsBlock(fitted)}`, maxTokens: 6000, step: 'tests', label: 'Préparation des tests' });
    const plan = arr(parsed.executions).filter((e) => e && e.code).slice(0, 5);
    const out = [];
    for (const [i, e] of plan.entries()) {
      ctx.progress({ step: 'tests', message: `Exécution du test ${i + 1}/${plan.length} (${e.langage})…` });
      const r = await runCode({ language: e.langage, code: str(e.code), stdin: str(e.entree), timeoutMs: 10000 });
      out.push({ but: str(e.but), langage: r.language, code: str(e.code), entree: str(e.entree), sortie_attendue: str(e.sortie_attendue), stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode, timedOut: !!r.timedOut, unavailable: !!r.unavailable, ok: r.ok, durationMs: r.durationMs });
    }
    return out;
  } catch (err) {
    if (err.code === 'aborted' || err.status === 401) throw err;
    ctx.notes.push(`Vérification par exécution impossible : ${err.message}`);
    return [];
  }
}

async function runCorrection(ctx, sources, consigne, executions = []) {
  const { sources: fitted, truncated } = fitSources(sources, ctx.s.maxInputChars);
  if (truncated) ctx.notes.push(`Les documents dépassent ${ctx.s.maxInputChars.toLocaleString('fr-FR')} caractères : certaines parties ont été tronquées (réglable dans les Paramètres).`);
  const user = `${consigne ? `INDICATIONS DE L'ÉTUDIANT : ${consigne}\n\n` : ''}Voici les ${fitted.length} document(s) fournis. Identifie l'énoncé, les réponses et l'éventuel barème, puis corrige.\n\n${documentsBlock(fitted)}${executionsBlock(executions)}\n\nRéponds uniquement avec l'objet JSON demandé.`;
  const { parsed, model } = await chatWithFallback(ctx, { system: buildSystemPrompt(ctx.s), user });
  const result = normalizeResult(parsed, ctx.s.gradeMax);
  result.executions = executions;
  return { result, model };
}

async function correct(ctx, { files, consigne, runCode }) {
  const sources = await buildSources(files, ctx);
  if (!sources.length) throw new Error("Aucun contenu exploitable n'a pu être extrait des fichiers fournis.");
  const executions = await verifyByExecution(ctx, sources, consigne, runCode);
  const out = await runCorrection(ctx, sources, consigne, executions);
  return { ...out, sources, warnings: ctx.notes };
}

async function recorrect(ctx, { sources, consigne, runCode }) {
  const executions = await verifyByExecution(ctx, sources, consigne, runCode);
  const out = await runCorrection(ctx, sources, consigne, executions);
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
  const { parsed } = await chatWithFallback(ctx, { system, user, maxTokens: 4000, step: 'flashcards', label: 'Création des fiches' });
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
  const { parsed, model } = await chatWithFallback(ctx, { system, user, maxTokens: 5000, step: 'exercise', label: 'Création de l\'exercice' });
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

module.exports = {
  correct, recorrect, generateFlashcards, generateExercise, normalizeResult, buildName, fitSources, parseJsonLoose,
  buildSystemPrompt, hasRunnableCode, DEFAULTS, EXERCISE_TYPES, TYPE_LABELS, VISION_PROMPT
};
