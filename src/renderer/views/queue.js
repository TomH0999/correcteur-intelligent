// File d'attente : corrections en arrière-plan (reprise automatique après fermeture de l'application).
import { api, $, $$, esc, fr, toast, emptyState, scoreColor, formatDate } from '../ui.js';
import { register, go, state } from '../router.js';

const STATUS = {
  pending: ['En attente', 'none', 'fa-hourglass-half'],
  running: ['En cours', 'brand', 'fa-spinner fa-spin'],
  done: ['Terminée', 'ok', 'fa-circle-check'],
  error: ['Échec', 'ko', 'fa-triangle-exclamation'],
  cancelled: ['Annulée', 'none', 'fa-ban']
};

let live = {};
let last = { jobs: [], paused: false };

function render(root) {
  const { jobs, paused } = last;
  const pending = jobs.filter((j) => j.status === 'pending').length;
  const running = jobs.find((j) => j.status === 'running');
  root.innerHTML = `
    <p class="page-intro">Les corrections ajoutées ici sont traitées une par une en arrière-plan. Tu peux continuer à utiliser l'application, ou même la fermer : elles reprendront au prochain lancement. Une notification t'avertit à la fin de chaque correction.</p>
    <div class="grid3">
      <div class="kpi"><div class="kpi-label"><i class="fa-solid fa-hourglass-half"></i>En attente</div><div class="kpi-value">${pending}</div></div>
      <div class="kpi"><div class="kpi-label"><i class="fa-solid fa-gears"></i>En cours</div><div class="kpi-value" style="font-size:16px;margin-top:10px">${running ? esc(running.title) : '—'}</div><div class="kpi-sub" id="q-live">${running ? esc(live[running.id] || running.progress || '') : ''}</div></div>
      <div class="kpi"><div class="kpi-label"><i class="fa-solid fa-circle-check"></i>Terminées</div><div class="kpi-value">${jobs.filter((j) => j.status === 'done').length}</div></div>
    </div>
    <div class="row" style="margin:16px 0">
      <button class="btn primary" id="q-new"><i class="fa-solid fa-plus"></i>Ajouter des copies</button>
      <button class="btn" id="q-pause"><i class="fa-solid ${paused ? 'fa-play' : 'fa-pause'}"></i>${paused ? 'Reprendre' : 'Mettre en pause'}</button>
      <span class="spacer"></span>
      <button class="btn ghost" id="q-clear"><i class="fa-solid fa-broom"></i>Retirer les tâches terminées</button>
    </div>
    ${paused ? '<div class="banner warn"><i class="fa-solid fa-pause"></i><span>File d\'attente en pause : aucune nouvelle correction ne démarre.</span></div>' : ''}
    <div class="list">${jobs.map((j) => {
      const [label, tone, icon] = STATUS[j.status] || STATUS.pending;
      return `
      <div class="item" data-id="${j.id}" style="cursor:${j.correction_id ? 'pointer' : 'default'}">
        <div class="item-icon"><i class="fa-solid ${icon}"></i></div>
        <div class="item-main">
          <div class="item-name">${esc(j.title)}</div>
          <div class="item-meta">${formatDate(j.created_at)} · <span class="tag ${tone === 'none' ? 'brand' : tone}">${label}</span>
            ${j.status === 'running' ? ` · <span data-live="${j.id}">${esc(live[j.id] || j.progress || '')}</span>` : ''}
            ${j.status === 'error' ? ` · <span style="color:var(--rose)">${esc(j.error || '')}</span>` : ''}
            ${j.status === 'done' && j.progress && j.progress !== 'Terminée' ? ` · <span class="dim">${esc(j.progress)}</span>` : ''}
          </div>
        </div>
        ${j.correction_id && j.grade != null ? `<div class="item-score" style="color:${scoreColor(j.score)}">${fr(j.grade)}<span>/${j.grade_max}</span></div>` : ''}
        ${['pending', 'running'].includes(j.status) ? `<button class="btn sm" data-cancel="${j.id}"><i class="fa-solid fa-xmark"></i>Annuler</button>` : ''}
        ${['error', 'cancelled'].includes(j.status) ? `<button class="btn sm" data-retry="${j.id}"><i class="fa-solid fa-rotate"></i>Relancer</button>` : ''}
        ${j.status !== 'running' ? `<button class="icon-btn danger" data-remove="${j.id}" title="Retirer"><i class="fa-solid fa-trash-can"></i></button>` : ''}
      </div>`;
    }).join('') || emptyState('fa-list-check', 'Aucune correction en file d\'attente. Dans « Nouvelle correction », utilise « Ajouter à la file d\'attente » ou coche « Une copie par fichier ».')}</div>`;
  $('#q-new', root).onclick = () => go('new');
  $('#q-pause', root).onclick = () => api.queuePause(!paused);
  $('#q-clear', root).onclick = () => api.queueClear();
  $$('[data-cancel]', root).forEach((b) => (b.onclick = (e) => { e.stopPropagation(); api.queueCancel(Number(b.dataset.cancel)); }));
  $$('[data-retry]', root).forEach((b) => (b.onclick = (e) => { e.stopPropagation(); api.queueRetry(Number(b.dataset.retry)); }));
  $$('[data-remove]', root).forEach((b) => (b.onclick = (e) => { e.stopPropagation(); api.queueRemove(Number(b.dataset.remove)); }));
  $$('.item', root).forEach((el) => (el.onclick = () => {
    const j = jobs.find((x) => x.id === Number(el.dataset.id));
    if (j?.correction_id) go('result', { id: j.correction_id });
  }));
}

function updateBadge() {
  const n = last.jobs.filter((j) => ['pending', 'running'].includes(j.status)).length;
  const b = $('#queue-badge');
  if (!b) return;
  b.textContent = n;
  b.classList.toggle('hidden', !n);
}

/** Abonnement aux mises à jour de la file (appelé au démarrage). */
export async function initQueue() {
  last = await api.queueList();
  updateBadge();
  api.onQueueUpdate((ev) => {
    if (ev.jobs) {
      last = ev;
      updateBadge();
      if (state.current === 'queue') render($('#page-queue'));
    }
    if (ev.progress) {
      live[ev.progress.id] = ev.progress.message;
      const el = document.querySelector(`[data-live="${ev.progress.id}"]`);
      if (el) el.textContent = ev.progress.message;
      const k = $('#q-live');
      if (k) k.textContent = ev.progress.message;
    }
    if (ev.done) toast(`Correction terminée : ${ev.done.title}`, 'ok', 6000, { label: 'Ouvrir', onClick: () => go('result', { id: ev.done.correctionId }) });
    if (ev.failed) toast(`Correction en échec : ${ev.failed.title}`, 'error', 8000, { label: 'Voir', onClick: () => go('queue') });
  });
}

register('queue', {
  title: 'File d\'attente',
  async show(root) {
    last = await api.queueList();
    live = {};
    render(root);
  }
});
