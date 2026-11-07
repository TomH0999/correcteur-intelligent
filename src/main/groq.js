'use strict';
/** Client minimal pour l'API Groq (compatible OpenAI), avec reprises automatiques. */

const BASE = 'https://api.groq.com/openai/v1';

class GroqError extends Error {
  constructor(message, status, code, body) {
    super(message);
    this.status = status;
    this.code = code;
    this.body = body;
  }
  /** Erreur liée à la taille de la requête ou au modèle : on peut essayer un autre modèle. */
  get canFallback() {
    const txt = `${this.code} ${this.message}`.toLowerCase();
    return (
      this.status === 413 ||
      this.status === 404 ||
      txt.includes('model_decommissioned') ||
      txt.includes('model_not_found') ||
      txt.includes('does not exist') ||
      txt.includes('context_length') ||
      txt.includes('tokens per minute') ||
      txt.includes('tokens per day') ||
      txt.includes('request too large') ||
      txt.includes('json_validate_failed') ||
      txt.includes('not support')
    );
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class GroqClient {
  constructor(apiKey, { fetchImpl } = {}) {
    if (!apiKey) throw new GroqError("Aucune clé API Groq n'est configurée. Ouvrez les Paramètres pour l'ajouter.", 401, 'no_key');
    this.apiKey = apiKey;
    this.fetch = fetchImpl || globalThis.fetch;
  }

  async request(endpoint, init, { retries = 4, signal } = {}) {
    let attempt = 0;
    for (;;) {
      let res;
      try {
        res = await this.fetch(BASE + endpoint, {
          ...init,
          signal,
          headers: { Authorization: `Bearer ${this.apiKey}`, ...(init.headers || {}) }
        });
      } catch (err) {
        if (signal?.aborted) throw new GroqError('Correction annulée.', 0, 'aborted');
        if (attempt++ < retries) { await sleep(1500 * attempt); continue; }
        throw new GroqError(`Impossible de joindre Groq (${err.message}). Vérifiez votre connexion internet.`, 0, 'network');
      }
      if (res.ok) return res.json();
      const text = await res.text();
      let body;
      try { body = JSON.parse(text); } catch { body = { error: { message: text } }; }
      const msg = body?.error?.message || res.statusText;
      const code = body?.error?.code || body?.error?.type || '';
      const err = new GroqError(msg, res.status, code, body);
      // 429 : limite de débit -> on attend (sauf si la requête est simplement trop grosse pour la limite)
      const tooBigForLimit = /requested\s+(\d+)/i.test(msg) && /limit\s+(\d+)/i.test(msg) && Number(msg.match(/requested\s+(\d+)/i)[1]) > Number(msg.match(/limit\s+(\d+)/i)[1]);
      if ((res.status === 429 && !tooBigForLimit) || res.status >= 500) {
        if (attempt++ < retries) {
          const ra = Number(res.headers.get('retry-after'));
          const fromMsg = msg.match(/try again in ([\d.]+)(ms|s|m)/i);
          let wait = ra ? ra * 1000 : 2000 * attempt;
          if (fromMsg) wait = Number(fromMsg[1]) * (fromMsg[2] === 'ms' ? 1 : fromMsg[2] === 'm' ? 60000 : 1000) + 500;
          await sleep(Math.min(wait, 65000));
          continue;
        }
      }
      if (res.status === 429 && tooBigForLimit) err.code = 'tokens per minute';
      if (res.status === 401) err.message = 'Clé API Groq invalide ou expirée. Vérifiez-la dans les Paramètres.';
      throw err;
    }
  }

  async chat({ model, messages, json = false, temperature = 0.2, maxTokens = 8192, reasoningEffort, signal }) {
    const body = { model, messages, temperature, max_completion_tokens: maxTokens };
    if (json) body.response_format = { type: 'json_object' };
    if (reasoningEffort && /gpt-oss/.test(model)) body.reasoning_effort = reasoningEffort;
    const data = await this.request('/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }, { signal });
    const choice = data.choices?.[0];
    return { content: choice?.message?.content || '', finishReason: choice?.finish_reason, usage: data.usage, model: data.model || model };
  }

  async transcribeAudio({ base64, filename, mime, model = 'whisper-large-v3', signal }) {
    const form = new FormData();
    form.append('file', new Blob([Buffer.from(base64, 'base64')], { type: mime }), filename);
    form.append('model', model);
    form.append('response_format', 'json');
    const res = await this.request('/audio/transcriptions', { method: 'POST', body: form }, { signal });
    return res.text || '';
  }

  async listModels() {
    const data = await this.request('/models', { method: 'GET' }, { retries: 1 });
    return (data.data || []).filter((m) => m.active !== false).map((m) => m.id).sort();
  }
}

module.exports = { GroqClient, GroqError };
