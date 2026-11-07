// Historique, dossiers et comparaison de corrections.
import { api, $, $$, esc, fr, toast, modal, confirmBox, promptText, folderOptions, corrItem, emptyState, scoreColor, STATUT, TYPE_LABELS } from '../ui.js';
import { register, go, state } from '../router.js';
import { mdToHtml, renderMath } from '../markdown.js';
import { refreshStats } from '../shared.js';

// ======================================================= Historique
let historyMounted = false;
let historyTimer;
const selected = new Set();

function historyTemplate() {
  return `
    <p class="page-intro">Toutes tes corrections sont conservées automatiquement ici avec un nom précis (type, matière, titre, note, date). Coche deux corrections pour les comparer.</p>
    <div class="filters">
      <input id="h-search" type="search" placeholder="Rechercher par nom, matière, notion, langage, fichier…" />
      <select id="h-type"><option value="">Tous les types</option>${Object.entries(TYPE_LABELS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
      <select id="h-scope"><option value="">Toutes</option><option value="none">Non classées</option><option value="practice">Entraînements</option></select>
    </div>
    <div id="h-compare" class="banner info hidden"><i class="fa-solid fa-code-compare"></i><span id="h-compare-txt"></span><span class="spacer"></span><button class="btn sm primary" id="h-compare-go">Comparer</button><button class="btn sm ghost" id="h-compare-clear">Annuler</button></div>
    <div id="h-list" class="list"></div>`;
}

async function loadHistory() {
  const search = $('#h-search').value.trim();
  const type = $('#h-type').value;
  const scope = $('#h-scope').value;
  const rows = await api.list({ search, type, folderId: scope === 'none' ? 'none' : undefined, kind: scope === 'practice' ? 'practice' : undefined });
  const list = $('#h-list');
  if (!rows.length) {
    list.innerHTML = emptyState('fa-clock-rotate-left', search ? 'Aucun résultat pour cette recherche.' : 'Aucune correction pour le moment. Lance ta première correction !');
    return;
  }
  const groups = {};
  rows.forEach((r) => (groups[new Date(r.created_at).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })] ||= []).push(r));
  list.innerHTML = Object.entries(groups).map(([d, items]) => `<div class="day">${esc(d)}</div>${items.map((c) => corrItem(c, { selectable: true, selected: selected.has(c.id) })).join('')}`).join('');
  $$('.item', list).forEach((el) => {
    const id = Number(el.dataset.id);
    el.onclick = (e) => {
      if (e.target.classList.contains('cmp-check')) return;
      go('result', { id });
    };
    $('.cmp-check', el).onchange = (e) => {
      if (e.target.checked) {
        if (selected.size >= 2) selected.delete([...selected][0]);
        selected.add(id);
      } else selected.delete(id);
      updateCompareBar();
      loadHistory();
    };
  });
  updateCompareBar();
}

function updateCompareBar() {
  const bar = $('#h-compare');
  bar.classList.toggle('hidden', !selected.size);
  $('#h-compare-txt').textContent = selected.size === 2 ? '2 corrections sélectionnées.' : '1 correction sélectionnée : coches-en une deuxième.';
  $('#h-compare-go').disabled = selected.size !== 2;
}

register('history', {
  title: 'Historique',
  async show(root, params = {}) {
    if (!historyMounted) {
      root.innerHTML = historyTemplate();
      $('#h-search').oninput = () => { clearTimeout(historyTimer); historyTimer = setTimeout(loadHistory, 200); };
      $('#h-type').onchange = loadHistory;
      $('#h-scope').onchange = loadHistory;
      $('#h-compare-go').onclick = () => { const [a, b] = [...selected]; selected.clear(); go('compare', { a, b }); };
      $('#h-compare-clear').onclick = () => { selected.clear(); loadHistory(); };
      historyMounted = true;
    }
    if (params.search !== undefined) $('#h-search').value = params.search;
    await loadHistory();
  }
});

// ======================================================= Dossiers
let current = null;

