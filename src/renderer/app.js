import { processPdf, normalizeImage } from './pdf.js';
import { mdToHtml, setMd, renderMath } from './markdown.js';

const api = window.api;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fr = (n) => (Math.round(Number(n) * 100) / 100).toLocaleString('fr-FR');

const TYPE_LABELS = {
  maths: 'Maths', developpement: 'Développement', base_de_donnees: 'Bases de données', reseau: 'Réseau', systeme: 'Système',
  algorithmique: 'Algorithmique', web: 'Web', genie_logiciel: 'Génie logiciel', architecture: 'Architecture', anglais: 'Anglais',
  communication: 'Communication', gestion: 'Gestion', autre: 'Autre'
};
const TYPE_ICONS = { maths: '∑', developpement: '</>', base_de_donnees: '⛁', reseau: '⇄', systeme: '$_', algorithmique: '⟳', web: '◎', genie_logiciel: '◇', architecture: '▦', anglais: 'EN', communication: '✎', gestion: '€', autre: '•' };
const STATUT = { correct: ['Correct', 'ok'], partiel: ['Partiel', 'mid'], incorrect: ['Incorrect', 'ko'], non_traite: ['Non traité', 'none'] };

const state = {
  files: [],
  settings: null,
  folders: [],
  currentFolder: null,
  currentRecord: null,
  previousView: 'history',
  busy: false
};
let fileSeq = 0;

// ---------------------------------------------------------------- utilitaires UI
function toast(msg, type = 'info', ms = 4000) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.classList.add('out'), ms);
  setTimeout(() => el.remove(), ms + 400);
}

function modal({ title, body, okLabel = 'OK', danger = false, onOpen }) {
  return new Promise((resolve) => {
    const m = $('#modal');
    $('#modal-title').textContent = title;
    const b = $('#modal-body');
    b.innerHTML = body;
    const ok = $('#modal-ok');
    ok.textContent = okLabel;
    ok.classList.toggle('danger', danger);
    m.classList.remove('hidden');
    onOpen?.(b);
    const first = b.querySelector('input, select, textarea');
    setTimeout(() => (first || ok).focus(), 30);
    const close = (val) => {
      m.classList.add('hidden');
      ok.onclick = null;
      $('#modal-cancel').onclick = null;
      m.onkeydown = null;
      resolve(val);
    };
    ok.onclick = () => close(b);
    $('#modal-cancel').onclick = () => close(null);
    m.onkeydown = (e) => {
      if (e.key === 'Escape') close(null);
      if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') close(b);
    };
  });
}

async function prompt(title, value = '', label = '') {
  const b = await modal({ title, body: `${label ? `<label class="label">${esc(label)}</label>` : ''}<input id="m-input" value="${esc(value)}" />` });
  return b ? $('#m-input', b).value.trim() : null;
}

async function confirmBox(title, text, okLabel = 'Supprimer') {
  return !!(await modal({ title, body: `<p>${esc(text)}</p>`, okLabel, danger: true }));
}

function showView(name) {
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.view === name));
  $('#main').scrollTop = 0;
  if (name === 'history') loadHistory();
  if (name === 'folders') loadFolders();
  if (name === 'settings') loadSettings();
  if (name !== 'result') state.previousView = name;
}

function scoreColor(score) {
  if (score == null) return 'var(--muted)';
  if (score >= 75) return 'var(--ok)';
  if (score >= 50) return 'var(--mid)';
  return 'var(--ko)';
}

