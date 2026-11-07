'use strict';
/**
 * Mises à jour automatiques via les Releases GitHub (electron-updater).
 * L'application vérifie au démarrage puis toutes les 4 h, télécharge en arrière-plan,
 * et installe la nouvelle version à la fermeture (ou tout de suite sur demande).
 */
const { app } = require('electron');

let autoUpdater = null;
let state = { status: 'idle', version: null, progress: 0, error: null };
let send = () => {};
let timer = null;

function setState(patch) {
  state = { ...state, ...patch };
  send(state);
}

let beforeInstall = async () => {};

function init({ notify, enabled = true, onBeforeInstall }) {
  send = notify;
  if (onBeforeInstall) beforeInstall = onBeforeInstall;
  if (!app.isPackaged) {
    setState({ status: 'dev' });
    return;
  }
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (err) {
    setState({ status: 'error', error: err.message });
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.on('checking-for-update', () => setState({ status: 'checking', error: null }));
  autoUpdater.on('update-available', (i) => setState({ status: 'downloading', version: i.version, progress: 0 }));
  autoUpdater.on('update-not-available', () => setState({ status: 'uptodate', checkedAt: new Date().toISOString() }));
  autoUpdater.on('download-progress', (p) => setState({ status: 'downloading', progress: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (i) => {
    setState({ status: 'ready', version: i.version, progress: 100 });
    // La mise à jour s'installera à la fermeture : sauvegarde de sécurité dès maintenant
    Promise.resolve(beforeInstall()).catch((err) => console.warn('Sauvegarde avant mise à jour :', err.message));
  });
  autoUpdater.on('error', (err) => setState({ status: 'error', error: String(err?.message || err).split('\n')[0] }));
  if (enabled) {
    setTimeout(check, 8000);
    timer = setInterval(check, 4 * 3600 * 1000);
  }
}

function check() {
  if (!autoUpdater) return state;
  autoUpdater.checkForUpdates().catch((err) => setState({ status: 'error', error: String(err?.message || err).split('\n')[0] }));
  return state;
}

async function installNow() {
  if (autoUpdater && state.status === 'ready') {
    // Sauvegarde de sécurité des données avant de remplacer l'application
    try { await beforeInstall(); } catch (err) { console.warn('Sauvegarde avant mise à jour :', err.message); }
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
    return true;
  }
  return false;
}

function setEnabled(enabled) {
  clearInterval(timer);
  if (enabled && autoUpdater) {
    timer = setInterval(check, 4 * 3600 * 1000);
    check();
  }
}

module.exports = { init, check, installNow, setEnabled, getState: () => state };
