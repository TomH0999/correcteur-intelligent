'use strict';
/**
 * Fournisseurs d'IA interchangeables : Groq, OpenAI, Google Gemini, Anthropic Claude, Ollama (local).
 * Interface commune :
 *   chat({ model, system, messages, json, maxTokens, effort, signal }) -> { content, finishReason, model }
 *     messages : [{ role: 'user'|'assistant', content: string | [{type:'text',text} | {type:'image',mime,base64}] }]
 *   listModels() -> string[]
 *   transcribe({ base64, filename, mime, model, signal }) -> string   (si supporté)
 */

const PROVIDERS = {
  groq: {
    label: 'Groq',
    kind: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyUrl: 'https://console.groq.com/keys',
    keyHint: 'gsk_…',
    audio: true,
    free: true,
    audioModels: ['whisper-large-v3-turbo', 'whisper-large-v3']
  },
  anthropic: {
    label: 'Anthropic (Claude)',
    kind: 'anthropic',
    keyUrl: 'https://platform.claude.com/settings/keys',
    keyHint: 'sk-ant-…',
    audio: false,
    allVision: true
  },
  openai: {
    label: 'OpenAI',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    keyUrl: 'https://platform.openai.com/api-keys',
    keyHint: 'sk-…',
    audio: true,
    allVision: true,
    audioModels: ['gpt-4o-transcribe', 'whisper-1']
  },
  gemini: {
    label: 'Google Gemini',
    kind: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyUrl: 'https://aistudio.google.com/apikey',
    keyHint: 'AIza…',
    audio: false,
    allVision: true,
    free: true
  },
  ollama: {
    label: 'Ollama (local, hors ligne)',
    kind: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    keyUrl: 'https://ollama.com/download',
    noKey: true,
    audio: false,
    local: true
  }
};

class AIError extends Error {
  constructor(message, status, code, body) {
    super(message);
    this.status = status;
    this.code = code;
    this.body = body;
  }
  /** Erreur liée au modèle ou à la taille de la requête : on peut essayer un autre modèle. */
  get canFallback() {
    const txt = `${this.code} ${this.message}`.toLowerCase();
    return (
      this.status === 413 || this.status === 404 ||
      /model_decommissioned|decommissioned|model_not_found|does not exist|not found|no longer supported|deprecated|context_length|context window|tokens per minute|tokens per day|request too large|json_validate_failed|not support|unsupported|must be a string|image|invalid model|unknown model|not available/.test(txt)
    );
  }
}

const { LimitBook, estimateMessages, limitsFromError } = require('./limits');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const defaultBook = new LimitBook();

// ---------------------------------------------------------------- OpenAI-compatible (Groq, OpenAI, Gemini, Ollama)
class OpenAICompatible {
  constructor(id, apiKey, { fetchImpl, baseUrl, book } = {}) {
    this.id = id;
    this.p = PROVIDERS[id];
    this.apiKey = apiKey;
    this.baseUrl = (baseUrl || this.p.baseUrl).replace(/\/$/, '');
    this.fetch = fetchImpl || globalThis.fetch;
    this.book = book || defaultBook;
  }

