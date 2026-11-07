'use strict';
/**
 * Gestion des limites des modèles :
 *  - estimation du nombre de jetons d'une requête ;
 *  - limites propres à chaque modèle (fenêtre de contexte, sortie max, jetons par minute),
 *    lues dans la liste des modèles, dans les en-têtes de réponse ou apprises à partir des erreurs ;
 *  - régulateur de débit : on attend la réinitialisation du quota plutôt que d'échouer.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Estimation prudente (texte français + code ≈ 3,2 caractères par jeton). */
function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 3.2);
}

const IMAGE_TOKENS = 1600;

function estimateMessages(system, messages) {
  let n = estimateTokens(system) + 20;
  for (const m of messages || []) {
    if (typeof m.content === 'string') n += estimateTokens(m.content) + 8;
    else for (const c of m.content) n += c.type === 'image' ? IMAGE_TOKENS : estimateTokens(c.text) + 8;
  }
  return n;
}

/** « 1m2.5s », « 7.66s », « 120ms » -> millisecondes */
function parseDuration(s) {
  if (!s) return null;
  const str = String(s).trim();
  if (/^\d+(\.\d+)?$/.test(str)) return Number(str) * 1000;
  let ms = 0;
  const re = /([\d.]+)\s*(ms|h|m|s)/g;
  let m;
  let found = false;
  while ((m = re.exec(str))) {
    found = true;
    const v = Number(m[1]);
    ms += m[2] === 'ms' ? v : m[2] === 's' ? v * 1000 : m[2] === 'm' ? v * 60000 : v * 3600000;
  }
  return found ? ms : null;
}

/** Extrait des limites d'un message d'erreur d'API. */
function limitsFromError(message) {
  const msg = String(message || '');
  const out = {};
  const maxOut = msg.match(/max(?:_completion)?_tokens`?\s*(?:must be|should be)?\s*(?:less than or equal to|<=|at most)\s*`?(\d+)/i)
    || msg.match(/maximum (?:value|number) (?:for|of) `?max(?:_completion)?_tokens`? (?:is|of) `?(\d+)/i)
    || msg.match(/max_tokens: \d+ > (\d+)/i);
  if (maxOut) out.maxOut = Number(maxOut[1]);
  const tpm = msg.match(/tokens per minute[^]*?limit\s*:?\s*(\d+)/i) || msg.match(/\(TPM\)[^]*?limit\s*:?\s*(\d+)/i);
  if (tpm) out.tpm = Number(tpm[1]);
  const ctx = msg.match(/context (?:length|window)[^\d]{0,40}(\d{4,7})/i) || msg.match(/maximum context length is (\d+)/i);
  if (ctx) out.context = Number(ctx[1]);
  const tpd = /tokens per day|\(TPD\)/i.test(msg);
  if (tpd) out.dailyExhausted = true;
  return out;
}

/** Erreur « trop gros pour une seule requête » : le code appelant découpe le travail. */
function isSizeError(err) {
  const txt = `${err?.code || ''} ${err?.message || ''}`.toLowerCase();
  if (/tokens per day|\(tpd\)/.test(txt)) return false;
  return err?.status === 413 || err?.code === 'too_large' || /context_length|context length|context window|request too large|too many tokens|reduce the length|tokens per minute|\(tpm\)|prompt is too long|input is too long/.test(txt);
}

/**
 * Mémoire des limites par modèle (persistée) + quotas glissants (en mémoire).
 * store : { get(): obj, set(obj) }
 */
class LimitBook {
  constructor(store) {
    this.store = store || { get: () => ({}), set: () => {} };
    this.rate = new Map(); // clé -> { limit, remaining, resetAt }
  }

  key(provider, model) {
    return `${provider}:${model}`;
  }

  get(provider, model) {
    const all = this.store.get() || {};
    return { ...(all[this.key(provider, model)] || {}) };
  }

  learn(provider, model, patch) {
    const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v != null && v !== false && !Number.isNaN(v)));
    if (!Object.keys(clean).length) return;
    const all = this.store.get() || {};
    const k = this.key(provider, model);
    const cur = all[k] || {};
    // Une limite apprise par erreur ne peut que baisser
    const merged = { ...cur };
    for (const [f, v] of Object.entries(clean)) merged[f] = f in cur && typeof v === 'number' && ['maxOut', 'tpm', 'context'].includes(f) && clean.fromError ? Math.min(cur[f], v) : v;
    delete merged.fromError;
    merged.updatedAt = Date.now();
    all[k] = merged;
    this.store.set(all);
  }

  /** En-têtes x-ratelimit-* renvoyés par Groq / OpenAI. */
  fromHeaders(provider, model, headers) {
    if (!headers?.get) return;
    const limit = Number(headers.get('x-ratelimit-limit-tokens'));
    const remaining = Number(headers.get('x-ratelimit-remaining-tokens'));
    const reset = parseDuration(headers.get('x-ratelimit-reset-tokens'));
    if (!limit) return;
    this.rate.set(this.key(provider, model), { limit, remaining: Number.isFinite(remaining) ? remaining : limit, resetAt: Date.now() + (reset ?? 60000) });
    const known = this.get(provider, model);
    if (known.tpm !== limit) this.learn(provider, model, { tpm: limit });
  }

  /** Limites effectives (avec valeurs par défaut prudentes). */
  limits(provider, model) {
    const l = this.get(provider, model);
    return { context: l.context || 32768, maxOut: l.maxOut || 8192, tpm: l.tpm || Infinity };
  }

  /**
   * Attend si la requête dépasserait le quota de la minute en cours.
   * Renvoie le temps attendu (ms).
   */
  async waitFor(provider, model, tokens, { onWait, signal } = {}) {
    const r = this.rate.get(this.key(provider, model));
    if (!r) return 0;
    const now = Date.now();
    if (r.resetAt <= now) {
      r.remaining = r.limit;
      return 0;
    }
    if (tokens <= r.remaining) {
      r.remaining -= tokens;
      return 0;
    }
    const wait = Math.min(65000, r.resetAt - now + 400);
    onWait?.(wait);
    const t0 = Date.now();
    while (Date.now() - t0 < wait) {
      if (signal?.aborted) return Date.now() - t0;
      await sleep(Math.min(500, wait - (Date.now() - t0)));
    }
    r.remaining = Math.max(0, r.limit - tokens);
    r.resetAt = Date.now() + 60000;
    return wait;
  }
}

module.exports = { estimateTokens, estimateMessages, parseDuration, limitsFromError, isSizeError, LimitBook, IMAGE_TOKENS };