function formatDate(iso) {
  return new Date(iso).toLocaleString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ---------------------------------------------------------------- import des fichiers
const KIND_ICON = { text: '📄', image: '🖼', audio: '🎙', pdf: '📕' };

async function addPaths(paths) {
  for (const p of paths) {
    if (!p) continue;
    if (state.files.some((f) => f.path === p)) continue;
    const name = p.split(/[\\/]/).pop() || p;
    const f = { id: ++fileSeq, path: p, name, status: 'loading', parts: [], warnings: [], role: 'auto', info: 'Lecture…' };
    state.files.push(f);
    renderFiles();
    processFile(f);
  }
}

async function processFile(f) {
  try {
    const res = await api.extract(f.path);
    f.name = res.name || f.name;
    f.warnings = res.warnings || [];
    const parts = [];
    for (const p of res.parts) {
      if (p.type === 'pdf') {
        const r = await processPdf(p.base64, p.label, state.settings?.pdfMode || 'auto', (i, n) => {
          f.info = `PDF : page ${i}/${n}…`;
          renderFiles();
        });
        parts.push(...r.parts);
        f.warnings.push(...r.warnings);
      } else if (p.type === 'image') {
        try {
          const img = await normalizeImage(p.base64, p.mime);
          parts.push({ ...p, ...img });
        } catch {
          f.warnings.push(`${p.label} : image illisible.`);
        }
      } else parts.push(p);
    }
    f.parts = parts;
    const count = (t) => parts.filter((p) => p.type === t).length;
    const chars = parts.filter((p) => p.type === 'text').reduce((s, p) => s + p.text.length, 0);
    const bits = [];
    if (chars) bits.push(`${chars.toLocaleString('fr-FR')} caractères de texte`);
    if (count('image')) bits.push(`${count('image')} image(s) à lire par l'IA`);
    if (count('audio')) bits.push(`${count('audio')} audio`);
    f.info = bits.join(' · ') || 'Aucun contenu exploitable';
    f.status = parts.length ? 'ready' : 'error';
    f.thumb = parts.find((p) => p.type === 'image');
  } catch (err) {
    f.status = 'error';
    f.info = err.message;
  }
  renderFiles();
}

function renderFiles() {
  const list = $('#file-list');
  list.innerHTML = state.files.map((f) => `
    <div class="file-item ${f.status}" data-id="${f.id}">
      <div class="file-thumb">${f.thumb ? `<img src="data:${f.thumb.mime};base64,${f.thumb.base64}" alt="" />` : `<span>${f.status === 'loading' ? '<div class="spinner small"></div>' : KIND_ICON[f.parts[0]?.type] || '📄'}</span>`}</div>
      <div class="file-main">
        <div class="file-name" title="${esc(f.path)}">${esc(f.name)}</div>
        <div class="file-info">${esc(f.info)}</div>
        ${f.warnings.length ? `<div class="file-warn">⚠ ${f.warnings.map(esc).join('<br>⚠ ')}</div>` : ''}
      </div>
      <select class="role" title="Rôle du fichier (laisse « Auto » pour que l'IA décide)">
        <option value="auto" ${f.role === 'auto' ? 'selected' : ''}>🤖 Auto</option>
        <option value="enonce" ${f.role === 'enonce' ? 'selected' : ''}>📋 Énoncé</option>
        <option value="reponse" ${f.role === 'reponse' ? 'selected' : ''}>✍ Mes réponses</option>
      </select>
      <button class="icon-btn remove" title="Retirer">✕</button>
    </div>`).join('');
  $$('.file-item', list).forEach((el) => {
    const f = state.files.find((x) => x.id === Number(el.dataset.id));
    $('.remove', el).onclick = () => {
      state.files = state.files.filter((x) => x !== f);
      renderFiles();
    };
    $('.role', el).onchange = (e) => (f.role = e.target.value);
  });
  const ready = state.files.filter((f) => f.status === 'ready');
  const loading = state.files.some((f) => f.status === 'loading');
  $('#btn-correct').disabled = !ready.length || loading || state.busy;
  $('#btn-correct').textContent = loading ? 'Lecture des fichiers…' : `Lancer la correction${ready.length ? ` (${ready.length} fichier${ready.length > 1 ? 's' : ''})` : ''}`;
}

function setupDropzone() {
  const dz = $('#dropzone');
  ['dragenter', 'dragover'].forEach((ev) => document.addEventListener(ev, (e) => {
    e.preventDefault();
    if ($('#view-new').classList.contains('active')) dz.classList.add('over');
  }));
  ['dragleave', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => {
    e.preventDefault();
    if (ev === 'drop' || e.target === dz) dz.classList.remove('over');
  }));
  document.addEventListener('drop', (e) => {
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    showView('new');
    addPaths(files.map((f) => api.pathForFile(f)));
  });
  $('#btn-pick').onclick = async (e) => {
    e.stopPropagation();
    addPaths(await api.pickFiles());
  };
  $('#btn-pick-folder').onclick = async (e) => {
    e.stopPropagation();
    addPaths(await api.pickFolder());
  };
  dz.onclick = async () => addPaths(await api.pickFiles());
  // Coller une capture d'écran (Ctrl+V)
  document.addEventListener('paste', async (e) => {
    if (!$('#view-new').classList.contains('active') || /INPUT|TEXTAREA/.test(document.activeElement?.tagName)) return;
    for (const item of e.clipboardData?.items || []) {
      if (item.type.startsWith('image/')) {
        const blob = item.getAsFile();
        const b64 = await new Promise((r) => {
          const fr2 = new FileReader();
          fr2.onload = () => r(fr2.result.split(',')[1]);
          fr2.readAsDataURL(blob);
        });
        const img = await normalizeImage(b64, item.type);
        const name = `capture-${new Date().toLocaleTimeString('fr-FR').replace(/:/g, '-')}.jpg`;
        const part = { type: 'image', ...img, label: name };
        state.files.push({ id: ++fileSeq, path: name, name, status: 'ready', parts: [part], warnings: [], role: 'auto', info: "Capture collée · 1 image à lire par l'IA", thumb: part });
        renderFiles();
      }
    }
  });
}