async function renderFolders(root) {
  state.folders = await api.folders();
  const byParent = {};
  state.folders.forEach((f) => (byParent[f.parent_id || 0] ||= []).push(f));
  if (current == null && state.folders.length) current = state.folders.find((f) => !f.parent_id)?.id ?? 'none';
  if (current != null && current !== 'none' && !state.folders.some((f) => f.id === current)) current = state.folders.length ? state.folders[0].id : null;
  const walk = (pid, depth) => (byParent[pid] || []).map((f) => `
    <div class="tree-item ${current === f.id ? 'active' : ''}" data-id="${f.id}" style="padding-left:${10 + depth * 16}px">
      <i class="fa-solid ${byParent[f.id] ? 'fa-folder-open' : 'fa-folder'}"></i><span class="tree-name">${esc(f.name)}</span><span class="count">${f.count}</span>
    </div>${walk(f.id, depth + 1)}`).join('');
  root.innerHTML = `
    <div class="row between" style="margin-bottom:16px">
      <p class="page-intro" style="margin:0">Range tes corrections par semestre, ressource, SAÉ… Les dossiers peuvent contenir des sous-dossiers.</p>
      <button class="btn primary" id="f-new"><i class="fa-solid fa-folder-plus"></i>Nouveau dossier</button>
    </div>
    <div class="folders-layout">
      <div class="card tree">
        <div class="tree-item ${current === 'none' ? 'active' : ''}" data-id="none"><i class="fa-solid fa-inbox" style="color:var(--s400)"></i><span class="tree-name">Non classées</span></div>
        ${walk(0, 0) || '<div class="small dim" style="padding:10px">Aucun dossier pour l\'instant.</div>'}
      </div>
      <div id="f-content"></div>
    </div>`;
  $$('.tree-item', root).forEach((el) => (el.onclick = () => {
    current = el.dataset.id === 'none' ? 'none' : Number(el.dataset.id);
    renderFolders(root);
  }));
  $('#f-new', root).onclick = async () => {
    const name = await promptText('Nouveau dossier', '', 'Nom du dossier (ex. : S2 — R2.01 Développement orienté objets)', 'fa-folder-plus');
    if (!name) return;
    current = await api.createFolder(name, null).catch((e) => toast(e.message, 'error'));
    renderFolders(root);
  };
  await renderFolderContent(root, $('#f-content', root));
}

async function renderFolderContent(root, box) {
  if (current == null) {
    box.innerHTML = emptyState('fa-folder-tree', 'Crée ton premier dossier pour organiser tes corrections.');
    return;
  }
  const folder = state.folders.find((f) => f.id === current);
  const rows = await api.list({ folderId: current });
  const scored = rows.filter((r) => r.score != null);
  const mean = scored.length ? scored.reduce((s, r) => s + r.score, 0) / scored.length : null;
  box.innerHTML = `
    <div class="card tight" style="margin-bottom:12px">
      <div class="row between wrap">
        <div>
          <div style="font-weight:700;color:#fff;font-size:16px"><i class="fa-solid ${folder ? 'fa-folder-open' : 'fa-inbox'}" style="color:var(--amber)"></i> ${folder ? esc(folder.name) : 'Corrections non classées'}</div>
          <div class="small muted">${rows.length} correction(s)${mean != null ? ` · moyenne <strong style="color:${scoreColor(mean)}">${fr(mean, 1)} %</strong>` : ''}</div>
        </div>
        ${folder ? `<div class="row">
          <button class="btn sm" id="f-sub"><i class="fa-solid fa-plus"></i>Sous-dossier</button>
          <button class="btn sm" id="f-rename"><i class="fa-solid fa-pen"></i>Renommer</button>
          <button class="btn sm" id="f-move"><i class="fa-solid fa-arrows-up-down-left-right"></i>Déplacer</button>
          <button class="btn sm danger" id="f-del"><i class="fa-solid fa-trash-can"></i></button>
        </div>` : ''}
      </div>
    </div>
    <div class="list">${rows.map((c) => corrItem(c)).join('') || emptyState('fa-folder-open', 'Ce dossier est vide. Ouvre une correction et clique sur « Enregistrer dans un dossier ».')}</div>`;
  $$('.item', box).forEach((el) => (el.onclick = () => go('result', { id: Number(el.dataset.id) })));
  if (!folder) return;
  $('#f-sub', box).onclick = async () => {
    const name = await promptText('Nouveau sous-dossier', '', `Dans « ${folder.name} »`, 'fa-folder-plus');
    if (!name) return;
    current = await api.createFolder(name, folder.id);
    renderFolders(root);
  };
  $('#f-rename', box).onclick = async () => {
    const name = await promptText('Renommer le dossier', folder.name);
    if (!name) return;
    await api.renameFolder(folder.id, name).catch((e) => toast(e.message, 'error'));
    renderFolders(root);
  };
  $('#f-move', box).onclick = async () => {
    const b = await modal({ title: 'Déplacer le dossier', icon: 'fa-arrows-up-down-left-right', okLabel: 'Déplacer', body: `<div class="field"><label class="label">Nouveau dossier parent</label><select id="m-parent"><option value="">— Racine —</option>${folderOptions(state.folders, folder.parent_id, folder.id)}</select></div>` });
    if (!b) return;
    await api.moveFolder(folder.id, Number($('#m-parent', b).value) || null).catch((e) => toast(e.message, 'error'));
    renderFolders(root);
  };
  $('#f-del', box).onclick = async () => {
    if (!(await confirmBox('Supprimer le dossier', `Supprimer « ${folder.name} » et ses sous-dossiers ? Les corrections ne sont pas supprimées : elles restent dans l'historique.`))) return;
    await api.deleteFolder(folder.id);
    current = null;
    refreshStats();
    renderFolders(root);
  };
}

