import { api, $, $$, esc, toast, modal } from '../ui.js';
import { register, go, state } from '../router.js';
import { processPdf, normalizeImage } from '../pdf.js';

const files = [];
let seq = 0;
let busy = false;
let mounted = false;
let unlisten = null;

const KIND_ICON = { text: 'fa-file-lines', image: 'fa-image', audio: 'fa-microphone', pdf: 'fa-file-pdf' };
const FORMATS = ['PDF (même scannés)', 'Photos de copies', 'Captures (Ctrl+V)', 'Word', 'PowerPoint', 'Excel', 'LibreOffice', 'Code source', 'SQL', 'Jupyter', 'draw.io (MCD/UML)', '.zip / dossiers', 'Audio'];

function template() {
  return `
    <p class="page-intro">Importe l'énoncé, tes réponses et (si tu l'as) le barème ou corrigé du prof — en un ou plusieurs fichiers, dans n'importe quel format. L'IA identifie elle-même chaque document, exécute ton code pour le vérifier, puis corrige.</p>
    <div id="key-warning" class="banner warn hidden"><i class="fa-solid fa-key"></i><span>Aucune clé API n'est configurée pour le fournisseur d'IA choisi. <a href="#" data-goto="settings">Ouvrir les réglages</a></span></div>
    <div id="dropzone" class="dropzone" tabindex="0">
      <div class="dz-icon"><i class="fa-solid fa-cloud-arrow-up"></i></div>
      <div class="dz-title">Glisse tes fichiers ou dossiers ici</div>
      <div class="dz-sub">ou utilise les boutons ci-dessous. Tu peux aussi coller une capture d'écran avec Ctrl+V.</div>
      <div class="dz-actions">
        <button class="btn primary" id="btn-pick"><i class="fa-solid fa-file-import"></i>Choisir des fichiers</button>
        <button class="btn" id="btn-pick-folder"><i class="fa-solid fa-folder-open"></i>Choisir un dossier</button>
        <button class="btn" id="btn-phone"><i class="fa-solid fa-qrcode"></i>Photo depuis le téléphone</button>
      </div>
      <div class="formats">${FORMATS.map((f) => `<span>${f}</span>`).join('')}</div>
    </div>
    <div id="file-list" class="file-list"></div>
    <div class="card tight">
      <label class="label" for="consigne"><i class="fa-solid fa-comment-dots"></i> Indications pour le correcteur (facultatif)</label>
      <textarea id="consigne" rows="2" placeholder="Ex. : TD2 de R1.05, exercice 3 uniquement · barème sur 10 · SQL Oracle · ne pas pénaliser l'orthographe…"></textarea>
    </div>
    <div class="row" style="justify-content:flex-end;margin-top:16px">
      <button class="btn ghost" id="btn-clear"><i class="fa-solid fa-trash-can"></i>Tout effacer</button>
      <button class="btn primary big" id="btn-correct" disabled><i class="fa-solid fa-wand-magic-sparkles"></i><span>Lancer la correction</span></button>
    </div>
    <div id="progress" class="card progress-card hidden">
      <div class="spinner"></div>
      <div style="flex:1">
        <div id="progress-title" style="font-weight:600;color:#fff">Correction en cours…</div>
        <div class="bar"><div id="progress-bar"></div></div>
        <ul id="progress-log" class="progress-log"></ul>
      </div>
      <button class="btn sm" id="btn-cancel"><i class="fa-solid fa-xmark"></i>Annuler</button>
    </div>`;
}

async function addPaths(paths) {
  for (const p of paths) {
    if (!p || files.some((f) => f.path === p)) continue;
    const f = { id: ++seq, path: p, name: p.split(/[\\/]/).pop() || p, status: 'loading', parts: [], warnings: [], role: 'auto', info: 'Lecture…' };
    files.push(f);
    renderFiles();
    processFile(f);
  }
}

async function normalizeParts(f, parts) {
  const out = [];
  for (const p of parts) {
    if (p.type === 'pdf') {
      const r = await processPdf(p.base64, p.label, state.settings?.pdfMode || 'auto', (i, n) => {
        f.info = `PDF : page ${i}/${n}…`;
        renderFiles();
      });
      out.push(...r.parts);
      f.warnings.push(...r.warnings);
    } else if (p.type === 'image') {
      try {
        out.push({ ...p, ...(await normalizeImage(p.base64, p.mime)) });
      } catch {
        f.warnings.push(`${p.label} : image illisible.`);
      }
    } else out.push(p);
  }
  return out;
}