// ---------------------------------------------------------------- correction
let unlisten = null;

async function runCorrection() {
  if (!state.settings?.hasApiKey) {
    toast('Ajoute d\'abord ta clé API Groq dans les Paramètres.', 'error');
    showView('settings');
    return;
  }
  const files = state.files.filter((f) => f.status === 'ready').map((f) => ({ name: f.name, role: f.role, parts: f.parts }));
  if (!files.length) return;
  state.busy = true;
  renderFiles();
  const prog = $('#progress');
  prog.classList.remove('hidden');
  $('#progress-log').innerHTML = '';
  $('#progress-bar').style.width = '5%';
  $('#progress-title').textContent = 'Préparation…';
  prog.scrollIntoView({ behavior: 'smooth', block: 'center' });
  unlisten = api.onProgress((p) => {
    $('#progress-title').textContent = p.message;
    const li = document.createElement('li');
    li.textContent = p.message;
    $('#progress-log').appendChild(li);
    let pct = 10;
    if (p.step === 'vision') pct = 10 + 40 * ((p.done || 0) / (p.total || 1));
    if (p.step === 'audio') pct = 50;
    if (p.step === 'correction') pct = 65;
    if (p.step === 'save') pct = 98;
    $('#progress-bar').style.width = `${pct}%`;
  });
  try {
    const { id, warnings } = await api.correct({ files, consigne: $('#consigne').value.trim() });
    warnings?.forEach((w) => toast(w, 'warn', 8000));
    state.files = [];
    $('#consigne').value = '';
    renderFiles();
    await openRecord(id);
    refreshStats();
  } catch (err) {
    toast(err.message, 'error', 12000);
  } finally {
    unlisten?.();
    state.busy = false;
    prog.classList.add('hidden');
    renderFiles();
  }
}

// ---------------------------------------------------------------- affichage d'un résultat
async function openRecord(id) {
  const rec = await api.get(id);
  if (!rec) return toast('Correction introuvable.', 'error');
  state.currentRecord = rec;
  renderResult(rec);
  showView('result');
}

function ring(score) {
  const r = 52;
  const c = 2 * Math.PI * r;
  const off = c * (1 - Math.max(0, Math.min(100, score)) / 100);
  return `<svg viewBox="0 0 120 120" class="ring"><circle cx="60" cy="60" r="${r}" class="ring-bg"/><circle cx="60" cy="60" r="${r}" class="ring-fg" style="stroke:${scoreColor(score)};stroke-dasharray:${c};stroke-dashoffset:${off}"/></svg>`;
}

