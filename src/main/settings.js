'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DEFAULTS } = require('./corrector');
const { PROVIDERS } = require('./providers');

/**
 * Paramètres de CETTE installation (fichier JSON local, jamais envoyé ailleurs).
 * Les clés API sont chiffrées avec le coffre-fort du système (DPAPI sous Windows) via safeStorage.
 */
class Settings {
  constructor(file, safeStorage) {
    this.file = file;
    this.safe = safeStorage;
    this.data = {};
    try {
      this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch { /* premier lancement */ }
    this.data.keys ||= {};
    // Migration v1.0 : une seule clé Groq
    if (this.data.apiKeyEnc || this.data.apiKeyPlain) {
      this.data.keys.groq = this.data.apiKeyEnc ? { enc: this.data.apiKeyEnc } : { plain: this.data.apiKeyPlain };
      delete this.data.apiKeyEnc;
      delete this.data.apiKeyPlain;
    }
    // Les anciens identifiants de modèles figés sont remplacés par la sélection automatique
    if (!this.data.prefsVersion) {
      if (this.data.prefs) {
        for (const k of ['correctionModel', 'visionModel', 'audioModel']) delete this.data.prefs[k];
        delete this.data.prefs.fallbackModels;
      }
      this.data.prefsVersion = 2;
    }
    // v1.2 : la taille max devient la taille totale analysée (la correction découpée gère les gros devoirs)
    if (this.data.prefsVersion < 3) {
      if (this.data.prefs && (!this.data.prefs.maxInputChars || this.data.prefs.maxInputChars <= 60000)) delete this.data.prefs.maxInputChars;
      this.data.prefsVersion = 3;
    }
    if (!this.data.installId) {
      this.data.installId = crypto.randomUUID();
      this.data.installedAt = new Date().toISOString();
    }
    this.save();
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  get installId() {
    return this.data.installId;
  }

  getKey(provider) {
    const env = { groq: 'GROQ_API_KEY', anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY' }[provider];
    if (env && process.env[env]) return process.env[env];
    const k = this.data.keys[provider];
    if (!k) return '';
    if (k.enc && this.safe?.isEncryptionAvailable()) {
      try {
        return this.safe.decryptString(Buffer.from(k.enc, 'base64'));
      } catch { return ''; }
    }
    return k.plain || '';
  }

  setKey(provider, key) {
    if (!PROVIDERS[provider]) throw new Error('Fournisseur inconnu.');
    const v = String(key || '').trim();
    if (!v) delete this.data.keys[provider];
    else if (this.safe?.isEncryptionAvailable()) this.data.keys[provider] = { enc: this.safe.encryptString(v).toString('base64') };
    else this.data.keys[provider] = { plain: v };
    this.save();
  }

  get prefs() {
    return { ...DEFAULTS, ...this.data.prefs };
  }

  /** Paramètres exposés à l'interface (sans les clés). */
  public() {
    const p = this.prefs;
    const providers = Object.entries(PROVIDERS).map(([id, info]) => {
      const key = this.getKey(id);
      return { id, label: info.label, keyUrl: info.keyUrl, keyHint: info.keyHint, noKey: !!info.noKey, free: !!info.free, audio: !!info.audio, hasKey: !!key || !!info.noKey, apiKeyHint: key ? `${key.slice(0, 4)}…${key.slice(-4)}` : '' };
    });
    return {
      ...p,
      pdfMode: p.pdfMode || 'auto',
      providers,
      hasApiKey: providers.find((x) => x.id === p.provider)?.hasKey || false,
      installId: this.data.installId,
      installedAt: this.data.installedAt,
      syncDir: this.data.syncDir || '',
      lastSyncAt: this.data.lastSyncAt || null,
      autoUpdate: this.data.autoUpdate !== false
    };
  }

  update(prefs) {
    const allowed = ['provider', 'correctionModel', 'visionModel', 'audioModel', 'maxInputChars', 'gradeMax', 'level', 'severity', 'reasoningEffort', 'speedMode', 'preread', 'pdfMode', 'executeCode', 'autoFlashcards', 'ollamaUrl'];
    const clean = {};
    for (const k of allowed) if (prefs[k] !== undefined) clean[k] = prefs[k];
    if (clean.provider && !PROVIDERS[clean.provider]) delete clean.provider;
    if (clean.speedMode && !['rapide', 'equilibre', 'approfondi'].includes(clean.speedMode)) delete clean.speedMode;
    if (clean.preread !== undefined) clean.preread = !!clean.preread;
    if (clean.maxInputChars) clean.maxInputChars = Math.max(4000, Math.min(800000, Number(clean.maxInputChars) || DEFAULTS.maxInputChars));
    if (clean.gradeMax) clean.gradeMax = Math.max(1, Math.min(1000, Number(clean.gradeMax) || 20));
    this.data.prefs = { ...this.data.prefs, ...clean };
    if (prefs.autoUpdate !== undefined) this.data.autoUpdate = !!prefs.autoUpdate;
    if (prefs.syncDir !== undefined) this.data.syncDir = prefs.syncDir || '';
    this.save();
    return this.public();
  }

  /** Réinitialisation : réglages et/ou clés API (l'identifiant d'installation est conservé). */
  reset({ prefs = false, keys = false } = {}) {
    if (prefs) {
      this.data.prefs = {};
      delete this.data.modelCache;
      delete this.data.modelLimits;
      delete this.data.syncDir;
      delete this.data.lastSyncAt;
    }
    if (keys) this.data.keys = {};
    this.save();
  }

  set(key, value) {
    this.data[key] = value;
    this.save();
  }

  get(key) {
    return this.data[key];
  }

  /** Limites apprises des modèles (contexte, sortie max, jetons/minute). */
  limitStore() {
    return { get: () => this.data.modelLimits || {}, set: (c) => { this.data.modelLimits = c; this.save(); } };
  }

  /** Cache des modèles disponibles (par fournisseur) pour ModelResolver. */
  modelStore() {
    return { get: () => this.data.modelCache || {}, set: (c) => { this.data.modelCache = c; this.save(); } };
  }
}

module.exports = { Settings };
