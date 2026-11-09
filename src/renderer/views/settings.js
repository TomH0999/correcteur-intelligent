import { api, $, $$, esc, toast, confirmBox, modal } from '../ui.js';
import { register, state } from '../router.js';
import { refreshStats } from '../shared.js';

let selectedProvider = null;

function modelSelect(id, list, current, { allowNone = false, autoLabel = 'Automatique (recommandé)' } = {}) {
  const opts = [`<option value="auto">${autoLabel}</option>`];
  for (const m of list) opts.push(`<option value="${esc(m)}" ${m === current ? 'selected' : ''}>${esc(m)}</option>`);
  if (current && current !== 'auto' && !list.includes(current)) opts.push(`<option value="${esc(current)}" selected>${esc(current)} (introuvable — remplacé automatiquement)</option>`);
  return `<select id="${id}" ${allowNone ? '' : ''}>${opts.join('')}</select>`;
}

async function loadModels(root, providerId) {
  const box = $('#s-models', root);
  const s = state.settings;
  const prov = s.providers.find((p) => p.id === providerId);
  if (!prov.hasKey) {
    box.innerHTML = '<p class="small muted">Ajoute une clé API pour afficher les modèles disponibles sur ton compte.</p>';
    return;
  }
  box.innerHTML = '<div class="row small muted"><div class="spinner sm"></div>Lecture de la liste des modèles de ton compte…</div>';
  try {
    const d = await api.describeModels(providerId, true);
    const tested = d.visionTested || {};
    const visionList = d.vision.length ? d.vision : d.chat;
    box.innerHTML = `
      <div class="grid2">
        <div class="field"><label class="label">Modèle de correction</label>${modelSelect('s-model', d.correction, s.correctionModel)}<span class="xs dim">Auto : ${esc(d.correction[0] || '—')}</span></div>
        <div class="field"><label class="label">Modèle de vision (images, manuscrits, schémas)</label>${modelSelect('s-vision', visionList.map((m) => m), s.visionModel)}<span class="xs dim">${Object.entries(tested).map(([m, ok]) => `${ok ? '✅' : '❌'} ${esc(m)}`).join(' · ') || 'Les modèles sont testés avec une petite image avant d\'être utilisés.'}</span></div>
        <div class="field"><label class="label">Transcription audio</label>${d.audio.length ? modelSelect('s-audio', d.audio, s.audioModel) : '<input disabled value="Non proposée par ce fournisseur (Groq ou OpenAI utilisés si une clé existe)" />'}</div>
      </div>
      <p class="xs dim" style="margin:10px 0 0"><i class="fa-solid fa-circle-check" style="color:var(--emerald)"></i> ${d.all.length} modèles lus en direct sur ton compte ${esc(prov.label)}. Si un modèle disparaît, l'application en choisit un autre automatiquement.</p>
      <div class="row" style="margin-top:12px"><button class="btn sm" id="s-resolve"><i class="fa-solid fa-stethoscope"></i>Vérifier la configuration</button><span class="small" id="s-resolve-out"></span></div>`;
    $('#s-resolve', root).onclick = async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      $('#s-resolve-out', root).innerHTML = '<span class="muted">Test en cours…</span>';
      try {
        const r = await api.resolveModels();
        $('#s-resolve-out', root).innerHTML = `<span style="color:var(--emerald)">✓ Correction : <b>${esc(r.main)}</b> · Vision : <b>${esc(r.vision || 'OCR local')}</b> · Audio : <b>${esc(r.audio || '—')}</b></span>${r.notes.length ? `<div class="xs dim">${r.notes.map(esc).join('<br>')}</div>` : ''}`;
      } catch (err) {
        $('#s-resolve-out', root).innerHTML = `<span style="color:var(--rose)">✗ ${esc(err.message)}</span>`;
      }
      btn.disabled = false;
    };
  } catch (err) {
    box.innerHTML = `<div class="banner warn"><i class="fa-solid fa-triangle-exclamation"></i><span>${esc(err.message)}</span></div>`;
  }
}

