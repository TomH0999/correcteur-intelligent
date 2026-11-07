'use strict';
/**
 * Pipeline de correction :
 *  1. transcription des images (manuscrits, photos, schémas, captures) par un modèle de vision ;
 *  2. transcription des fichiers audio/vidéo (Whisper) ;
 *  3. identification automatique énoncé / réponses + correction détaillée par un LLM, en JSON.
 */
const { GroqClient, GroqError } = require('./groq');

const DEFAULTS = {
  correctionModel: 'openai/gpt-oss-120b',
  fallbackModels: ['llama-3.3-70b-versatile', 'meta-llama/llama-4-scout-17b-16e-instruct'],
  visionModel: 'meta-llama/llama-4-scout-17b-16e-instruct',
  audioModel: 'whisper-large-v3',
  maxInputChars: 60000,
  gradeMax: 20,
  level: 'BUT Informatique — 1re année',
  severity: 'normale',
  reasoningEffort: 'medium'
};

const EXERCISE_TYPES = ['maths', 'developpement', 'base_de_donnees', 'reseau', 'systeme', 'algorithmique', 'web', 'genie_logiciel', 'architecture', 'anglais', 'communication', 'gestion', 'autre'];

const VISION_PROMPT = `Tu es un expert en transcription de documents scolaires d'informatique (BUT Informatique).
Transcris FIDÈLEMENT et INTÉGRALEMENT le contenu de cette image, sans corriger les erreurs : la transcription servira à corriger l'élève.
Règles :
- Texte (imprimé ou manuscrit) : recopie-le mot pour mot, en conservant la numérotation (Exercice 1, Q2, a), b)…). Les fautes de l'élève doivent être conservées.
- Mathématiques : écris toutes les formules en LaTeX entre $…$ (ou $$…$$ pour les formules centrées). Conserve chaque étape de calcul, les ratures significatives (« [barré : …] »).
- Code (manuscrit ou capture) : recopie-le dans un bloc \`\`\`langage en respectant l'indentation.
- Schémas de bases de données (MCD/MLD/MPD, Merise, UML, entité-association) : liste chaque entité/table avec ses attributs (identifiants/clés primaires soulignés -> notés [PK], clés étrangères [FK]), chaque association avec ses cardinalités exactes des deux côtés (ex. « CLIENT (0,n) — passe — (1,1) COMMANDE »).
- Diagrammes UML (classes, cas d'utilisation, séquence), automates, arbres, graphes, schémas réseau, algorigrammes : décris la structure de façon exhaustive et structurée (nœuds, liens, étiquettes, multiplicités, adresses IP/masques…).
- Tableaux : restitue-les en tableau Markdown.
- Si un passage est illisible, écris [illisible] plutôt que d'inventer.
- Indique en première ligne la nature de l'image entre crochets : [énoncé imprimé], [copie manuscrite], [capture de code], [schéma], [mélange énoncé + réponses], etc.
Réponds uniquement avec la transcription, sans commentaire ni correction.`;

function buildSystemPrompt(s) {
  return `Tu es un correcteur expert et bienveillant pour des étudiants en ${s.level} (France).
Tu maîtrises tout le programme du BUT Informatique : mathématiques (analyse, algèbre linéaire, probabilités, graphes, logique, arithmétique modulaire), algorithmique et programmation (Python, Java, C, C#, JavaScript/TypeScript, PHP…), développement web, bases de données (Merise MCD/MLD/MPD, modèle relationnel, normalisation, algèbre relationnelle, SQL, PL/SQL, NoSQL), réseaux (adressage IPv4/IPv6, sous-réseaux, routage, modèle OSI/TCP-IP), systèmes (Linux, shell, processus), architecture des ordinateurs, génie logiciel (UML, tests, design patterns, Git), ainsi que les matières transverses (anglais, communication, gestion, droit).

TA MISSION
On te fournit un ou plusieurs documents (déjà convertis en texte ; les images ont été transcrites automatiquement, des erreurs de transcription sont possibles).
1. IDENTIFIE toi-même ce qui relève de l'ÉNONCÉ (sujet, consignes, questions, barème) et ce qui relève des RÉPONSES de l'étudiant. Un même fichier peut contenir les deux ; un énoncé peut aussi être absent : dans ce cas, déduis les questions à partir des réponses et signale-le.
2. CORRIGE chaque question/exercice : vérifie l'exactitude (calculs refaits étape par étape, code exécuté mentalement avec des cas limites, requêtes SQL vérifiées sur leur logique, schémas confrontés aux règles de modélisation), la méthode, la rigueur, la rédaction et les bonnes pratiques.
3. NOTE de façon juste sur ${s.gradeMax} (respecte le barème de l'énoncé s'il existe, sinon répartis les points de manière cohérente). Sévérité demandée : ${s.severity}. Une erreur de transcription évidente (OCR) ne doit pas être sanctionnée ; signale-la plutôt.
4. Rédige un RAPPORT DE FAUTES précis, des AMÉLIORATIONS possibles et une liste de NOTIONS À REVOIR, puis une CORRECTION MODÈLE complète.

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
    { "question": "1.a", "gravite": "mineure | moyenne | majeure", "categorie": "calcul | raisonnement | syntaxe | logique | modelisation | conception | methode | redaction | notation | performance | securite | bonnes_pratiques | hors_sujet | autre", "description": "ce qui est faux et pourquoi", "extrait": "extrait exact de la réponse fautive", "correction": "la bonne version" }
  ],
  "ameliorations": [ { "titre": "…", "detail": "conseil concret et actionnable (avec exemple si utile)" } ],
  "a_revoir": [ { "notion": "…", "priorite": "haute | moyenne | basse", "pourquoi": "…", "ressources": "pistes : chapitre du cours, exercice type, documentation officielle…" } ],
  "correction_modele": "correction complète et rédigée en Markdown de tout l'exercice",
  "mots_cles": ["5 à 12 mots-clés pour retrouver cette correction (notions, langage, matière)"]
}`;
}

