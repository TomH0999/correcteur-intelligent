'use strict';
/**
 * Sélection automatique des modèles réellement disponibles sur le compte de l'utilisateur.
 * Plus aucun identifiant figé : la liste est lue en direct (/models), les modèles de vision
 * sont vérifiés par un petit test d'image, et le résultat est mis en cache.
 */
const { PROVIDERS } = require('./providers');

const CACHE_TTL = 12 * 3600 * 1000;

// Préférences (par ordre) — utilisées seulement si le modèle figure dans la liste live du compte.
const PREFERRED = {
  groq: {
    correction: ['openai/gpt-oss-120b', 'moonshotai/kimi-k2-instruct-0905', 'moonshotai/kimi-k2-instruct', 'qwen/qwen3-32b', 'meta-models/muse-spark-open', 'qwen/qwen3.8-27b', 'openai/gpt-oss-20b', 'llama-3.3-70b-versatile'],
    vision: ['qwen/qwen3.8-27b', 'meta-models/muse-spark-open', 'qwen/qwen3.6-27b', 'meta-llama/llama-4-maverick-17b-128e-instruct', 'meta-llama/llama-4-scout-17b-16e-instruct']
  },
  anthropic: { correction: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-opus-5', 'claude-sonnet-5'], vision: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] },
  openai: { correction: ['gpt-5.5', 'gpt-5', 'gpt-5-mini', 'gpt-4.1', 'gpt-4o'], vision: ['gpt-5.5', 'gpt-5', 'gpt-5-mini', 'gpt-4.1', 'gpt-4o'] },
  gemini: { correction: ['gemini-3-pro', 'gemini-2.5-pro', 'gemini-3-flash', 'gemini-2.5-flash'], vision: ['gemini-3-flash', 'gemini-2.5-flash', 'gemini-3-pro', 'gemini-2.5-pro'] },
  ollama: { correction: ['qwen3', 'gpt-oss', 'llama3.3', 'mistral', 'gemma3'], vision: ['qwen2.5vl', 'qwen3-vl', 'llama3.2-vision', 'gemma3', 'llava', 'minicpm-v'] }
};

const NON_CHAT = /whisper|tts|speech|transcri|audio|realtime|embed|guard|moderation|playai|orpheus|distil|dall-e|image-|imagen|veo|aqa|search|computer-use|davinci|babbage|codex-mini|prompt-guard|safeguard|compound/i;
const VISION_HINT = /vision|[-_.]vl\b|vl[-:]|llava|scout|maverick|qwen3\.\d+-\d+b|muse|gemma-?3|pixtral|minicpm-v|moondream|claude|gpt-4o|gpt-4\.1|gpt-5|gemini/i;

function chatModels(ids) {
  return ids.filter((id) => !NON_CHAT.test(id));
}

/** Correspondance tolérante : préférence « gemini-2.5-pro » ↔ « gemini-2.5-pro-preview-xx », « qwen3 » ↔ « qwen3:14b ». */
function matchPreferred(prefs, ids) {
  const out = [];
  for (const p of prefs) {
    const exact = ids.find((id) => id === p);
    if (exact) { out.push(exact); continue; }
    const pref = ids.filter((id) => id.startsWith(p + '-') || id.startsWith(p + ':') || id.startsWith(p + '.')).sort((a, b) => a.length - b.length)[0];
    if (pref) out.push(pref);
  }
  return [...new Set(out)];
}

/** Score heuristique pour départager les modèles inconnus (taille, génération). */
function sizeScore(id) {
  const b = id.match(/(\d+(?:\.\d+)?)b\b/i);
  let s = b ? Number(b[1]) : 30;
  if (/pro|opus|large|120b|70b|kimi/i.test(id)) s += 100;
  if (/mini|nano|small|flash-lite|8b|instant|haiku/i.test(id)) s -= 50;
  if (/preview|exp/i.test(id)) s -= 5;
  return s;
}

function rankCorrection(provider, ids) {
  const chat = chatModels(ids);
  const pref = matchPreferred(PREFERRED[provider]?.correction || [], chat);
  const rest = chat.filter((id) => !pref.includes(id)).sort((a, b) => sizeScore(b) - sizeScore(a));
  return [...pref, ...rest];
}

function rankVision(provider, ids) {
  const chat = chatModels(ids);
  const pref = matchPreferred(PREFERRED[provider]?.vision || [], chat);
  const hinted = chat.filter((id) => !pref.includes(id) && VISION_HINT.test(id)).sort((a, b) => sizeScore(b) - sizeScore(a));
  return [...pref, ...hinted];
}

// Petite image PNG valide (carré noir 64×64) : sert à vérifier qu'un modèle accepte les images
const PROBE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAdElEQVR4nO3aQQqAMAwAQSP+/8v1D1YYCjv3QpaeApm11nWyWw+wqwCtAK0ArQCtAK0ArQCtAK0A7dl5PDN/zfF5NT/+BwrQCtAK0ArQCtAK0ArQCtAK0ArQCtCOD5iOPbACtAK0ArQCtAK0ArQCtAK04wNeYOAJe5bIu2IAAAAASUVORK5CYII=';

async function probeVision(provider, model) {
  try {
    await provider.chat({
      model,
      maxTokens: 16,
      temperature: 0,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Réponds simplement « ok ».' }, { type: 'image', mime: 'image/png', base64: PROBE_PNG }] }]
    });
    return true;
  } catch (err) {
    if (err.status === 401 || err.code === 'aborted') throw err;
    if (err.status === 429 && !err.canFallback) return null; // indéterminé
    return false;
  }
}

/**
 * Gère le cache des modèles (stocké dans les paramètres) et la résolution des choix.
 * store : { get(): cache, set(cache) }
 */
class ModelResolver {
  constructor(store) {
    this.store = store;
  }

  cacheFor(providerId) {
    const c = this.store.get() || {};
    return c[providerId] || { models: [], fetchedAt: 0, vision: {} };
  }

  saveCache(providerId, data) {
    const c = this.store.get() || {};
    c[providerId] = { ...this.cacheFor(providerId), ...data };
    this.store.set(c);
  }

  async available(provider, { force = false } = {}) {
    const cache = this.cacheFor(provider.id);
    if (!force && cache.models.length && Date.now() - cache.fetchedAt < CACHE_TTL) return cache.models;
    try {
      const models = await provider.listModels();
      // La liste a changé : on réinitialise les tests de vision des modèles disparus
      const vision = Object.fromEntries(Object.entries(cache.vision || {}).filter(([m]) => models.includes(m)));
      this.saveCache(provider.id, { models, fetchedAt: Date.now(), vision });
      return models;
    } catch (err) {
      if (err.status === 401) throw err;
      return cache.models; // hors ligne : dernière liste connue
    }
  }

  /** Liste détaillée pour l'interface (Paramètres). */
  async describe(provider, { force = false } = {}) {
    const models = await this.available(provider, { force });
    const cache = this.cacheFor(provider.id);
    return {
      all: models,
      chat: chatModels(models),
      correction: rankCorrection(provider.id, models),
      vision: rankVision(provider.id, models),
      visionTested: cache.vision || {},
      audio: models.filter((m) => /whisper|transcribe/i.test(m)),
      fetchedAt: cache.fetchedAt
    };
  }

  async resolveCorrection(provider, wanted) {
    const models = await this.available(provider);
    const ranked = rankCorrection(provider.id, models);
    const main = wanted && wanted !== 'auto' && (!models.length || models.includes(wanted)) ? wanted : ranked[0];
    if (!main) throw new Error(`Aucun modèle de texte disponible sur ton compte ${PROVIDERS[provider.id].label}.`);
    const notes = [];
    if (wanted && wanted !== 'auto' && models.length && !models.includes(wanted)) {
      notes.push(`Le modèle « ${wanted} » n'existe plus chez ${PROVIDERS[provider.id].label} : « ${main} » a été choisi automatiquement.`);
    }
    return { main, fallbacks: ranked.filter((m) => m !== main).slice(0, 3), notes };
  }

  /** Renvoie le premier modèle de vision qui accepte réellement les images (testé et mis en cache). */
  async resolveVision(provider, wanted, correctionModel) {
    const models = await this.available(provider);
    const cache = this.cacheFor(provider.id);
    const tested = { ...(cache.vision || {}) };
    let candidates = rankVision(provider.id, models);
    if (PROVIDERS[provider.id].allVision && correctionModel) candidates.unshift(correctionModel);
    if (wanted && wanted !== 'auto' && (!models.length || models.includes(wanted))) candidates.unshift(wanted);
    if (!models.length && !candidates.length) candidates = PREFERRED[provider.id]?.vision || [];
    candidates = [...new Set(candidates)];
    const notes = [];
    for (const m of candidates.slice(0, 8)) {
      if (tested[m] === false) continue;
      if (tested[m] === true) return { model: m, notes };
      const ok = await probeVision(provider, m);
      if (ok !== null) {
        tested[m] = ok;
        this.saveCache(provider.id, { vision: tested });
      }
      if (ok) return { model: m, notes };
    }
    notes.push(`Aucun modèle de vision disponible chez ${PROVIDERS[provider.id].label} : les images sont lues par l'OCR local (moins fiable pour l'écriture manuscrite).`);
    return { model: null, notes };
  }

  async resolveAudio(provider, wanted) {
    if (!PROVIDERS[provider.id].audio) return null;
    const models = await this.available(provider);
    if (wanted && wanted !== 'auto' && models.includes(wanted)) return wanted;
    const prefs = PROVIDERS[provider.id].audioModels || [];
    return matchPreferred(prefs, models)[0] || models.find((m) => /whisper|transcribe/i.test(m)) || prefs[0] || null;
  }
}

module.exports = { ModelResolver, rankCorrection, rankVision, chatModels, matchPreferred, probeVision, PREFERRED };
