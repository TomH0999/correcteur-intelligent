'use strict';
const fs = require('fs');
const path = require('path');
const { DEFAULTS } = require('./corrector');

/**
 * Paramètres utilisateur (JSON). La clé API est chiffrée avec le coffre-fort du système
 * (DPAPI sous Windows) via safeStorage lorsqu'il est disponible.
 */
class Settings {
  constructor(file, safeStorage) {
    this.file = file;
    this.safe = safeStorage;
    this.data = {};
    try {
      this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch { /* premier lancement */ }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }

  getApiKey() {
    if (process.env.GROQ_API_KEY) return process.env.GROQ_API_KEY;
    const { apiKeyEnc, apiKeyPlain } = this.data;
    if (apiKeyEnc && this.safe?.isEncryptionAvailable()) {
      try {
        return this.safe.decryptString(Buffer.from(apiKeyEnc, 'base64'));
      } catch { return ''; }
    }
    return apiKeyPlain || '';
  }

  setApiKey(key) {
    const k = String(key || '').trim();
    delete this.data.apiKeyEnc;
    delete this.data.apiKeyPlain;
    if (k) {
      if (this.safe?.isEncryptionAvailable()) this.data.apiKeyEnc = this.safe.encryptString(k).toString('base64');
      else this.data.apiKeyPlain = k;
    }
    this.save();
  }

  /** Paramètres exposés à l'interface (sans la clé). */
  public() {
    const key = this.getApiKey();
    return {
      ...DEFAULTS,
      ...this.data.prefs,
      hasApiKey: !!key,
      apiKeyHint: key ? `${key.slice(0, 4)}…${key.slice(-4)}` : '',
      apiKeyFromEnv: !!process.env.GROQ_API_KEY,
      pdfMode: this.data.prefs?.pdfMode || 'auto'
    };
  }

  corrector() {
    return { ...DEFAULTS, ...this.data.prefs };
  }

  update(prefs) {
    const allowed = ['correctionModel', 'fallbackModels', 'visionModel', 'audioModel', 'maxInputChars', 'gradeMax', 'level', 'severity', 'reasoningEffort', 'pdfMode', 'theme'];
    const clean = {};
    for (const k of allowed) if (prefs[k] !== undefined) clean[k] = prefs[k];
    if (clean.maxInputChars) clean.maxInputChars = Math.max(4000, Math.min(500000, Number(clean.maxInputChars) || DEFAULTS.maxInputChars));
    if (clean.gradeMax) clean.gradeMax = Math.max(1, Math.min(1000, Number(clean.gradeMax) || 20));
    if (typeof clean.fallbackModels === 'string') clean.fallbackModels = clean.fallbackModels.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
    this.data.prefs = { ...this.data.prefs, ...clean };
    this.save();
    return this.public();
  }
}

module.exports = { Settings };