function summarize(f) {
  const count = (t) => f.parts.filter((p) => p.type === t).length;
  const chars = f.parts.filter((p) => p.type === 'text').reduce((s, p) => s + p.text.length, 0);
  const bits = [];
  if (chars) bits.push(`${chars.toLocaleString('fr-FR')} caractères de texte`);
  if (count('image')) bits.push(`${count('image')} image(s) à lire par l'IA`);
  if (count('audio')) bits.push(`${count('audio')} audio`);
  f.info = bits.join(' · ') || 'Aucun contenu exploitable';
  f.status = f.parts.length ? 'ready' : 'error';
  f.thumb = f.parts.find((p) => p.type === 'image');
}

async function processFile(f) {
  try {
    const res = await api.extract(f.path);
    f.name = res.name || f.name;
    f.warnings = res.warnings || [];
    f.parts = await normalizeParts(f, res.parts);
    summarize(f);
  } catch (err) {
    f.status = 'error';
    f.info = err.message;
  }
  renderFiles();
}

/** Ajoute un fichier déjà en mémoire (capture collée, photo du téléphone). */
export async function addMemoryFile(name, mime, base64) {
  const f = { id: ++seq, path: `${name}#${seq}`, name, status: 'loading', parts: [], warnings: [], role: 'auto', info: 'Lecture…' };
  files.push(f);
  renderFiles();
  f.parts = await normalizeParts(f, [{ type: mime === 'application/pdf' ? 'pdf' : 'image', mime, base64, label: name }]);
  summarize(f);
  renderFiles();
}

function renderFiles() {
  const list = $('#file-list');
  if (!list) return;
  list.innerHTML = files.map((f) => `
    <div class="file-item ${f.status}" data-id="${f.id}">
      <div class="file-thumb">${f.thumb ? `<img src="data:${f.thumb.mime};base64,${f.thumb.base64}" alt="" />` : f.status === 'loading' ? '<div class="spinner sm"></div>' : `<i class="fa-solid ${KIND_ICON[f.parts[0]?.type] || 'fa-file'}"></i>`}</div>
      <div class="file-main">
        <div class="file-name" title="${esc(f.path)}">${esc(f.name)}</div>
        <div class="file-info">${esc(f.info)}</div>
        ${f.warnings.length ? `<div class="file-warn"><i class="fa-solid fa-triangle-exclamation"></i> ${f.warnings.map(esc).join('<br>')}</div>` : ''}
      </div>
      <select class="role" title="Rôle du fichier (laisse « Auto » pour que l'IA décide)">
        <option value="auto" ${f.role === 'auto' ? 'selected' : ''}>🤖 Auto (l'IA décide)</option>
        <option value="enonce" ${f.role === 'enonce' ? 'selected' : ''}>📋 Énoncé</option>
        <option value="reponse" ${f.role === 'reponse' ? 'selected' : ''}>✍️ Mes réponses</option>
        <option value="bareme" ${f.role === 'bareme' ? 'selected' : ''}>⚖️ Barème / corrigé du prof</option>
      </select>
      <button class="icon-btn danger remove" title="Retirer"><i class="fa-solid fa-xmark"></i></button>
    </div>`).join('');
  $$('.file-item', list).forEach((el) => {
    const f = files.find((x) => x.id === Number(el.dataset.id));
    $('.remove', el).onclick = () => {
      files.splice(files.indexOf(f), 1);
      renderFiles();
    };
    $('.role', el).onchange = (e) => (f.role = e.target.value);
  });
  const ready = files.filter((f) => f.status === 'ready');
  const loading = files.some((f) => f.status === 'loading');
  const btn = $('#btn-correct');
  btn.disabled = !ready.length || loading || busy;
  $('span', btn).textContent = loading ? 'Lecture des fichiers…' : `Lancer la correction${ready.length ? ` (${ready.length} fichier${ready.length > 1 ? 's' : ''})` : ''}`;
}

async function runCorrection() {
  if (!state.settings?.hasApiKey) {
    toast('Ajoute d\'abord une clé API dans les réglages.', 'error');
    go('settings');
    return;
  }
  const payload = files.filter((f) => f.status === 'ready').map((f) => ({ name: f.name, role: f.role, parts: f.parts }));
  if (!payload.length) return;
  busy = true;
  renderFiles();
  const prog = $('#progress');
  prog.classList.remove('hidden');
  $('#progress-log').innerHTML = '';
  $('#progress-bar').style.width = '4%';
  $('#progress-title').textContent = 'Préparation…';
  prog.scrollIntoView({ behavior: 'smooth', block: 'center' });
  unlisten = api.onProgress((p) => {
    $('#progress-title').textContent = p.message;
    const li = document.createElement('li');
    li.textContent = p.message;
    $('#progress-log').appendChild(li);
    const pct = { models: 8, vision: 10 + 35 * ((p.done || 0) / (p.total || 1)), audio: 48, tests: 55, correction: 70, save: 97 }[p.step] ?? 10;
    $('#progress-bar').style.width = `${pct}%`;
  });
  try {
    const { id, warnings } = await api.correct({ files: payload, consigne: $('#consigne').value.trim() });
    warnings?.forEach((w) => toast(w, 'warn', 9000));
    files.length = 0;
    $('#consigne').value = '';
    renderFiles();
    go('result', { id });
  } catch (err) {
    toast(err.message, 'error', 12000);
  } finally {
    unlisten?.();
    busy = false;
    prog.classList.add('hidden');
    renderFiles();
  }
}