function renderResult(rec) {
  const r = rec.result;
  const el = $('#view-result');
  const folderName = state.folders.find((f) => f.id === rec.folder_id)?.name;
  const statusCount = (s) => r.questions.filter((q) => q.statut === s).length;
  el.innerHTML = `
    <div class="result-top no-print">
      <button class="btn small" id="r-back">← Retour</button>
      <div class="spacer"></div>
      <button class="btn small" id="r-folder">📁 ${folderName ? `Dans « ${esc(folderName)} »` : 'Enregistrer dans un dossier'}</button>
      <button class="btn small" id="r-rename">✎ Renommer</button>
      <button class="btn small" id="r-rerun" title="Relancer la correction sur les mêmes documents">↻ Re-corriger</button>
      <button class="btn small" id="r-md">⬇ Markdown</button>
      <button class="btn small" id="r-pdf">⬇ PDF</button>
      <button class="btn small danger" id="r-del">🗑</button>
    </div>

    <div class="result-head card">
      <div class="score">
        ${ring(r.score_pourcentage)}
        <div class="score-txt"><div class="grade">${fr(r.note.obtenue)}<span>/${r.note.sur}</span></div><div class="pct">${fr(r.score_pourcentage)} %</div></div>
      </div>
      <div class="head-main">
        <div class="tags">
          <span class="tag type">${TYPE_ICONS[r.type_exercice] || '•'} ${esc(TYPE_LABELS[r.type_exercice] || r.type_exercice)}</span>
          ${r.matiere ? `<span class="tag">${esc(r.matiere)}</span>` : ''}
          ${r.langage ? `<span class="tag">${esc(r.langage)}</span>` : ''}
        </div>
        <h1 class="r-title">${esc(r.titre)}</h1>
        <div class="r-name muted small" title="Nom dans l'historique">🔎 ${esc(rec.name)}</div>
        ${r.appreciation ? `<p class="appreciation">${esc(r.appreciation)}</p>` : ''}
        <div class="qstats">
          <span class="pill ok">${statusCount('correct')} correct</span>
          <span class="pill mid">${statusCount('partiel')} partiel</span>
          <span class="pill ko">${statusCount('incorrect')} incorrect</span>
          <span class="pill none">${statusCount('non_traite')} non traité</span>
          <span class="pill">${r.fautes.length} faute(s)</span>
        </div>
      </div>
    </div>

    <nav class="tabs no-print">
      <a href="#sec-synthese">Synthèse</a>
      <a href="#sec-questions">Questions</a>
      <a href="#sec-fautes">Fautes (${r.fautes.length})</a>
      <a href="#sec-ameliorations">Améliorations</a>
      <a href="#sec-revoir">À revoir</a>
      <a href="#sec-modele">Correction modèle</a>
      <a href="#sec-sources">Documents</a>
    </nav>

    <section class="card" id="sec-synthese">
      <h2>Synthèse</h2>
      <div class="md" data-md="resume"></div>
      ${r.points_forts.length ? `<h3>Points forts</h3><ul class="good-list">${r.points_forts.map((p) => `<li class="md-inline">${mdToHtml(p, { inline: true })}</li>`).join('')}</ul>` : ''}
      <h3>Identification automatique des documents</h3>
      <div class="ident">
        <div><strong>📋 Énoncé :</strong> ${r.identification.enonce.length ? r.identification.enonce.map(esc).join(', ') : (r.identification.enonce_present ? '—' : '<em>absent — questions déduites de tes réponses</em>')}</div>
        <div><strong>✍ Réponses :</strong> ${r.identification.reponses.map(esc).join(', ') || '—'}</div>
        ${r.identification.remarques ? `<div class="muted small">${esc(r.identification.remarques)}</div>` : ''}
      </div>
    </section>

    <section class="card" id="sec-questions">
      <h2>Détail par question</h2>
      ${r.questions.length ? `<div class="questions">${r.questions.map((q, i) => `
        <div class="q">
          <div class="q-head">
            <span class="q-num">${esc(q.numero || i + 1)}</span>
            <span class="q-title md-inline">${mdToHtml(q.intitule, { inline: true })}</span>
            <span class="pill ${STATUT[q.statut][1]}">${STATUT[q.statut][0]}</span>
            <span class="q-pts">${fr(q.points_obtenus)} / ${fr(q.points_max)}</span>
          </div>
          <div class="md q-body" data-md="q:${i}"></div>
        </div>`).join('')}</div>` : '<p class="muted">Pas de détail par question.</p>'}
    </section>

    <section class="card" id="sec-fautes">
      <h2>Rapport de fautes</h2>
      ${r.fautes.length ? r.fautes.map((f, i) => `
        <div class="faute g-${f.gravite}">
          <div class="faute-head">
            <span class="sev">${f.gravite}</span>
            <span class="cat">${esc(f.categorie.replace(/_/g, ' '))}</span>
            ${f.question ? `<span class="muted small">Question ${esc(f.question)}</span>` : ''}
          </div>
          <div class="md" data-md="f:${i}:description"></div>
          ${f.extrait ? `<div class="extrait"><div class="lbl">Ta réponse</div><pre>${esc(f.extrait)}</pre></div>` : ''}
          ${f.correction ? `<div class="fix"><div class="lbl">Correction</div><div class="md" data-md="f:${i}:correction"></div></div>` : ''}
        </div>`).join('') : '<p class="muted">Aucune faute relevée. Bravo ! 🎉</p>'}
    </section>

    <section class="card" id="sec-ameliorations">
      <h2>Améliorations possibles</h2>
      ${r.ameliorations.length ? `<div class="cards-grid">${r.ameliorations.map((a, i) => `
        <div class="mini"><div class="mini-title">💡 ${esc(a.titre)}</div><div class="md" data-md="a:${i}"></div></div>`).join('')}</div>` : '<p class="muted">—</p>'}
    </section>

    <section class="card" id="sec-revoir">
      <h2>Notions à revoir</h2>
      ${r.a_revoir.length ? `<div class="revoir">${r.a_revoir.map((a, i) => `
        <div class="rv p-${a.priorite}">
          <div class="rv-head"><span class="prio">${a.priorite}</span> <strong>${esc(a.notion)}</strong></div>
          <div class="md" data-md="rv:${i}:pourquoi"></div>
          ${a.ressources ? `<div class="res">📚 <span class="md-inline" data-md-inline="rv:${i}:ressources"></span></div>` : ''}
        </div>`).join('')}</div>` : '<p class="muted">Rien de particulier à revoir.</p>'}
    </section>

    <section class="card" id="sec-modele">
      <h2>Correction modèle</h2>
      <div class="md" data-md="modele"></div>
    </section>

    <section class="card no-print" id="sec-sources">
      <h2>Documents analysés</h2>
      <p class="muted small">Ce que l'IA a lu (texte extrait et transcription des images). Utile pour vérifier qu'un manuscrit a bien été déchiffré.</p>
      ${rec.sources.map((s, i) => `<details class="src"><summary>${esc(s.label)} <span class="muted small">· ${s.kind === 'image' ? 'image transcrite' : s.kind === 'audio' ? 'audio transcrit' : 'texte'} · ${s.text.length.toLocaleString('fr-FR')} car.</span></summary><div class="md" data-md="src:${i}"></div></details>`).join('')}
      ${rec.consigne ? `<p class="small"><strong>Indications données :</strong> ${esc(rec.consigne)}</p>` : ''}
      <p class="muted small">Modèle : ${esc(rec.model || '—')} · ${formatDate(rec.created_at)}${r.mots_cles.length ? ` · Mots-clés : ${r.mots_cles.map(esc).join(', ')}` : ''}</p>
    </section>
  `;

  // Remplissage Markdown (+ maths)
  const get = (key) => {
    const [k, i, f] = key.split(':');
    if (k === 'resume') return r.resume;
    if (k === 'modele') return r.correction_modele || '_Pas de correction modèle._';
    if (k === 'q') return r.questions[i].commentaire;
    if (k === 'f') return r.fautes[i][f];
    if (k === 'a') return r.ameliorations[i].detail;
    if (k === 'rv') return r.a_revoir[i][f];
    if (k === 'src') return rec.sources[i].text;
    return '';
  };
  $$('[data-md]', el).forEach((d) => setMd(d, get(d.dataset.md)));
  $$('[data-md-inline]', el).forEach((d) => setMd(d, get(d.dataset.mdInline), { inline: true }));
  renderMath(el);

  $('#r-back').onclick = () => showView(state.previousView || 'history');
  $('#r-folder').onclick = () => chooseFolder(rec);
  $('#r-rename').onclick = async () => {
    const name = await prompt('Renommer la correction', rec.name, 'Nom (utilisé pour la recherche dans l\'historique)');
    if (!name) return;
    await api.update(rec.id, { name });
    openRecord(rec.id);
  };
  $('#r-rerun').onclick = async (e) => {
    if (!state.settings?.hasApiKey) return toast('Clé API manquante.', 'error');
    e.target.disabled = true;
    e.target.textContent = '↻ Correction…';
    const off = api.onProgress((p) => (e.target.textContent = '↻ ' + (p.step === 'correction' ? 'Correction…' : '…')));
    try {
      const { id } = await api.recorrect(rec.id);
      toast('Nouvelle correction enregistrée.', 'ok');
      openRecord(id);
    } catch (err) {
      toast(err.message, 'error', 10000);
      e.target.disabled = false;
      e.target.textContent = '↻ Re-corriger';
    } finally {
      off();
    }
  };
  $('#r-md').onclick = async () => {
    const p = await api.exportMarkdown(rec.id).catch((err) => toast(err.message, 'error'));
    if (p) toast('Exporté : ' + p, 'ok');
  };
  $('#r-pdf').onclick = async () => {
    const p = await api.exportPdf(rec.id).catch((err) => toast(err.message, 'error'));
    if (p) toast('PDF enregistré : ' + p, 'ok');
  };
  $('#r-del').onclick = async () => {
    if (!(await confirmBox('Supprimer la correction', `Supprimer définitivement « ${rec.name} » ?`))) return;
    await api.remove(rec.id);
    toast('Correction supprimée.');
    refreshStats();
    showView(state.previousView === 'result' ? 'history' : state.previousView || 'history');
  };
  $$('.tabs a', el).forEach((a) => (a.onclick = (e) => {
    e.preventDefault();
    $(a.getAttribute('href')).scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
}

function folderOptions(folders, selected, exclude = null) {
  const byParent = {};
  folders.forEach((f) => (byParent[f.parent_id || 0] ||= []).push(f));
  const out = [];
  const walk = (pid, depth) => (byParent[pid] || []).forEach((f) => {
    if (f.id === exclude) return;
    out.push(`<option value="${f.id}" ${f.id === selected ? 'selected' : ''}>${'  '.repeat(depth)}${depth ? '└ ' : ''}${esc(f.name)}</option>`);
    walk(f.id, depth + 1);
  });
  walk(0, 0);
  return out.join('');
}

async function chooseFolder(rec) {
  state.folders = await api.folders();
  const b = await modal({
    title: 'Enregistrer dans un dossier',
    okLabel: 'Enregistrer',
    body: `
      <label class="label">Dossier existant</label>
      <select id="m-folder">
        <option value="">— Aucun (historique seulement) —</option>
        ${folderOptions(state.folders, rec.folder_id)}
      </select>
      <label class="label">…ou créer un nouveau dossier</label>
      <input id="m-newfolder" placeholder="Ex. : S1 — R1.05 Bases de données" />
      <label class="label">Nom de la correction</label>
      <input id="m-name" value="${esc(rec.name)}" />`
  });
  if (!b) return;
  let folderId = Number($('#m-folder', b).value) || null;
  const newName = $('#m-newfolder', b).value.trim();
  try {
    if (newName) folderId = await api.createFolder(newName, folderId);
    const name = $('#m-name', b).value.trim();
    await api.update(rec.id, { folderId, ...(name && name !== rec.name ? { name } : {}) });
    state.folders = await api.folders();
    toast(folderId ? 'Correction enregistrée dans le dossier.' : 'Correction retirée du dossier.', 'ok');
    refreshStats();
    openRecord(rec.id);
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---------------------------------------------------------------- listes (historique / dossiers)
function corrItem(c) {
  return `
    <div class="corr-item" data-id="${c.id}">
      <div class="corr-icon">${TYPE_ICONS[c.exercise_type] || '•'}</div>
      <div class="corr-main">
        <div class="corr-name">${esc(c.name)}</div>
        <div class="corr-meta muted small">${formatDate(c.created_at)} · ${esc(TYPE_LABELS[c.exercise_type] || '—')}${c.folder_name ? ` · 📁 ${esc(c.folder_name)}` : ''} · ${c.files.length} fichier(s)</div>
      </div>
      <div class="corr-score" style="color:${scoreColor(c.score)}">${c.grade != null ? `${fr(c.grade)}<span>/${c.grade_max}</span>` : '—'}</div>
    </div>`;
}

function bindCorrItems(root) {
  $$('.corr-item', root).forEach((el) => (el.onclick = () => openRecord(Number(el.dataset.id))));
}

let historyTimer;
async function loadHistory() {
  const search = $('#history-search').value.trim();
  const type = $('#history-type').value;
  const scope = $('#history-scope').value;
  const rows = await api.list({ search, type, folderId: scope || undefined });
  const list = $('#history-list');
  if (!rows.length) {
    list.innerHTML = `<div class="empty">${search ? 'Aucun résultat pour cette recherche.' : 'Aucune correction pour le moment. Lance ta première correction !'}</div>`;
    return;
  }
  // Groupement par jour
  const groups = {};
  rows.forEach((r) => (groups[new Date(r.created_at).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })] ||= []).push(r));
  list.innerHTML = Object.entries(groups).map(([d, items]) => `<div class="day">${esc(d)}</div>${items.map(corrItem).join('')}`).join('');
  bindCorrItems(list);
}

async function loadFolders() {
  state.folders = await api.folders();
  const tree = $('#folder-tree');
  const byParent = {};
  state.folders.forEach((f) => (byParent[f.parent_id || 0] ||= []).push(f));
  const walk = (pid, depth) => (byParent[pid] || []).map((f) => `
      <div class="tree-item ${state.currentFolder === f.id ? 'active' : ''}" data-id="${f.id}" style="padding-left:${10 + depth * 16}px">
        <span>${byParent[f.id] ? '📂' : '📁'}</span><span class="tree-name">${esc(f.name)}</span><span class="count">${f.count}</span>
      </div>${walk(f.id, depth + 1)}`).join('');
  tree.innerHTML = `
    <div class="tree-item ${state.currentFolder === 'none' ? 'active' : ''}" data-id="none"><span>🗂</span><span class="tree-name">Non classées</span></div>
    ${walk(0, 0) || '<div class="muted small pad">Aucun dossier. Crée-en un pour organiser tes corrections.</div>'}`;
  $$('.tree-item', tree).forEach((el) => (el.onclick = () => {
    state.currentFolder = el.dataset.id === 'none' ? 'none' : Number(el.dataset.id);
    loadFolders();
  }));
  // Dossier par défaut : le premier
  if (state.currentFolder == null && state.folders.length) {
    state.currentFolder = state.folders.find((f) => !f.parent_id)?.id ?? null;
    if (state.currentFolder != null) return loadFolders();
  }
  if (state.currentFolder != null && state.currentFolder !== 'none' && !state.folders.some((f) => f.id === state.currentFolder)) {
    state.currentFolder = null;
    return loadFolders();
  }
  await renderFolderContent();
}

async function renderFolderContent() {
  const box = $('#folder-content');
  const id = state.currentFolder;
  if (id == null) {
    box.innerHTML = '<div class="empty">Sélectionne ou crée un dossier.</div>';
    return;
  }
  const folder = state.folders.find((f) => f.id === id);
  const rows = await api.list({ folderId: id });
  const avg = rows.filter((r) => r.score != null);
  const mean = avg.length ? avg.reduce((s, r) => s + r.score, 0) / avg.length : null;
  box.innerHTML = `
    <div class="folder-head">
      <div>
        <h2>${folder ? esc(folder.name) : 'Corrections non classées'}</h2>
        <div class="muted small">${rows.length} correction(s)${mean != null ? ` · moyenne ${fr(mean)} %` : ''}</div>
      </div>
      ${folder ? `<div class="row gap">
        <button class="btn small" id="f-sub">＋ Sous-dossier</button>
        <button class="btn small" id="f-rename">✎ Renommer</button>
        <button class="btn small" id="f-move">↦ Déplacer</button>
        <button class="btn small danger" id="f-del">🗑</button>
      </div>` : ''}
    </div>
    <div class="corr-list">${rows.map(corrItem).join('') || '<div class="empty">Ce dossier est vide. Ouvre une correction et clique sur « Enregistrer dans un dossier ».</div>'}</div>`;
  bindCorrItems(box);
  if (!folder) return;
  $('#f-sub').onclick = async () => {
    const name = await prompt('Nouveau sous-dossier', '', `Dans « ${folder.name} »`);
    if (!name) return;
    state.currentFolder = await api.createFolder(name, folder.id);
    loadFolders();
  };
  $('#f-rename').onclick = async () => {
    const name = await prompt('Renommer le dossier', folder.name);
    if (!name) return;
    await api.renameFolder(folder.id, name).catch((e) => toast(e.message, 'error'));
    loadFolders();
  };
  $('#f-move').onclick = async () => {
    const b = await modal({
      title: 'Déplacer le dossier',
      okLabel: 'Déplacer',
      body: `<label class="label">Nouveau parent</label><select id="m-parent"><option value="">— Racine —</option>${folderOptions(state.folders, folder.parent_id, folder.id)}</select>`
    });
    if (!b) return;
    await api.moveFolder(folder.id, Number($('#m-parent', b).value) || null).catch((e) => toast(e.message, 'error'));
    loadFolders();
  };
  $('#f-del').onclick = async () => {
    if (!(await confirmBox('Supprimer le dossier', `Supprimer « ${folder.name} » et ses sous-dossiers ? Les corrections ne sont pas supprimées : elles restent dans l'historique.`))) return;
    await api.deleteFolder(folder.id);
    state.currentFolder = null;
    loadFolders();
  };
}

// ---------------------------------------------------------------- paramètres
async function loadSettings() {
  const s = (state.settings = await api.getSettings());
  $('#api-key').value = '';
  $('#api-key').placeholder = s.hasApiKey ? `Clé enregistrée (${s.apiKeyHint}) — colle une nouvelle clé pour la remplacer` : 'gsk_…';
  $('#key-status').textContent = s.apiKeyFromEnv ? 'Clé fournie par la variable d\'environnement GROQ_API_KEY.' : s.hasApiKey ? '✓ Clé enregistrée.' : 'Aucune clé enregistrée.';
  $('#set-level').value = s.level;
  $('#set-severity').value = s.severity;
  $('#set-grade').value = s.gradeMax;
  $('#set-pdf').value = s.pdfMode;
  $('#set-model').value = s.correctionModel;
  $('#set-fallback').value = (s.fallbackModels || []).join(', ');
  $('#set-vision').value = s.visionModel;
  $('#set-audio').value = s.audioModel;
  $('#set-effort').value = s.reasoningEffort;
  $('#set-maxchars').value = s.maxInputChars;
  $('#key-warning').classList.toggle('hidden', s.hasApiKey);
}

function setupSettings() {
  $('#btn-toggle-key').onclick = () => {
    const i = $('#api-key');
    i.type = i.type === 'password' ? 'text' : 'password';
  };
  $('#btn-test-key').onclick = async () => {
    $('#key-status').textContent = 'Test en cours…';
    try {
      const { models } = await api.testApiKey($('#api-key').value.trim());
      $('#key-status').textContent = `✓ Clé valide — ${models.length} modèles disponibles.`;
      $('#model-list').innerHTML = models.map((m) => `<option value="${esc(m)}">`).join('');
    } catch (err) {
      $('#key-status').textContent = '✗ ' + err.message;
    }
  };
  $('#btn-save-key').onclick = async () => {
    const key = $('#api-key').value.trim();
    if (!key) return toast('Colle ta clé API dans le champ.', 'warn');
    try {
      await api.testApiKey(key);
    } catch (err) {
      if (!(await confirmBox('Clé non vérifiée', `Le test a échoué (${err.message}). Enregistrer quand même ?`, 'Enregistrer'))) return;
    }
    state.settings = await api.setApiKey(key);
    toast('Clé API enregistrée.', 'ok');
    loadSettings();
  };
  $('#btn-save-settings').onclick = async () => {
    state.settings = await api.saveSettings({
      level: $('#set-level').value,
      severity: $('#set-severity').value,
      gradeMax: Number($('#set-grade').value),
      pdfMode: $('#set-pdf').value,
      correctionModel: $('#set-model').value.trim(),
      fallbackModels: $('#set-fallback').value,
      visionModel: $('#set-vision').value.trim(),
      audioModel: $('#set-audio').value.trim(),
      reasoningEffort: $('#set-effort').value,
      maxInputChars: Number($('#set-maxchars').value)
    });
    toast('Paramètres enregistrés.', 'ok');
    loadSettings();
  };
  $('#btn-data-folder').onclick = () => api.openDataFolder();
}

async function refreshStats() {
  const s = await api.stats();
  $('#side-stats').innerHTML = s.total
    ? `<div><strong>${s.total}</strong> correction(s)</div><div>Moyenne : <strong style="color:${scoreColor(s.avg_score)}">${fr(s.avg_score)} %</strong></div><div>${s.filed} classée(s) en dossier</div>`
    : '';
}

// ---------------------------------------------------------------- initialisation
async function init() {
  $$('.nav-item').forEach((b) => (b.onclick = () => showView(b.dataset.view)));
  document.addEventListener('click', (e) => {
    const ext = e.target.closest('[data-external]');
    if (ext) {
      e.preventDefault();
      api.openExternal(ext.dataset.external);
    }
    const go = e.target.closest('[data-goto]');
    if (go) {
      e.preventDefault();
      showView(go.dataset.goto);
    }
  });
  setupDropzone();
  setupSettings();
  $('#btn-correct').onclick = runCorrection;
  $('#btn-cancel').onclick = () => api.cancel();
  $('#btn-clear').onclick = () => {
    state.files = [];
    renderFiles();
  };
  $('#btn-new-folder').onclick = async () => {
    const name = await prompt('Nouveau dossier', '', 'Nom du dossier (ex. : S2 — R2.01 Développement orienté objets)');
    if (!name) return;
    try {
      state.currentFolder = await api.createFolder(name, null);
      loadFolders();
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  $('#history-type').innerHTML += Object.entries(TYPE_LABELS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  $('#history-search').oninput = () => {
    clearTimeout(historyTimer);
    historyTimer = setTimeout(loadHistory, 200);
  };
  $('#history-type').onchange = loadHistory;
  $('#history-scope').onchange = loadHistory;
  $('#quick-search').onkeydown = (e) => {
    if (e.key === 'Enter') {
      $('#history-search').value = e.target.value;
      showView('history');
    }
  };
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      $('#quick-search').focus();
    }
  });
  await loadSettings();
  state.folders = await api.folders();
  refreshStats();
  $('#side-foot').textContent = `v${await api.version()} · IA : Groq`;
  renderFiles();
}

init().catch((err) => toast(err.message, 'error', 10000));