function parseJsonLoose(text) {
  if (!text) throw new Error('Réponse vide du modèle.');
  let t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
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
  // Ramène la note sur le barème choisi par l'utilisateur
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
    mots_cles: arr(r.mots_cles).map(str).slice(0, 15)
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

function buildUserMessage(sources, consigne) {
  const roleLabel = { enonce: 'ÉNONCÉ (indiqué par l\'utilisateur)', reponse: 'RÉPONSES DE L\'ÉTUDIANT (indiqué par l\'utilisateur)', auto: 'à déterminer' };
  const blocks = sources.map((s, i) => {
    const kind = s.kind === 'image' ? 'transcription automatique d\'image' : s.kind === 'audio' ? 'transcription audio' : s.kind === 'pdf-page' ? 'page de PDF' : 'texte extrait';
    return `<<<DOCUMENT ${i + 1}
fichier: ${s.file}
partie: ${s.label}
nature: ${kind}
rôle: ${roleLabel[s.role] || roleLabel.auto}
---
${s.text}
DOCUMENT ${i + 1}>>>`;
  });
  return `${consigne ? `INDICATIONS DE L'ÉTUDIANT : ${consigne}\n\n` : ''}Voici les ${sources.length} document(s) fournis. Identifie l'énoncé et les réponses, puis corrige.\n\n${blocks.join('\n\n')}\n\nRéponds uniquement avec l'objet JSON demandé.`;
}

const VISION_FALLBACKS = ['meta-llama/llama-4-scout-17b-16e-instruct', 'meta-llama/llama-4-maverick-17b-128e-instruct'];

/** Appel au modèle de vision, avec bascule si le modèle configuré n'est plus disponible. */
async function visionChat(client, s, opts) {
  const models = [s.visionModel, ...VISION_FALLBACKS.filter((m) => m !== s.visionModel)];
  let lastErr;
  for (const model of models) {
    try {
      return await client.chat({ ...opts, model });
    } catch (err) {
      lastErr = err;
      if (!(err instanceof GroqError) || !err.canFallback) throw err;
    }
  }
  throw lastErr;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Convertit les parties extraites (texte, images, audio) en sources textuelles.
 */
async function buildSources(files, client, s, progress, signal) {
  const jobs = [];
  for (const f of files) {
    for (const p of f.parts) jobs.push({ file: f.name, role: f.role || 'auto', part: p });
  }
  const images = jobs.filter((j) => j.part.type === 'image');
  const audios = jobs.filter((j) => j.part.type === 'audio');
  const warnings = [];
  let done = 0;
  if (images.length) progress({ step: 'vision', message: `Lecture de ${images.length} image(s) (manuscrits, schémas, captures)…`, done, total: images.length });
  await mapLimit(images, 2, async (j) => {
    try {
      const r = await visionChat(client, s, {
        temperature: 0,
        maxTokens: 4096,
        signal,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: VISION_PROMPT + `\n(Fichier : ${j.part.label})` },
            { type: 'image_url', image_url: { url: `data:${j.part.mime || 'image/jpeg'};base64,${j.part.base64}` } }
          ]
        }]
      });
      j.text = r.content.trim();
    } catch (err) {
      if (err.code === 'aborted' || err.status === 401) throw err;
      warnings.push(`Image « ${j.part.label} » non lue : ${err.message}`);
      j.text = '';
    }
    done++;
    progress({ step: 'vision', message: `Image ${done}/${images.length} transcrite`, done, total: images.length });
  });
  for (const [k, j] of audios.entries()) {
    progress({ step: 'audio', message: `Transcription audio ${k + 1}/${audios.length}…` });
    try {
      j.text = await client.transcribeAudio({ base64: j.part.base64, filename: j.part.filename, mime: j.part.mime, model: s.audioModel, signal });
    } catch (err) {
      if (err.code === 'aborted' || err.status === 401) throw err;
      warnings.push(`Audio « ${j.part.label} » non transcrit : ${err.message}`);
      j.text = '';
    }
  }
  const sources = jobs
    .map((j) => ({
      file: j.file,
      role: j.role,
      label: j.part.label || j.file,
      kind: j.part.type === 'text' ? (j.part.fromPdf ? 'pdf-page' : 'text') : j.part.type,
      text: j.part.type === 'text' ? (j.part.lang && !/markdown/.test(j.part.lang) ? '```' + j.part.lang + '\n' + j.part.text + '\n```' : j.part.text) : j.text
    }))
    .filter((x) => x.text && x.text.trim());
  return { sources, warnings };
}

