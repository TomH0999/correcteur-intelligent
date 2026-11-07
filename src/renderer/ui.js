// Utilitaires d'interface partagés.
export const api = window.api;
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const fr = (n, d = 2) => (n == null || Number.isNaN(Number(n)) ? '—' : (Math.round(Number(n) * 10 ** d) / 10 ** d).toLocaleString('fr-FR'));

export const TYPE_LABELS = {
  maths: 'Maths', developpement: 'Développement', base_de_donnees: 'Bases de données', reseau: 'Réseau', systeme: 'Système',
  algorithmique: 'Algorithmique', web: 'Web', genie_logiciel: 'Génie logiciel', architecture: 'Architecture', anglais: 'Anglais',
  communication: 'Communication', gestion: 'Gestion', autre: 'Autre'
};
export const TYPE_ICONS = {
  maths: 'fa-square-root-variable', developpement: 'fa-code', base_de_donnees: 'fa-database', reseau: 'fa-network-wired', systeme: 'fa-terminal',
  algorithmique: 'fa-diagram-project', web: 'fa-globe', genie_logiciel: 'fa-sitemap', architecture: 'fa-microchip', anglais: 'fa-language',
  communication: 'fa-comments', gestion: 'fa-chart-pie', autre: 'fa-file-lines'
};
export const STATUT = { correct: ['Correct', 'ok'], partiel: ['Partiel', 'mid'], incorrect: ['Incorrect', 'ko'], non_traite: ['Non traité', 'none'] };

export function tone(score) {
  if (score == null) return 'none';
  if (score >= 65) return 'ok';
  if (score >= 50) return 'mid';
  return 'ko';
}
export function scoreColor(score) {
  return { ok: 'var(--emerald)', mid: 'var(--amber)', ko: 'var(--rose)', none: 'var(--s500)' }[tone(score)];
}
export function formatDate(iso, withTime = true) {
  return new Date(iso).toLocaleString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric', ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}) });
}
export function gradeChip(grade, max, score) {
  if (grade == null) return '<span class="dim mono xs">--</span>';
  const t = tone(score);
  const c = { ok: 'var(--emerald)', mid: 'var(--amber)', ko: 'var(--rose)', none: 'var(--s500)' }[t];
  return `<span class="grade-chip" style="color:${c};border-color:${c}33;background:${c}14">${fr(grade)}/${max}</span>`;
}

// ---------- Notifications (même présentation que le gestionnaire de notes) ----------
const TOAST_ICONS = { ok: 'fa-circle-check', error: 'fa-triangle-exclamation', warn: 'fa-circle-exclamation', info: 'fa-circle-info' };
export function toast(msg, type = 'ok', ms = 4000, action = null) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<i class="fa-solid ${TOAST_ICONS[type] || TOAST_ICONS.info}"></i><span style="flex:1"></span>`;
  el.querySelector('span').textContent = msg;
  if (action) {
    const b = document.createElement('button');
    b.className = 'btn sm';
    b.style.cssText = 'min-height:28px;background:rgb(255 255 255 / .15);border:0;color:#fff';
    b.textContent = action.label;
    b.onclick = () => { action.onClick(); el.remove(); };
    el.appendChild(b);
  }
  $('#toasts').appendChild(el);
  setTimeout(() => el.classList.add('out'), ms);
  setTimeout(() => el.remove(), ms + 400);
}

// ---------- Modale ----------
export function modal({ title, icon = 'fa-pen', body, okLabel = 'OK', danger = false, wide = false, hideOk = false, cancelLabel = 'Annuler', onOpen }) {
  return new Promise((resolve) => {
    const m = $('#modal');
    $('#modal-title').innerHTML = `<i class="fa-solid ${icon}"></i><span></span>`;
    $('#modal-title span').textContent = title;
    $('#modal-box').classList.toggle('wide', wide);
    const b = $('#modal-body');
    b.innerHTML = body;
    const ok = $('#modal-ok');
    ok.textContent = okLabel;
    ok.classList.toggle('danger', danger);
    ok.classList.toggle('hidden', hideOk);
    $('#modal-cancel').textContent = cancelLabel;
    m.classList.remove('hidden');
    const close = (val) => {
      m.classList.add('hidden');
      ok.onclick = null;
      $('#modal-cancel').onclick = null;
      m.onkeydown = null;
      m.onclick = null;
      resolve(val);
    };
    onOpen?.(b, close);
    const first = b.querySelector('input, select, textarea');
    setTimeout(() => (first || ok).focus(), 30);
    ok.onclick = () => close(b);
    $('#modal-cancel').onclick = () => close(null);
    m.onclick = (e) => { if (e.target === m) close(null); };
    m.onkeydown = (e) => {
      if (e.key === 'Escape') close(null);
      if (e.key === 'Enter' && e.target.tagName === 'INPUT') close(b);
    };
  });
}

export async function promptText(title, value = '', label = '', icon = 'fa-pen') {
  const b = await modal({ title, icon, body: `<div class="field">${label ? `<label class="label">${esc(label)}</label>` : ''}<input id="m-input" value="${esc(value)}" /></div>` });
  return b ? $('#m-input', b).value.trim() : null;
}

export async function confirmBox(title, text, okLabel = 'Supprimer') {
  return !!(await modal({ title, icon: 'fa-triangle-exclamation', body: `<p class="muted" style="margin:0">${esc(text)}</p>`, okLabel, danger: true }));
}

export function emptyState(icon, text) {
  return `<div class="empty"><i class="fa-solid ${icon}"></i>${text}</div>`;
}

/** Ligne de liste pour une correction. */
export function corrItem(c, { selectable = false, selected = false } = {}) {
  const practice = c.kind === 'practice';
  return `
    <div class="item ${selected ? 'selected' : ''}" data-id="${c.id}">
      ${selectable ? `<input type="checkbox" class="cmp-check" ${selected ? 'checked' : ''} title="Sélectionner pour comparer" />` : ''}
      <div class="item-icon"><i class="fa-solid ${practice ? 'fa-dumbbell' : TYPE_ICONS[c.exercise_type] || 'fa-file-lines'}"></i></div>
      <div class="item-main">
        <div class="item-name">${esc(c.name)}</div>
        <div class="item-meta">${formatDate(c.created_at)} · ${esc(TYPE_LABELS[c.exercise_type] || '—')}${c.folder_name ? ` · <i class="fa-solid fa-folder" style="color:var(--amber)"></i> ${esc(c.folder_name)}` : ''} · ${c.files.length} fichier(s)${practice ? ' · <span class="tag brand">entraînement</span>' : ''}</div>
      </div>
      <div class="item-score" style="color:${scoreColor(c.score)}">${c.grade != null ? `${fr(c.grade)}<span>/${c.grade_max}</span>` : '—'}</div>
    </div>`;
}

export function folderOptions(folders, selected, exclude = null) {
  const byParent = {};
  folders.forEach((f) => (byParent[f.parent_id || 0] ||= []).push(f));
  const out = [];
  const walk = (pid, depth) => (byParent[pid] || []).forEach((f) => {
    if (f.id === exclude) return;
    out.push(`<option value="${f.id}" ${f.id === selected ? 'selected' : ''}>${'  '.repeat(depth)}${depth ? '└ ' : ''}${esc(f.name)}</option>`);
    walk(f.id, depth + 1);
  });
  walk(0, 0);
  return out.join('');
}
