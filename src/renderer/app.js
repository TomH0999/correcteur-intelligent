// Point d'entrée de l'interface.
import { api, $, $$, toast } from './ui.js';
import { go, state } from './router.js';
import { refreshStats } from './shared.js';
import './views/new.js';
import './views/result.js';
import './views/lists.js';
import './views/dashboard.js';
import './views/practice.js';
import './views/annotate.js';
import { initQueue } from './views/queue.js';
import { updateStatusText } from './views/settings.js';

function updatePill(u) {
  const pill = $('#update-pill');
  if (['downloading', 'ready'].includes(u.status)) {
    pill.classList.remove('hidden');
    pill.innerHTML = u.status === 'ready'
      ? `<i class="fa-solid fa-circle-arrow-up" style="color:var(--emerald)"></i><span>v${u.version} prête</span><button class="btn sm primary" id="upd-now">Installer</button>`
      : `<i class="fa-solid fa-cloud-arrow-down" style="color:var(--brand400)"></i><span>Mise à jour ${u.progress || 0} %</span>`;
    $('#upd-now')?.addEventListener('click', () => api.installUpdate());
  } else pill.classList.add('hidden');
  const txt = $('#s-upd-txt');
  if (txt) txt.textContent = updateStatusText(u);
  $('#s-install-upd')?.classList.toggle('hidden', u.status !== 'ready');
}

async function init() {
  $$('.nav-item').forEach((b) => (b.onclick = () => go(b.dataset.view)));
  document.addEventListener('click', (e) => {
    const ext = e.target.closest('[data-external]');
    if (ext) {
      e.preventDefault();
      api.openExternal(ext.dataset.external);
    }
    const goto = e.target.closest('[data-goto]');
    if (goto) {
      e.preventDefault();
      go(goto.dataset.goto);
    }
  });
  $('#quick-search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') go('history', { search: e.target.value });
  });
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      $('#quick-search').focus();
    }
  });
  state.settings = await api.getSettings();
  state.info = await api.info();
  state.folders = await api.folders();
  $('#side-version').textContent = `v${state.info.version}`;
  api.onUpdateStatus(updatePill);
  updatePill(await api.updateState());
  api.onCardsAdded(({ count }) => {
    toast(`${count} fiche(s) de révision créée(s) à partir de tes erreurs.`, 'info', 5000, { label: 'Réviser', onClick: () => go('cards') });
    refreshStats();
  });
  api.onSyncStatus((s) => {
    if (s.error) toast(`Synchronisation : ${s.error}`, 'warn', 8000);
    else if (s.imported) {
      toast(`${s.imported} élément(s) récupéré(s) depuis tes autres PC.`, 'ok', 5000);
      refreshStats();
    }
  });
  await refreshStats();
  await initQueue();
  api.onNavResult((id) => go('result', { id }));
  // Premier lancement : on guide vers la clé API
  go(state.settings.hasApiKey ? 'new' : 'settings');
  if (!state.settings.hasApiKey) toast('Bienvenue ! Commence par ajouter une clé API (Groq est gratuit).', 'info', 8000);
}

init().catch((err) => toast(err.message, 'error', 10000));