register('folders', { title: 'Dossiers', show: (root) => renderFolders(root) });

// ======================================================= Comparaison
async function pickerOptions(selectedId) {
  const rows = await api.list({ limit: 500 });
  return rows.map((r) => `<option value="${r.id}" ${r.id === selectedId ? 'selected' : ''}>${esc(r.name)}</option>`).join('');
}

const delta = (a, b, unit = '') => {
  if (a == null || b == null) return '';
  const d = b - a;
  if (Math.abs(d) < 0.005) return '<span class="delta">=</span>';
  return `<span class="delta ${d > 0 ? 'up' : 'down'}">${d > 0 ? '+' : ''}${fr(d, 2)}${unit}</span>`;
};

async function renderCompare(root, { a, b } = {}) {
  const rows = await api.list({ limit: 2 });
  if (!a && rows.length) a = rows[1]?.id || rows[0].id;
  if (!b && rows.length) b = rows[0].id === a ? rows[1]?.id : rows[0].id;
  const opts = await pickerOptions();
  root.innerHTML = `
    <p class="page-intro">Compare deux corrections — par exemple ton premier essai et ta re-correction après avoir retravaillé l'exercice, ou deux devoirs d'une même matière.</p>
    <div class="card tight">
      <div class="grid2">
        <div class="field"><label class="label">Correction A (avant)</label><select id="cmp-a"><option value="">—</option>${opts}</select></div>
        <div class="field"><label class="label">Correction B (après)</label><select id="cmp-b"><option value="">—</option>${opts}</select></div>
      </div>
    </div>
    <div id="cmp-out"></div>`;
  $('#cmp-a', root).value = a || '';
  $('#cmp-b', root).value = b || '';
  const update = () => renderComparison($('#cmp-out', root), Number($('#cmp-a', root).value), Number($('#cmp-b', root).value));
  $('#cmp-a', root).onchange = update;
  $('#cmp-b', root).onchange = update;
  update();
}

