import { api, $, fr, scoreColor } from './ui.js';
import { state } from './router.js';

/** Met à jour la barre latérale (compteur de fiches à réviser, fournisseur d'IA). */
export async function refreshStats() {
  try {
    const s = await api.stats();
    const badge = $('#due-badge');
    badge.textContent = s.due;
    badge.classList.toggle('hidden', !s.due);
    const prov = state.settings?.providers?.find((p) => p.id === state.settings.provider);
    $('#side-ai').textContent = state.settings?.hasApiKey && prov ? `Claude · API ${prov.label}` : 'Correction avec Claude';
    return s;
  } catch {
    return null;
  }
}

export { fr, scoreColor };