async function runCorrection({ client, sources, consigne, settings: s, progress, signal }) {
  const { sources: fitted, truncated } = fitSources(sources, s.maxInputChars);
  const warnings = [];
  if (truncated) warnings.push(`Les documents dépassent ${s.maxInputChars.toLocaleString('fr-FR')} caractères : certaines parties ont été tronquées (réglable dans les Paramètres).`);
  const messages = [
    { role: 'system', content: buildSystemPrompt(s) },
    { role: 'user', content: buildUserMessage(fitted, consigne) }
  ];
  const models = [s.correctionModel, ...s.fallbackModels.filter((m) => m && m !== s.correctionModel)];
  let lastErr;
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      progress({ step: 'correction', message: `Correction en cours avec ${model}${attempt ? ' (nouvel essai)' : ''}…` });
      try {
        const r = await client.chat({
          model,
          messages,
          json: true,
          temperature: 0.2,
          maxTokens: attempt ? 16384 : 8192,
          reasoningEffort: s.reasoningEffort,
          signal
        });
        if (r.finishReason === 'length' && attempt === 0) continue;
        const parsed = parseJsonLoose(r.content);
        const result = normalizeResult(parsed, s.gradeMax);
        if (model !== s.correctionModel) warnings.push(`Le modèle principal n'a pas pu être utilisé ; correction réalisée avec ${model}.`);
        return { result, model: r.model, warnings };
      } catch (err) {
        lastErr = err;
        if (err.code === 'aborted' || err.status === 401) throw err;
        if (err instanceof GroqError && !err.canFallback && err.status !== 400) throw err;
        if (err instanceof GroqError) break; // modèle suivant
        // JSON invalide : nouvel essai, puis modèle suivant
      }
    }
  }
  const hint = lastErr && /tokens|too large|413/i.test(`${lastErr.message} ${lastErr.code}`)
    ? ' Les documents sont trop volumineux pour les limites de votre offre Groq : réduisez le nombre de fichiers ou la limite de caractères dans les Paramètres.'
    : '';
  throw new Error(`La correction a échoué : ${lastErr?.message || 'erreur inconnue'}.${hint}`);
}

/**
 * Point d'entrée : fichiers extraits -> correction complète.
 */
async function correct({ apiKey, files, consigne, settings, progress = () => {}, signal, fetchImpl }) {
  const s = { ...DEFAULTS, ...settings };
  const client = new GroqClient(apiKey, { fetchImpl });
  const { sources, warnings } = await buildSources(files, client, s, progress, signal);
  if (!sources.length) throw new Error("Aucun contenu exploitable n'a pu être extrait des fichiers fournis.");
  const out = await runCorrection({ client, sources, consigne, settings: s, progress, signal });
  return { ...out, sources, warnings: [...warnings, ...out.warnings] };
}

/** Relance une correction à partir des sources déjà transcrites (aucune nouvelle lecture d'image). */
async function recorrect({ apiKey, sources, consigne, settings, progress = () => {}, signal, fetchImpl }) {
  const s = { ...DEFAULTS, ...settings };
  const client = new GroqClient(apiKey, { fetchImpl });
  const out = await runCorrection({ client, sources, consigne, settings: s, progress, signal });
  return { ...out, sources };
}

module.exports = { correct, recorrect, normalizeResult, buildName, fitSources, parseJsonLoose, buildSystemPrompt, DEFAULTS, EXERCISE_TYPES, TYPE_LABELS };