function updateText(u) {
  return {
    dev: 'Version de développement : mises à jour désactivées.',
    idle: 'En attente de vérification.',
    checking: 'Recherche d\'une mise à jour…',
    uptodate: `✓ Tu as la dernière version.${u.checkedAt ? ` (vérifié à ${new Date(u.checkedAt).toLocaleTimeString('fr-FR')})` : ''}`,
    downloading: `Téléchargement de la version ${u.version || ''}… ${u.progress || 0} %`,
    ready: `Version ${u.version} prête : elle s'installera à la fermeture de l'application.`,
    error: `Impossible de vérifier : ${u.error || 'erreur inconnue'}`
  }[u.status] || '';
}

async function render(root) {
  const s = (state.settings = await api.getSettings());
  const info = (state.info ||= await api.info());
  selectedProvider = selectedProvider || s.provider;
  const prov = s.providers.find((p) => p.id === selectedProvider);
  const upd = await api.updateState();
  root.innerHTML = `
    <div class="card">
      <h2><i class="fa-solid fa-robot"></i>Intelligence artificielle</h2>
      <p class="small muted" style="margin-top:-6px">Choisis le service qui corrige. Groq et Gemini ont une offre gratuite ; Ollama fonctionne hors ligne sur ton PC.</p>
      <div class="provider-grid">${s.providers.map((p) => `
        <button class="provider ${p.id === selectedProvider ? 'active' : ''}" data-p="${p.id}">
          <b>${esc(p.label)} ${p.id === s.provider ? '<i class="fa-solid fa-circle-check" style="color:var(--emerald)"></i>' : ''}</b>
          <small>${p.hasKey ? (p.noKey ? 'aucune clé nécessaire' : `clé : ${esc(p.apiKeyHint)}`) : 'pas de clé'}${p.free ? ' · gratuit' : ''}</small>
        </button>`).join('')}</div>
      <div class="card-inner" style="margin-top:16px">
        ${prov.noKey ? `
          <div class="field"><label class="label">Adresse du serveur Ollama</label><input id="s-ollama" value="${esc(s.ollamaUrl || 'http://localhost:11434/v1')}" /></div>
          <p class="xs dim">Installe Ollama (<a href="#" data-external="${prov.keyUrl}">ollama.com</a>) puis un modèle, par ex. <span class="mono">ollama pull qwen3</span> et <span class="mono">ollama pull qwen2.5vl</span> pour la vision.</p>` : `
          <label class="label">Clé API ${esc(prov.label)} — à créer sur <a href="#" data-external="${prov.keyUrl}">${esc(prov.keyUrl.replace('https://', ''))}</a></label>
          <div class="row">
            <input id="s-key" type="password" autocomplete="off" placeholder="${prov.hasKey ? `Clé enregistrée (${esc(prov.apiKeyHint)}) — colle une nouvelle clé pour la remplacer` : esc(prov.keyHint || '')}" />
            <button class="icon-btn" id="s-eye" title="Afficher"><i class="fa-solid fa-eye"></i></button>
            <button class="btn" id="s-test"><i class="fa-solid fa-plug-circle-check"></i>Tester</button>
            <button class="btn primary" id="s-save-key"><i class="fa-solid fa-floppy-disk"></i>Enregistrer</button>
            ${prov.hasKey ? '<button class="btn danger" id="s-del-key" title="Supprimer la clé"><i class="fa-solid fa-trash-can"></i></button>' : ''}
          </div>
          <div class="xs dim" id="s-key-status" style="margin-top:6px"><i class="fa-solid fa-lock"></i> La clé est chiffrée sur ce PC (coffre-fort Windows) et n'est jamais exportée.</div>`}
        ${selectedProvider !== s.provider ? `<button class="btn primary" id="s-use" style="margin-top:12px" ${prov.hasKey ? '' : 'disabled'}><i class="fa-solid fa-check"></i>Utiliser ${esc(prov.label)} pour corriger</button>` : ''}
      </div>
      ${selectedProvider === s.provider ? '<div id="s-models" style="margin-top:16px"></div>' : ''}
    </div>

    <div class="card">
      <h2><i class="fa-solid fa-sliders"></i>Correction</h2>
      <div class="grid2">
        <div class="field"><label class="label">Niveau</label><select id="s-level">${['BUT Informatique — 1re année', 'BUT Informatique — 2e année', 'BUT Informatique — 3e année', 'Licence informatique', 'BTS SIO', 'Lycée — spécialité NSI'].map((l) => `<option ${l === s.level ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="field"><label class="label">Sévérité</label><select id="s-sev"><option value="indulgente">Indulgente</option><option value="normale">Normale</option><option value="stricte (comme un examen)">Stricte (comme un examen)</option></select></div>
        <div class="field"><label class="label">Vitesse de correction</label><select id="s-speed">
          <option value="rapide">Rapide — raisonnement court (≈ 30 s)</option>
          <option value="equilibre">Équilibré (recommandé)</option>
          <option value="approfondi">Approfondi — raisonnement poussé, plus lent</option></select>
          <span class="xs dim">Les tâches secondaires (repérage, synthèse, fiches) utilisent toujours un modèle rapide.</span></div>
        <div class="field"><label class="label">Barème (note sur)</label><input id="s-grade" type="number" min="1" max="1000" value="${s.gradeMax}" /></div>
        <div class="field"><label class="label">Analyse des PDF</label><select id="s-pdf">
          <option value="auto">Auto : texte + image des pages scannées, manuscrites ou avec figures</option>
          <option value="always">Toujours analyser l'image de chaque page (plus précis, plus lent)</option>
          <option value="text">Texte seulement (le plus rapide)</option></select></div>
        <div class="field"><label class="label">Taille max. analysée (caractères) — au-delà des limites du modèle, la correction est découpée automatiquement</label><input id="s-max" type="number" min="4000" step="1000" value="${s.maxInputChars}" /></div>
      </div>
      <label class="check" style="margin-top:12px"><input type="checkbox" id="s-exec" ${s.executeCode ? 'checked' : ''} /><span>Exécuter mon code pour vérifier les réponses<small>Python, JavaScript et SQL intégrés ; Java, C, C++, PHP si installés sur le PC. Les tests sont écrits pendant la correction, sans appel supplémentaire.</small></span></label>
      <label class="check"><input type="checkbox" id="s-preread" ${s.preread !== false ? 'checked' : ''} /><span>Lire les images dès leur ajout<small>Les photos et scans sont transcrits pendant que tu ajoutes tes fichiers : la correction démarre ensuite immédiatement.</small></span></label>
      <label class="check"><input type="checkbox" id="s-cards" ${s.autoFlashcards ? 'checked' : ''} /><span>Créer automatiquement des fiches de révision après chaque correction<small>À partir des fautes et des notions à revoir.</small></span></label>
      <div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn primary" id="s-save"><i class="fa-solid fa-floppy-disk"></i>Enregistrer</button></div>
    </div>

    <div class="card">
      <h2><i class="fa-solid fa-cloud-arrow-down"></i>Mises à jour automatiques</h2>
      <p class="small muted" style="margin-top:-6px">Les nouvelles versions sont téléchargées en arrière-plan depuis GitHub et installées à la fermeture : plus besoin de réinstaller l'application.</p>
      <label class="check"><input type="checkbox" id="s-auto-upd" ${s.autoUpdate ? 'checked' : ''} /><span>Rechercher et installer les mises à jour automatiquement</span></label>
      <div class="row wrap" style="margin-top:8px">
        <button class="btn" id="s-check-upd"><i class="fa-solid fa-rotate"></i>Rechercher maintenant</button>
        <button class="btn primary ${upd.status === 'ready' ? '' : 'hidden'}" id="s-install-upd"><i class="fa-solid fa-download"></i>Redémarrer et installer</button>
        <span class="small muted" id="s-upd-txt">${esc(updateText(upd))}</span>
      </div>
    </div>

    <div class="card">
      <h2><i class="fa-solid fa-shield-halved"></i>Données, sauvegarde et synchronisation</h2>
      <div class="banner info"><i class="fa-solid fa-lock"></i><span>Tes corrections sont stockées <strong>uniquement sur ce PC</strong>, dans une base propre à cette installation. Seul le contenu à corriger est envoyé au fournisseur d'IA choisi. Rien n'est partagé entre ordinateurs, sauf si tu actives la synchronisation ci-dessous.</span></div>
      <dl class="kv">
        <dt>Dossier de données</dt><dd><a href="#" id="s-open-data">${esc(info.dataDir)}</a></dd>
        <dt>Identifiant d'installation</dt><dd class="mono">${esc(info.installId)}</dd>
        <dt>Version</dt><dd>${esc(info.version)}${info.packaged ? '' : ' (développement — base séparée)'}</dd>
      </dl>
      <h3>Sauvegarde</h3>
      <div class="row wrap">
        <button class="btn" id="s-export"><i class="fa-solid fa-file-export"></i>Exporter une sauvegarde</button>
        <button class="btn" id="s-import"><i class="fa-solid fa-file-import"></i>Importer (fusionner)</button>
        <button class="btn danger" id="s-restore"><i class="fa-solid fa-clock-rotate-left"></i>Restaurer (remplacer)</button>
      </div>
      <h3>Synchronisation entre tes PC (facultatif)</h3>
      <p class="small muted" style="margin-top:0">Choisis un dossier synchronisé par OneDrive, Google Drive pour ordinateur ou Dropbox. Chaque PC y dépose sa sauvegarde chiffrée par le service cloud et fusionne celles des autres, sans doublon.</p>
      <div class="row wrap">
        ${s.syncDir ? `<span class="badge ok"><i class="fa-solid fa-cloud"></i>${esc(s.syncDir)}</span>
          <button class="btn sm" id="s-sync-now"><i class="fa-solid fa-arrows-rotate"></i>Synchroniser maintenant</button>
          <button class="btn sm danger" id="s-sync-off">Désactiver</button>
          <span class="xs dim">${s.lastSyncAt ? `Dernière synchro : ${new Date(s.lastSyncAt).toLocaleString('fr-FR')}` : ''}</span>`
        : '<button class="btn" id="s-sync-dir"><i class="fa-solid fa-folder-open"></i>Choisir le dossier synchronisé</button>'}
      </div>
    </div>

    <div class="card">
      <h2><i class="fa-solid fa-clock-rotate-left"></i>Sauvegardes automatiques</h2>
      <p class="small muted" style="margin-top:-6px">Tes données sont conservées lors des mises à jour (elles ne sont jamais dans le dossier de l'application). Par sécurité, une copie est faite automatiquement chaque jour, avant chaque mise à jour et avant toute réinitialisation ou restauration (10 dernières conservées).</p>
      <div class="list" id="s-autobk"><div class="small dim">Chargement…</div></div>
      <div class="row" style="margin-top:10px"><button class="btn sm" id="s-open-bk"><i class="fa-solid fa-folder-open"></i>Ouvrir le dossier des sauvegardes</button></div>
    </div>

    <div class="card danger-zone">
      <h2><i class="fa-solid fa-triangle-exclamation"></i>Réinitialiser l'application</h2>
      <p class="small muted" style="margin-top:-6px">Efface les données de cette installation. Une sauvegarde automatique est créée juste avant : tu pourras tout récupérer depuis la liste ci-dessus.</p>
      <button class="btn danger" id="s-reset"><i class="fa-solid fa-rotate-left"></i>Réinitialiser…</button>
    </div>`;
  $('#s-sev', root).value = s.severity;
  $('#s-pdf', root).value = s.pdfMode;
  $('#s-speed', root).value = s.speedMode || 'equilibre';
  bind(root, s, prov);
  if (selectedProvider === s.provider) loadModels(root, s.provider);
}

function bind(root, s, prov) {
  $$('[data-p]', root).forEach((b) => (b.onclick = () => { selectedProvider = b.dataset.p; render(root); }));
  $('#s-eye', root)?.addEventListener('click', () => { const i = $('#s-key', root); i.type = i.type === 'password' ? 'text' : 'password'; });
  $('#s-test', root)?.addEventListener('click', async () => {
    $('#s-key-status', root).textContent = 'Test en cours…';
    try {
      const r = await api.testApiKey(prov.id, $('#s-key', root).value.trim());
      $('#s-key-status', root).innerHTML = `<span style="color:var(--emerald)">✓ Clé valide — ${r.count} modèles disponibles.</span>`;
    } catch (err) {
      $('#s-key-status', root).innerHTML = `<span style="color:var(--rose)">✗ ${esc(err.message)}</span>`;
    }
  });
  $('#s-save-key', root)?.addEventListener('click', async () => {
    const key = $('#s-key', root).value.trim();
    if (!key) return toast('Colle ta clé API dans le champ.', 'warn');
    try {
      await api.testApiKey(prov.id, key);
    } catch (err) {
      if (!(await confirmBox('Clé non vérifiée', `Le test a échoué (${err.message}). Enregistrer quand même ?`, 'Enregistrer'))) return;
    }
    state.settings = await api.setApiKey(prov.id, key);
    // Première clé : ce fournisseur devient celui utilisé
    if (!s.providers.find((p) => p.id === s.provider)?.hasKey) state.settings = await api.saveSettings({ provider: prov.id });
    toast('Clé API enregistrée.', 'ok');
    refreshStats();
    render(root);
  });
  $('#s-del-key', root)?.addEventListener('click', async () => {
    if (!(await confirmBox('Supprimer la clé', `Supprimer la clé ${prov.label} de ce PC ?`))) return;
    state.settings = await api.setApiKey(prov.id, '');
    render(root);
  });
  $('#s-ollama', root)?.addEventListener('change', async (e) => { state.settings = await api.saveSettings({ ollamaUrl: e.target.value.trim() }); });
  $('#s-use', root)?.addEventListener('click', async () => {
    state.settings = await api.saveSettings({ provider: prov.id, correctionModel: 'auto', visionModel: 'auto', audioModel: 'auto' });
    toast(`${prov.label} est maintenant utilisé pour corriger.`, 'ok');
    refreshStats();
    render(root);
  });
  $('#s-save', root).onclick = async () => {
    const patch = {
      level: $('#s-level', root).value,
      severity: $('#s-sev', root).value,
      gradeMax: Number($('#s-grade', root).value),
      pdfMode: $('#s-pdf', root).value,
      maxInputChars: Number($('#s-max', root).value),
      executeCode: $('#s-exec', root).checked,
      autoFlashcards: $('#s-cards', root).checked,
      speedMode: $('#s-speed', root).value,
      preread: $('#s-preread', root).checked
    };
    if ($('#s-model', root)) Object.assign(patch, { correctionModel: $('#s-model', root).value, visionModel: $('#s-vision', root).value });
    if ($('#s-audio', root)) patch.audioModel = $('#s-audio', root).value;
    state.settings = await api.saveSettings(patch);
    toast('Réglages enregistrés.', 'ok');
  };
  $('#s-auto-upd', root).onchange = async (e) => { state.settings = await api.saveSettings({ autoUpdate: e.target.checked }); };
  $('#s-check-upd', root).onclick = () => api.checkUpdate();
  $('#s-install-upd', root).onclick = () => api.installUpdate();
  $('#s-open-data', root).onclick = (e) => { e.preventDefault(); api.openDataFolder(); };
  $('#s-export', root).onclick = async () => {
    const p = await api.exportBackup().catch((err) => toast(err.message, 'error'));
    if (p) toast(`Sauvegarde créée : ${p}`, 'ok', 6000);
  };
  $('#s-import', root).onclick = async () => {
    try {
      const r = await api.importBackup('merge');
      if (r) toast(`Importé : ${r.corrections} correction(s), ${r.folders} dossier(s), ${r.flashcards} fiche(s), ${r.exercises} exercice(s)${r.updated ? `, ${r.updated} mise(s) à jour` : ''}.`, 'ok', 7000);
      refreshStats();
    } catch (err) { toast(err.message, 'error', 8000); }
  };
  $('#s-restore', root).onclick = async () => {
    if (!(await confirmBox('Restaurer une sauvegarde', 'Toutes les données actuelles de cette installation seront remplacées par celles de la sauvegarde. Continuer ?', 'Choisir le fichier'))) return;
    try {
      const r = await api.importBackup('replace');
      if (r) toast('Sauvegarde restaurée.', 'ok');
      refreshStats();
    } catch (err) { toast(err.message, 'error', 8000); }
  };
  $('#s-sync-dir', root)?.addEventListener('click', async () => {
    try {
      state.settings = await api.chooseSyncDir();
      toast('Synchronisation activée.', 'ok');
      refreshStats();
      render(root);
    } catch (err) { toast(err.message, 'error', 8000); }
  });
  $('#s-sync-now', root)?.addEventListener('click', async () => {
    try {
      const r = await api.syncNow();
      toast(`Synchronisé : ${r.files} autre(s) PC, ${r.imported} élément(s) récupéré(s).`, 'ok', 6000);
      refreshStats();
      render(root);
    } catch (err) { toast(err.message, 'error', 8000); }
  });
  $('#s-sync-off', root)?.addEventListener('click', async () => { state.settings = await api.disableSync(); render(root); });
  loadAutoBackups(root);
  $('#s-open-bk', root).onclick = () => api.openBackupDir();
  $('#s-reset', root).onclick = () => resetDialog(root);
  void modal;
}

const REASONS = { quotidienne: 'quotidienne', 'avant-mise-a-jour': 'avant mise à jour', 'avant-reinitialisation': 'avant réinitialisation', 'avant-restauration': 'avant restauration', auto: 'automatique' };

async function loadAutoBackups(root) {
  const box = $('#s-autobk', root);
  try {
    const list = await api.autoBackups();
    box.innerHTML = list.map((b) => `
      <div class="item" style="cursor:default">
        <div class="item-icon"><i class="fa-solid fa-box-archive"></i></div>
        <div class="item-main"><div class="item-name">${new Date(b.date).toLocaleString('fr-FR')}</div><div class="item-meta">Sauvegarde ${esc(REASONS[b.reason] || b.reason)} · v${esc(b.version)} · ${(b.size / 1024).toFixed(0)} Ko</div></div>
        <button class="btn sm" data-restore="${esc(b.file)}"><i class="fa-solid fa-clock-rotate-left"></i>Restaurer</button>
      </div>`).join('') || '<div class="small dim">Aucune sauvegarde automatique pour l\'instant (la première est créée au prochain démarrage).</div>';
    $$('[data-restore]', box).forEach((btn) => (btn.onclick = async () => {
      if (!(await confirmBox('Restaurer cette sauvegarde', 'Les données actuelles seront remplacées par celles de cette sauvegarde (une copie de l\'état actuel est faite avant). Continuer ?', 'Restaurer'))) return;
      try {
        await api.restoreAutoBackup(btn.dataset.restore);
        state.folders = await api.folders();
        toast('Sauvegarde restaurée.', 'ok');
        refreshStats();
        loadAutoBackups(root);
      } catch (err) { toast(err.message, 'error', 8000); }
    }));
  } catch (err) {
    box.innerHTML = `<div class="small" style="color:var(--rose)">${esc(err.message)}</div>`;
  }
}

async function resetDialog(root) {
  const b = await modal({
    title: 'Réinitialiser l\'application',
    icon: 'fa-triangle-exclamation',
    okLabel: 'Réinitialiser',
    danger: true,
    body: `
      <p class="small muted" style="margin-top:0">Choisis ce qui doit être effacé. Une sauvegarde automatique est faite avant.</p>
      <label class="check"><input type="checkbox" id="r-data" checked /><span>Toutes les données<small>Corrections, dossiers, fiches de révision, exercices, discussions, file d'attente, pages de copies.</small></span></label>
      <label class="check"><input type="checkbox" id="r-prefs" /><span>Les réglages<small>Fournisseur d'IA, modèles, barème, synchronisation… (valeurs par défaut).</small></span></label>
      <label class="check"><input type="checkbox" id="r-keys" /><span>Les clés API enregistrées</span></label>
      <div class="field" style="margin-top:12px"><label class="label">Pour confirmer, tape <b>RÉINITIALISER</b></label><input id="r-confirm" autocomplete="off" /></div>`,
    onOpen: (body) => {
      const ok = $('#modal-ok');
      const check = () => { ok.disabled = $('#r-confirm', body).value.trim().toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '') !== 'REINITIALISER' || !['#r-data', '#r-prefs', '#r-keys'].some((s) => $(s, body).checked); };
      check();
      body.addEventListener('input', check);
      body.addEventListener('change', check);
    }
  });
  $('#modal-ok').disabled = false;
  if (!b) return;
  const opts = { data: $('#r-data', b).checked, prefs: $('#r-prefs', b).checked, keys: $('#r-keys', b).checked };
  try {
    const r = await api.resetApp(opts);
    state.settings = r.settings;
    state.folders = await api.folders();
    toast('Application réinitialisée. Une sauvegarde de l\'état précédent a été créée.', 'ok', 7000);
    refreshStats();
    render(root);
  } catch (err) {
    toast(err.message, 'error', 8000);
  }
}

register('settings', { title: 'Réglages', show: (root) => render(root) });

export function updateStatusText(u) {
  return updateText(u);
}