function norm(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

async function renderComparison(box, idA, idB) {
  if (!idA || !idB) {
    box.innerHTML = emptyState('fa-code-compare', 'Choisis deux corrections à comparer.');
    return;
  }
  const [A, B] = await Promise.all([api.get(idA), api.get(idB)]);
  const ra = A.result;
  const rb = B.result;
  // Questions appariées par numéro
  const nums = [...new Set([...ra.questions.map((q) => q.numero), ...rb.questions.map((q) => q.numero)])];
  const qa = Object.fromEntries(ra.questions.map((q) => [q.numero, q]));
  const qb = Object.fromEntries(rb.questions.map((q) => [q.numero, q]));
  // Notions en faute : corrigées / persistantes / nouvelles
  const notionsA = new Set(ra.fautes.map((f) => norm(f.notion || f.categorie)));
  const notionsB = new Set(rb.fautes.map((f) => norm(f.notion || f.categorie)));
  const label = (r, key) => (r.fautes.find((f) => norm(f.notion || f.categorie) === key)?.notion || r.fautes.find((f) => norm(f.notion || f.categorie) === key)?.categorie || key);
  const fixed = [...notionsA].filter((n) => !notionsB.has(n));
  const persist = [...notionsA].filter((n) => notionsB.has(n));
  const added = [...notionsB].filter((n) => !notionsA.has(n));
  const head = (rec, r) => `
    <div class="card tight">
      <div class="xs dim">${esc(new Date(rec.created_at).toLocaleString('fr-FR'))}</div>
      <div style="font-weight:700;color:#fff;margin:4px 0">${esc(r.titre)}</div>
      <div class="small muted">${esc(r.matiere || '')}</div>
      <div class="grade" style="margin-top:10px;color:${scoreColor(r.score_pourcentage)}">${fr(r.note.obtenue)}<span>/${r.note.sur}</span></div>
      <div class="small muted">${r.fautes.length} faute(s) · ${r.questions.filter((q) => q.statut === 'correct').length}/${r.questions.length} question(s) correctes</div>
      <button class="btn sm" style="margin-top:10px" data-open="${rec.id}"><i class="fa-solid fa-arrow-up-right-from-square"></i>Ouvrir</button>
    </div>`;
  box.innerHTML = `
    <div class="compare-grid" style="margin-top:16px">${head(A, ra)}${head(B, rb)}</div>
    <div class="card" style="margin-top:16px">
      <h2><i class="fa-solid fa-scale-balanced"></i>Évolution : ${Math.abs(rb.note.obtenue - ra.note.obtenue) < 0.005 ? '<span class="delta">note identique</span>' : `${delta(ra.note.obtenue, rb.note.obtenue, ' pt')} <span class="small muted">(${delta(ra.score_pourcentage, rb.score_pourcentage, ' %')})</span>`}</h2>
      <div class="grid3">
        <div class="card-inner"><div class="section-title"><i class="fa-solid fa-circle-check" style="color:var(--emerald)"></i>Erreurs corrigées (${fixed.length})</div>${fixed.map((n) => `<div class="small">• ${esc(label(ra, n))}</div>`).join('') || '<div class="small dim">—</div>'}</div>
        <div class="card-inner"><div class="section-title"><i class="fa-solid fa-repeat" style="color:var(--amber)"></i>Erreurs persistantes (${persist.length})</div>${persist.map((n) => `<div class="small">• ${esc(label(rb, n))}</div>`).join('') || '<div class="small dim">—</div>'}</div>
        <div class="card-inner"><div class="section-title"><i class="fa-solid fa-circle-exclamation" style="color:var(--rose)"></i>Nouvelles erreurs (${added.length})</div>${added.map((n) => `<div class="small">• ${esc(label(rb, n))}</div>`).join('') || '<div class="small dim">—</div>'}</div>
      </div>
    </div>
    ${nums.length ? `<div class="card" style="margin-top:16px">
      <h2><i class="fa-solid fa-list-check"></i>Question par question</h2>
      <table class="cmp-table">
        <thead><tr><th>N°</th><th>Question</th><th>A</th><th>B</th><th>Écart</th></tr></thead>
        <tbody>${nums.map((n) => {
          const x = qa[n];
          const y = qb[n];
          return `<tr>
            <td class="mono" style="color:var(--brand400)">${esc(n)}</td>
            <td class="md-inline">${mdToHtml((y || x).intitule, { inline: true })}</td>
            <td>${x ? `<span class="tag ${STATUT[x.statut][1]}">${STATUT[x.statut][0]}</span> <span class="mono small">${fr(x.points_obtenus)}/${fr(x.points_max)}</span>` : '<span class="dim">—</span>'}</td>
            <td>${y ? `<span class="tag ${STATUT[y.statut][1]}">${STATUT[y.statut][0]}</span> <span class="mono small">${fr(y.points_obtenus)}/${fr(y.points_max)}</span>` : '<span class="dim">—</span>'}</td>
            <td>${x && y ? delta(x.points_obtenus, y.points_obtenus) : ''}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>
    </div>` : ''}`;
  renderMath(box);
  $$('[data-open]', box).forEach((btn) => (btn.onclick = () => go('result', { id: Number(btn.dataset.open) })));
}

register('compare', { title: 'Comparer deux corrections', show: (root, params) => renderCompare(root, params) });
