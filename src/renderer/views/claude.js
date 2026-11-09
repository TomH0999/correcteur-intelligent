// Correction avec Claude : choisir le cas → copier le prompt et ouvrir Claude → importer la réponse.
import { api, $, $$, esc, fr, toast, folderOptions, scoreColor } from '../ui.js';
import { register, go, state } from '../router.js';
import { refreshStats } from '../shared.js';

const LS = 'claude-builder';
let catalog = null;
let attachments = [];
let parseTimer = null;

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(LS) || '{}');
  } catch {
    return {};
  }
}
function savePrefs(p) {
  try {
    localStorage.setItem(LS, JSON.stringify(p));
  } catch { /* stockage indisponible */ }
}

/** Session en cours : ce qui a été envoyé à Claude (utilisé à l'import). */
export const session = { typeId: null, matiere: null, at: null };

function subjectOptions(selected) {
  const byFam = {};
  for (const s of catalog.subjects) (byFam[s.family] ||= []).push(s);
  return Object.entries(byFam).map(([fam, list]) => `<optgroup label="${esc(catalog.families[fam] || fam)}">${list.map((s) => `<option value="${esc(s.id)}" ${s.id === selected ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}</optgroup>`).join('');
}

function current(root) {
  return {
    type: $('.type-card.active', root)?.dataset.type || 'exo',
    matiere: $('#c-matiere', root).value,
    gradeMax: Number($('#c-sur', root).value) || 20,
    severity: $('#c-sev', root).value,
    negatif: $('#c-neg', root)?.value.trim() || '',
    hasBareme: $('#c-bareme', root).checked,
    consignes: $('#c-consignes', root).value.trim()
  };
}

async function refreshPrompt(root) {
  const o = current(root);
  savePrefs({ ...loadPrefs(), type: o.type, matiere: o.matiere, severity: o.severity, gradeMax: o.gradeMax, negatif: o.negatif });
  $('#c-neg-wrap', root).classList.toggle('hidden', o.type !== 'qcm');
  const t = catalog.types.find((x) => x.id === o.type);
  $('#c-bareme-label', root).textContent = t?.nocopy ? 'Je joins aussi le barème' : 'Je joins aussi le barème / corrigé du prof';
  const { prompt, tokens } = await api.claudePrompt(o);
  $('#c-prompt', root).textContent = prompt;
  $('#c-tokens', root).textContent = `≈ ${tokens} jetons`;
  $('#c-files-hint', root).innerHTML = t?.nocopy
    ? '<b>Joins le sujet</b> (PDF, photo…)'
    : '<b>Joins l\'énoncé et ta copie</b> (PDF, photos, captures, fichiers de code…)';
}

function renderStepImport(root, text = '') {
  $('#c-paste', root).value = text;
  attachments = [];
  renderAttachments(root);
  if (text) parseNow(root);
}

function renderAttachments(root) {
  $('#c-att-list', root).innerHTML = attachments.length
    ? attachments.map((p, i) => `<span class="chip">${esc(p.split(/[\\/]/).pop())}<button class="icon-btn xs" data-rm="${i}" title="Retirer"><i class="fa-solid fa-xmark"></i></button></span>`).join('')
    : '<span class="xs dim">Aucun fichier (facultatif : énoncé, copie… pour les retrouver plus tard)</span>';
  $$('[data-rm]', root).forEach((b) => (b.onclick = () => {
    attachments.splice(Number(b.dataset.rm), 1);
    renderAttachments(root);
  }));
}

async function parseNow(root) {
  const text = $('#c-paste', root).value.trim();
  const box = $('#c-preview', root);
  $('#c-save', root).disabled = true;
  if (!text) {
    box.innerHTML = '<p class="small muted">Colle ici la réponse de Claude : le bloc <code>json</code> est repéré automatiquement, même si tu copies toute la réponse.</p>';
    return;
  }
  try {
    const out = await api.claudeParse(text, { typeId: session.typeId, matiere: session.matiere || $('#c-matiere', root).value });
    const r = out.result;
    const n = (s) => r.questions.filter((q) => q.statut === s).length;
    box.innerHTML = `
      <div class="import-ok">
        <div class="big-grade" style="color:${scoreColor(r.score_pourcentage)}">${out.annale ? '<i class="fa-solid fa-book-open"></i>' : `${fr(r.note.obtenue)}<span>/${r.note.sur}</span>`}</div>
        <div>
          <div style="font-weight:600">${esc(r.titre)}</div>
          <div class="small muted">${esc(r.matiere || '—')} · ${r.questions.length} question(s) : ${n('correct')} ✅ ${n('partiel')} 🟠 ${n('incorrect')} ❌ ${n('non_traite')} ⬜ · ${r.fautes.length} faute(s) · ${out.flashcards.length} fiche(s)</div>
          ${out.annale ? '<div class="small" style="color:var(--brand400)">Corrigé de sujet : enregistré sans compter dans tes statistiques.</div>' : ''}
        </div>
      </div>
      ${out.warnings.map((w) => `<div class="small" style="color:var(--amber)"><i class="fa-solid fa-triangle-exclamation"></i> ${esc(w)}</div>`).join('')}`;
    if (!$('#c-title', root).dataset.touched) $('#c-title', root).value = r.titre;
    $('#c-save', root).disabled = !r.questions.length && !out.annale;
  } catch (err) {
    box.innerHTML = `<div class="small" style="color:var(--rose)"><i class="fa-solid fa-circle-exclamation"></i> ${esc(err.message)}</div>
      <p class="xs dim">Si Claude a répondu en texte, demande-lui simplement : « Donne le bloc JSON ci ».</p>`;
  }
}

async function render(root, params) {
  catalog = await api.claudeCatalog();
  const p = loadPrefs();
  const s = state.settings;
  const project = s.claudeMode === 'project';
  const series = await api.seriesChoices(null).catch(() => []);
  root.innerHTML = `
    <div class="card claude-hero">
      <div>
        <h2 style="margin:0"><i class="fa-solid fa-wand-magic-sparkles"></i>Corriger avec Claude</h2>
        <p class="small muted" style="margin:6px 0 0">1. Choisis le cas · 2. Ouvre Claude avec le prompt prêt et joins tes fichiers · 3. Colle sa réponse ici : tout est enregistré dans ta base.</p>
      </div>
      <div class="row wrap">
        <span class="tag ${project ? 'ok' : 'mid'}" title="Réglages → Claude">${project ? '<i class="fa-solid fa-bolt"></i> Mode projet (économe)' : 'Mode prompt complet'}</span>
        ${project ? '' : '<button class="btn sm" data-goto="settings" id="c-to-proj"><i class="fa-solid fa-bolt"></i>Économiser des jetons</button>'}
      </div>
    </div>

    <div class="card">
      <h2><span class="step-n">1</span>Quel type d'évaluation ?</h2>
      <div class="type-grid">
        ${catalog.types.map((t) => `<button class="type-card ${t.id === (p.type || 'exo') ? 'active' : ''}" data-type="${t.id}"><i class="fa-solid ${t.icon}"></i><b>${esc(t.label)}</b><span>${esc(t.desc)}</span></button>`).join('')}
      </div>
      <div class="grid3" style="margin-top:14px">
        <div class="field"><label class="label">Matière</label><select id="c-matiere">${subjectOptions(p.matiere || catalog.subjects[0]?.id)}</select></div>
        <div class="field"><label class="label">Note sur</label><input id="c-sur" type="number" min="1" max="1000" value="${p.gradeMax || s.gradeMax || 20}" /></div>
        <div class="field"><label class="label">Sévérité</label><select id="c-sev">${['indulgente', 'normale', 'stricte (comme un examen)'].map((v) => `<option ${v === (p.severity || s.severity) ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
        <div class="field hidden" id="c-neg-wrap"><label class="label">QCM : points par réponse fausse</label><input id="c-neg" placeholder="ex. -0,5 (vide = 0)" value="${esc(p.negatif || '')}" /></div>
      </div>
      <label class="check" style="margin-top:8px"><input type="checkbox" id="c-bareme" /><span id="c-bareme-label">Je joins aussi le barème / corrigé du prof</span></label>
      <div class="field" style="margin-top:8px"><label class="label">Consignes particulières (facultatif)</label><input id="c-consignes" placeholder="ex. exercice 2 seulement · SQL Oracle imposé · ne pas pénaliser l'orthographe" /></div>
    </div>

    <div class="card">
      <h2><span class="step-n">2</span>Ouvre Claude avec le prompt</h2>
      <div class="row wrap" style="gap:10px">
        <button class="btn primary big" id="c-open"><i class="fa-solid fa-arrow-up-right-from-square"></i>Copier le prompt et ouvrir Claude</button>
        <button class="btn" id="c-copy"><i class="fa-regular fa-copy"></i>Copier seulement</button>
        <span class="small muted" id="c-tokens"></span>
      </div>
      <ol class="howto">
        <li>Dans Claude : <b>colle</b> le prompt (Ctrl+V) s'il n'est pas déjà rempli.</li>
        <li><span id="c-files-hint"></span> avec le trombone ou en les glissant, puis envoie.</li>
        <li>Copie la réponse de Claude (bouton « Copier » sous sa réponse) et reviens ici : elle est détectée automatiquement.</li>
      </ol>
      <details class="src"><summary>Voir le prompt</summary><pre class="prompt-pre" id="c-prompt"></pre></details>
    </div>

    <div class="card" id="c-import">
      <h2><span class="step-n">3</span>Importer la correction de Claude</h2>
      <div class="row wrap" style="gap:10px;margin-bottom:8px">
        <button class="btn" id="c-from-clip"><i class="fa-solid fa-paste"></i>Coller depuis le presse-papiers</button>
        <span class="xs dim">ou colle directement dans la zone ci-dessous</span>
      </div>
      <textarea id="c-paste" rows="6" placeholder="Réponse de Claude (avec le bloc json)…"></textarea>
      <div id="c-preview" class="import-preview"></div>
      <div class="grid2" style="margin-top:12px">
        <div class="field"><label class="label">Titre</label><input id="c-title" placeholder="Titre de la correction" /></div>
        <div class="field"><label class="label">Dossier</label><select id="c-folder"><option value="">— Aucun dossier —</option>${folderOptions(state.folders, null)}</select></div>
        <div class="field"><label class="label">Lien de la conversation Claude (pour y revenir)</label><input id="c-url" placeholder="https://claude.ai/chat/…" /></div>
        <div class="field"><label class="label">C'est une nouvelle tentative de…</label><select id="c-series"><option value="">— Nouvel exercice —</option>${series.map((x) => `<option value="${esc(x.key)}">${esc(x.title)}${x.subject ? ` (${esc(x.subject)})` : ''} · ${x.count} tentative(s)</option>`).join('')}</select></div>
      </div>
      <div class="row wrap" style="margin-top:10px;gap:8px">
        <button class="btn sm" id="c-att"><i class="fa-solid fa-paperclip"></i>Joindre l'énoncé / ma copie</button>
        <div id="c-att-list" class="row wrap" style="gap:6px"></div>
      </div>
      <div class="row between wrap" style="margin-top:14px">
        <label class="check"><input type="checkbox" id="c-counted" checked /><span>Enregistrer<small>Compte dans l'historique et la progression (décoche pour un brouillon)</small></span></label>
        <button class="btn primary big" id="c-save" disabled><i class="fa-solid fa-floppy-disk"></i>Enregistrer la correction</button>
      </div>
    </div>`;
  bind(root);
  await refreshPrompt(root);
  renderStepImport(root, params?.paste || '');
  if (params?.paste) $('#c-import', root).scrollIntoView({ behavior: 'smooth' });
  else parseNow(root);
}

function bind(root) {
  $$('.type-card', root).forEach((b) => (b.onclick = () => {
    $$('.type-card', root).forEach((x) => x.classList.toggle('active', x === b));
    refreshPrompt(root);
  }));
  ['#c-matiere', '#c-sur', '#c-sev', '#c-neg', '#c-bareme'].forEach((sel) => ($(sel, root).onchange = () => refreshPrompt(root)));
  $('#c-consignes', root).oninput = () => {
    clearTimeout(parseTimer);
    parseTimer = setTimeout(() => refreshPrompt(root), 300);
  };
  const remember = () => {
    const o = current(root);
    session.typeId = o.type;
    session.matiere = o.matiere;
    session.at = Date.now();
  };
  $('#c-open', root).onclick = async () => {
    remember();
    const { prompt } = await api.claudePrompt(current(root));
    const r = await api.claudeOpen({ prompt });
    toast(r.prefilled ? 'Claude s\'ouvre avec le prompt prérempli (aussi copié). Joins tes fichiers puis envoie.' : 'Prompt copié : colle-le dans Claude (Ctrl+V), joins tes fichiers puis envoie.', 'ok', 7000);
  };
  $('#c-copy', root).onclick = async () => {
    remember();
    await api.writeClipboard($('#c-prompt', root).textContent);
    toast('Prompt copié.', 'ok');
  };
  $('#c-from-clip', root).onclick = async () => {
    const t = await api.readClipboard();
    if (!t.trim()) return toast('Le presse-papiers est vide.', 'warn');
    $('#c-paste', root).value = t;
    parseNow(root);
  };
  $('#c-paste', root).oninput = () => {
    clearTimeout(parseTimer);
    parseTimer = setTimeout(() => parseNow(root), 250);
  };
  $('#c-title', root).oninput = (e) => (e.target.dataset.touched = '1');
  $('#c-att', root).onclick = async () => {
    const paths = await api.pickFiles();
    attachments.push(...paths.filter((x) => !attachments.includes(x)));
    renderAttachments(root);
  };
  $('#c-save', root).onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const url = $('#c-url', root).value.trim();
      if (url && !/^https:\/\/claude\.ai\//.test(url)) throw new Error('Le lien doit commencer par https://claude.ai/');
      const { id, warnings } = await api.claudeSave({
        text: $('#c-paste', root).value,
        attachments,
        meta: {
          typeId: session.typeId || current(root).type,
          matiere: session.matiere || current(root).matiere,
          titre: $('#c-title', root).value.trim(),
          folderId: Number($('#c-folder', root).value) || null,
          claudeUrl: url,
          exerciseKey: $('#c-series', root).value || null,
          counted: $('#c-counted', root).checked
        }
      });
      warnings?.forEach((w) => toast(w, 'warn', 8000));
      toast('Correction enregistrée.', 'ok');
      session.typeId = null;
      session.matiere = null;
      lastImported = $('#c-paste', root).value.trim();
      refreshStats();
      go('result', { id });
    } catch (err) {
      toast(err.message, 'error', 8000);
      btn.disabled = false;
    }
  };
}

// ---------- Détection automatique d'une réponse de Claude dans le presse-papiers ----------
let lastSeen = '';
let lastImported = '';
export async function checkClipboard() {
  try {
    const t = (await api.readClipboard()).trim();
    if (!t || t === lastSeen || t === lastImported) return;
    lastSeen = t;
    if (!(await api.claudeLooksLike(t))) return;
    if (state.current === 'claude') {
      const area = $('#c-paste');
      if (area && !area.value.trim()) {
        area.value = t;
        area.dispatchEvent(new Event('input'));
        $('#c-import')?.scrollIntoView({ behavior: 'smooth' });
        toast('Réponse de Claude détectée et collée : vérifie puis enregistre.', 'ok', 6000);
      }
      return;
    }
    toast('Une correction de Claude est dans ton presse-papiers.', 'info', 12000, { label: 'Importer', onClick: () => go('claude', { paste: t }) });
  } catch { /* presse-papiers indisponible */ }
}

register('claude', {
  title: 'Corriger avec Claude',
  show: render
});