async function phoneDialog() {
  let info;
  try {
    info = await api.phoneStart();
  } catch (err) {
    toast(err.message, 'error', 8000);
    return;
  }
  await modal({
    title: 'Envoyer des photos depuis le téléphone',
    icon: 'fa-qrcode',
    hideOk: true,
    cancelLabel: 'Terminer',
    body: `
      <div class="qr-box">
        <img src="${info.qr}" alt="QR code" />
        <div>
          <ol class="muted" style="padding-left:18px;margin:0 0 12px">
            <li>Connecte ton téléphone au <strong>même Wi-Fi</strong> que ce PC.</li>
            <li>Scanne ce QR code avec l'appareil photo.</li>
            <li>Prends tes pages en photo : elles arrivent ici automatiquement.</li>
          </ol>
          <div class="xs dim">Adresse : <span class="mono">${esc(info.url)}</span></div>
          ${info.urls.length > 1 ? `<details class="xs dim" style="margin-top:6px"><summary>Le QR code ne marche pas ? Autres adresses</summary>${info.urls.slice(1).map((u) => `<div class="mono">${esc(u)}</div>`).join('')}</details>` : ''}
          <div class="xs dim" style="margin-top:8px"><i class="fa-solid fa-shield-halved"></i> Lien privé (jeton aléatoire), actif 30 minutes. Si Windows demande l'accès au réseau, autorise les réseaux privés.</div>
          <div id="phone-received" class="badge brand" style="margin-top:12px"><i class="fa-solid fa-image"></i> 0 photo reçue</div>
        </div>
      </div>`,
    onOpen: (b) => {
      let n = 0;
      const off = api.onPhoneFile(() => {
        n++;
        const el = $('#phone-received', b);
        if (el) el.innerHTML = `<i class="fa-solid fa-image"></i> ${n} photo${n > 1 ? 's' : ''} reçue${n > 1 ? 's' : ''}`;
      });
      b._off = off;
    }
  }).then((b) => b?._off?.());
  api.phoneStop();
}

function mount(root) {
  root.innerHTML = template();
  const dz = $('#dropzone', root);
  $('#btn-pick', root).onclick = async (e) => { e.stopPropagation(); addPaths(await api.pickFiles()); };
  $('#btn-pick-folder', root).onclick = async (e) => { e.stopPropagation(); addPaths(await api.pickFolder()); };
  $('#btn-phone', root).onclick = (e) => { e.stopPropagation(); phoneDialog(); };
  dz.onclick = async () => addPaths(await api.pickFiles());
  $('#btn-correct', root).onclick = runCorrection;
  $('#btn-cancel', root).onclick = () => api.cancel();
  $('#btn-clear', root).onclick = () => { files.length = 0; renderFiles(); };

  ['dragenter', 'dragover'].forEach((ev) => document.addEventListener(ev, (e) => {
    e.preventDefault();
    if (state.current === 'new') dz.classList.add('over');
  }));
  ['dragleave', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => {
    e.preventDefault();
    if (ev === 'drop' || e.target === dz) dz.classList.remove('over');
  }));
  document.addEventListener('drop', (e) => {
    const dropped = [...(e.dataTransfer?.files || [])];
    if (!dropped.length) return;
    if (state.current !== 'new') go('new');
    addPaths(dropped.map((f) => api.pathForFile(f)));
  });
  document.addEventListener('paste', async (e) => {
    if (state.current !== 'new' || /INPUT|TEXTAREA/.test(document.activeElement?.tagName)) return;
    for (const item of e.clipboardData?.items || []) {
      if (!item.type.startsWith('image/')) continue;
      const blob = item.getAsFile();
      const b64 = await new Promise((r) => {
        const reader = new FileReader();
        reader.onload = () => r(reader.result.split(',')[1]);
        reader.readAsDataURL(blob);
      });
      addMemoryFile(`capture-${new Date().toLocaleTimeString('fr-FR').replace(/:/g, '-')}.jpg`, item.type, b64);
    }
  });
  api.onPhoneFile((f) => {
    addMemoryFile(f.name, f.mime, f.base64);
    toast(`Photo reçue du téléphone : ${f.name}`, 'ok', 2500);
  });
  mounted = true;
}

register('new', {
  title: 'Nouvelle correction',
  show(root) {
    if (!mounted) mount(root);
    $('#key-warning', root).classList.toggle('hidden', !!state.settings?.hasApiKey);
    renderFiles();
  }
});