  async request(endpoint, init, { retries = 4, signal } = {}) {
    let attempt = 0;
    for (;;) {
      let res;
      try {
        res = await this.fetch(this.baseUrl + endpoint, {
          ...init,
          signal,
          headers: { ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}), ...(init.headers || {}) }
        });
      } catch (err) {
        if (signal?.aborted) throw new AIError('Correction annulée.', 0, 'aborted');
        if (attempt++ < retries) { await sleep(1500 * attempt); continue; }
        const local = this.p.local ? ' Vérifie qu\'Ollama est lancé sur ce PC.' : ' Vérifie ta connexion internet.';
        throw new AIError(`Impossible de joindre ${this.p.label} (${err.message}).${local}`, 0, 'network');
      }
      if (res.ok) {
        if (init.model) this.book.fromHeaders(this.id, init.model, res.headers);
        if (init.raw) return res;
        return res.json();
      }
      const text = await res.text();
      let body;
      try { body = JSON.parse(text); } catch { body = { error: { message: text } }; }
      const e = Array.isArray(body) ? body[0]?.error : body?.error;
      const msg = (typeof e === 'string' ? e : e?.message) || res.statusText || `HTTP ${res.status}`;
      const code = e?.code || e?.type || e?.status || '';
      const err = new AIError(msg, res.status, String(code), body);
      const reqM = msg.match(/requested\s+(\d+)/i);
      const limM = msg.match(/limit\s+(\d+)/i);
      const tooBigForLimit = reqM && limM && Number(reqM[1]) > Number(limM[1]);
      if ((res.status === 429 && !tooBigForLimit) || res.status >= 500) {
        if (attempt++ < retries) {
          const ra = Number(res.headers.get?.('retry-after'));
          const fromMsg = msg.match(/try again in ([\d.]+)(ms|s|m)/i);
          let wait = ra ? ra * 1000 : 2000 * attempt;
          if (fromMsg) wait = Number(fromMsg[1]) * (fromMsg[2] === 'ms' ? 1 : fromMsg[2] === 'm' ? 60000 : 1000) + 500;
          await sleep(Math.min(wait, 65000));
          continue;
        }
      }
      if (res.status === 429 && tooBigForLimit) err.code = 'tokens per minute';
      if (init.model) {
        const learned = limitsFromError(msg);
        if (Object.keys(learned).length) this.book.learn(this.id, init.model, { ...learned, fromError: true });
      }
      if (res.status === 401 || res.status === 403) err.message = `Clé API ${this.p.label} invalide, expirée ou sans accès (${msg}). Vérifie-la dans les Paramètres.`;
      throw err;
    }
  }

  static toOpenAIContent(content) {
    if (typeof content === 'string') return content;
    return content.map((c) => (c.type === 'image'
      ? { type: 'image_url', image_url: { url: `data:${c.mime || 'image/jpeg'};base64,${c.base64}` } }
      : { type: 'text', text: c.text }));
  }

  /** Lit une réponse en flux (Server-Sent Events) et transmet le texte au fur et à mesure. */
  static async readStream(res, onDelta) {
    const ct = res.headers?.get?.('content-type') || '';
    if (!res.body?.getReader || !/event-stream/.test(ct)) {
      const data = await res.json();
      const choice = data.choices?.[0];
      const content = choice?.message?.content || '';
      if (content) onDelta?.(content, content);
      return { content, finishReason: choice?.finish_reason, model: data.model };
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let content = '';
    let finishReason = null;
    let modelName = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const j = JSON.parse(payload);
          if (j.error) throw new AIError(j.error.message || 'Erreur de flux', 500, j.error.code || '');
          const ch = j.choices?.[0];
          modelName ||= j.model;
          const d = ch?.delta?.content || '';
          if (d) {
            content += d;
            onDelta?.(d, content);
          }
          if (ch?.finish_reason) finishReason = ch.finish_reason;
        } catch (e) {
          if (e instanceof AIError) throw e;
        }
      }
    }
    return { content, finishReason, model: modelName };
  }

  async chat({ model, system, messages, json = false, maxTokens = 8192, effort, signal, temperature = 0.2, onWait, onDelta }) {
    // Jamais plus que la sortie maximale connue du modèle
    maxTokens = Math.max(16, Math.min(maxTokens, this.book.limits(this.id, model).maxOut));
    await this.book.waitFor(this.id, model, estimateMessages(system, messages) + maxTokens, { onWait, signal });
    const msgs = [];
    if (system) msgs.push({ role: 'system', content: system });
    for (const m of messages) msgs.push({ role: m.role, content: OpenAICompatible.toOpenAIContent(m.content) });
    const body = { model, messages: msgs };
    if (this.id === 'groq' || this.id === 'openai') body.max_completion_tokens = maxTokens;
    else body.max_tokens = maxTokens;
    // Les modèles de raisonnement OpenAI refusent la température
    if (this.id !== 'openai') body.temperature = temperature;
    if (json) body.response_format = { type: 'json_object' };
    if (effort && /gpt-oss/.test(model)) body.reasoning_effort = effort;
    // Réponse en flux si l'appelant veut l'afficher au fur et à mesure
    if (onDelta) body.stream = true;
    const send = async () => {
      const res = await this.request('/chat/completions', { method: 'POST', model, raw: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, { signal });
      return OpenAICompatible.readStream(res, onDelta);
    };
    let out;
    try {
      out = await send();
    } catch (err) {
      // Certains modèles n'acceptent pas le mode JSON, reasoning_effort ou le flux : nouvel essai sans
      if (err.status === 400 && (body.response_format || body.reasoning_effort || body.stream) && /response_format|json|reasoning|stream/i.test(err.message)) {
        if (/stream/i.test(err.message)) delete body.stream;
        else {
          delete body.response_format;
          delete body.reasoning_effort;
        }
        out = await send();
      } else throw err;
    }
    return { content: out.content, finishReason: out.finishReason, model: out.model || model };
  }

  async transcribe({ base64, filename, mime, model, signal }) {
    if (!this.p.audio) throw new AIError(`${this.p.label} ne propose pas de transcription audio.`, 400, 'not supported');
    const form = new FormData();
    form.append('file', new Blob([Buffer.from(base64, 'base64')], { type: mime }), filename);
    form.append('model', model);
    form.append('response_format', 'json');
    const res = await this.request('/audio/transcriptions', { method: 'POST', body: form }, { signal });
    return res.text || '';
  }

  async listModels() {
    const data = await this.request('/models', { method: 'GET' }, { retries: 1 });
    const list = (data.data || data.models || []).filter((m) => m.active !== false);
    // Groq indique la fenêtre de contexte et la sortie maximale de chaque modèle
    for (const m of list) {
      const id = String(m.id || m.name || '').replace(/^models\//, '');
      const context = Number(m.context_window || m.context_length || m.inputTokenLimit) || null;
      const maxOut = Number(m.max_completion_tokens || m.max_output_tokens || m.outputTokenLimit) || null;
      if (id && (context || maxOut)) this.book.learn(this.id, id, { context, maxOut });
    }
    return list.map((m) => String(m.id || m.name || '').replace(/^models\//, '')).filter(Boolean).sort();
  }
}

// ---------------------------------------------------------------- Anthropic (SDK officiel)
class AnthropicProvider {
  constructor(apiKey, { sdkClient, book } = {}) {
    this.id = 'anthropic';
    this.p = PROVIDERS.anthropic;
    this.book = book || defaultBook;
    if (sdkClient) this.client = sdkClient;
    else {
      const mod = require('@anthropic-ai/sdk');
      const Anthropic = mod.default || mod;
      this.Anthropic = Anthropic;
      this.client = new Anthropic({ apiKey, maxRetries: 3 });
    }
  }

  wrap(err, signal, model) {
    if (signal?.aborted) return new AIError('Correction annulée.', 0, 'aborted');
    if (model) {
      const learned = limitsFromError(err.error?.error?.message || err.message);
      if (Object.keys(learned).length) this.book.learn('anthropic', model, { ...learned, fromError: true });
    }
    const status = err.status || 0;
    const msg = err.error?.error?.message || err.message || String(err);
    const e = new AIError(msg, status, err.error?.error?.type || err.name || '');
    if (status === 401 || status === 403) e.message = `Clé API Anthropic invalide ou sans accès (${msg}). Vérifie-la dans les Paramètres.`;
    if (!status && /connection|fetch|network/i.test(msg)) e.message = `Impossible de joindre Anthropic (${msg}). Vérifie ta connexion internet.`;
    return e;
  }

  async chat({ model, system, messages, maxTokens = 16000, effort, signal, onDelta }) {
    const msgs = messages.map((m) => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : m.content.map((c) => (c.type === 'image'
        ? { type: 'image', source: { type: 'base64', media_type: c.mime || 'image/jpeg', data: c.base64 } }
        : { type: 'text', text: c.text }))
    }));
    const params = {
      model,
      max_tokens: Math.min(Math.max(maxTokens, 16000), this.book.limits('anthropic', model).maxOut === 8192 ? 64000 : this.book.limits('anthropic', model).maxOut),
      ...(system ? { system } : {}),
      messages: msgs,
      // Effort : plus élevé = correction plus approfondie
      ...(effort ? { output_config: { effort: effort === 'low' ? 'low' : effort === 'high' ? 'high' : 'medium' } } : {}),
      // Si un classifieur de sécurité refuse (faux positif, ex. exercice de cybersécurité), l'API bascule d'elle-même sur un autre modèle
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default'
    };
    let res;
    try {
      // Streaming : évite les délais d'attente HTTP sur les longues corrections
      const stream = this.client.beta.messages.stream(params, { signal });
      if (onDelta) {
        let acc = '';
        stream.on('text', (d) => {
          acc += d;
          onDelta(d, acc);
        });
      }
      res = await stream.finalMessage();
    } catch (err) {
      // Paramètres bêta non acceptés par ce modèle : nouvel essai sans eux
      if (err.status === 400 && /fallback|beta|output_config|effort/i.test(err.message || '')) {
        delete params.betas;
        delete params.fallbacks;
        delete params.output_config;
        try {
          res = await this.client.messages.stream(params, { signal }).finalMessage();
        } catch (err2) {
          throw this.wrap(err2, signal, model);
        }
      } else throw this.wrap(err, signal, model);
    }
    if (res.stop_reason === 'refusal') {
      throw new AIError(`Le modèle a refusé la requête (${res.stop_details?.category || 'sécurité'}). Essaie un autre modèle.`, 400, 'refusal');
    }
    const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    return { content: text, finishReason: res.stop_reason === 'max_tokens' ? 'length' : 'stop', model: res.model || model };
  }

  async transcribe() {
    throw new AIError('Anthropic ne propose pas de transcription audio.', 400, 'not supported');
  }

  async listModels() {
    try {
      const ids = [];
      for await (const m of this.client.models.list({ limit: 100 })) {
        ids.push(m.id);
        if (m.max_input_tokens || m.max_tokens) this.book.learn('anthropic', m.id, { context: m.max_input_tokens || null, maxOut: m.max_tokens || null });
      }
      return ids.sort();
    } catch (err) {
      throw this.wrap(err);
    }
  }
}

function createProvider(id, apiKey, opts = {}) {
  const p = PROVIDERS[id];
  if (!p) throw new AIError(`Fournisseur inconnu : ${id}`, 400, 'bad_provider');
  if (!p.noKey && !apiKey) throw new AIError(`Aucune clé API ${p.label} n'est configurée. Ouvre les Paramètres pour l'ajouter.`, 401, 'no_key');
  if (p.kind === 'anthropic') return new AnthropicProvider(apiKey, opts);
  return new OpenAICompatible(id, apiKey, opts);
}

module.exports = { PROVIDERS, AIError, createProvider, OpenAICompatible, AnthropicProvider, defaultBook };
