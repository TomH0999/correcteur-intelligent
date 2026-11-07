import { $, $$ } from './ui.js';

const views = {};
export const state = {
  current: null,
  previous: 'history',
  settings: null,
  folders: [],
  info: null
};

export function register(name, def) {
  views[name] = def;
}

/** Affiche une vue : go('result', { id: 3 }) */
export async function go(name, params = {}) {
  const def = views[name];
  if (!def) return;
  if (state.current && state.current !== 'result' && state.current !== name) state.previous = state.current;
  state.current = name;
  $$('.page').forEach((p) => p.classList.toggle('active', p.id === `page-${name}`));
  $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.view === (def.nav || name)));
  $('#page-title').textContent = typeof def.title === 'function' ? def.title(params) : def.title;
  $('#main').scrollTop = 0;
  try {
    await def.show($(`#page-${name}`), params);
  } catch (err) {
    console.error(err);
    const { toast } = await import('./ui.js');
    toast(err.message, 'error', 8000);
  }
}

export function back() {
  go(state.previous || 'history');
}
