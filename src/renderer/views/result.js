import { api, $, $$, esc, fr, toast, modal, confirmBox, promptText, folderOptions, formatDate, scoreColor, STATUT, TYPE_LABELS, TYPE_ICONS } from '../ui.js';
import { register, go, back, state } from '../router.js';
import { mdToHtml, setMd, renderMath } from '../markdown.js';
import { refreshStats } from '../shared.js';

function ring(score) {
  const r = 62;
  const c = 2 * Math.PI * r;
  const off = c * (1 - Math.max(0, Math.min(100, score)) / 100);
  return `<svg viewBox="0 0 150 150" class="ring"><circle cx="75" cy="75" r="${r}" class="ring-bg"/><circle cx="75" cy="75" r="${r}" class="ring-fg" style="stroke:${scoreColor(score)};stroke-dasharray:${c};stroke-dashoffset:${off}"/></svg>`;
}

const execTone = (e) => (e.internal && !e.ok ? 'na' : e.unavailable ? 'na' : e.ok ? 'ok' : 'ko');

function render(root, rec) {
  const r = rec.result;
  const folderName = state.folders.find((f) => f.id === rec.folder_id)?.name;
  const n = (s) => r.questions.filter((q) => q.statut === s).length;
  const ex = r.executions || [];
  root.innerHTML = `
    <div class="toolbar no-print">
      <button class="btn sm" id="r-back"><i class="fa-solid fa-arrow-left"></i>Retour</button>
      <div class="spacer"></div>
      <button class="btn sm" id="r-folder"><i class="fa-solid fa-folder${folderName ? '' : '-plus'}" style="color:var(--amber)"></i>${folderName ? esc(folderName) : 'Enregistrer dans un dossier'}</button>
      <button class="btn sm" id="r-rename"><i class="fa-solid fa-pen"></i>Renommer</button>
      <button class="btn sm" id="r-annot"><i class="fa-solid fa-highlighter"></i>Copie annotée</button>
      <button class="btn sm" id="r-chat"><i class="fa-solid fa-comments"></i>Discuter</button>
      <button class="btn sm" id="r-train"><i class="fa-solid fa-dumbbell"></i>S'entraîner</button>
      <button class="btn sm" id="r-cards"><i class="fa-solid fa-layer-group"></i>Fiches</button>
      <button class="btn sm" id="r-compare"><i class="fa-solid fa-code-compare"></i>Comparer</button>
      <button class="btn sm" id="r-rerun" title="Relancer la correction sur les mêmes documents"><i class="fa-solid fa-rotate"></i>Re-corriger</button>
      <button class="btn sm" id="r-md" title="Exporter en Markdown"><i class="fa-solid fa-file-arrow-down"></i>.md</button>
      <button class="btn sm" id="r-pdf" title="Exporter en PDF"><i class="fa-solid fa-file-pdf"></i></button>
      <button class="btn sm danger" id="r-del" title="Supprimer"><i class="fa-solid fa-trash-can"></i></button>
    </div>

    ${rec.counted ? '' : `<div class="banner warn no-print"><i class="fa-solid fa-file-pen"></i><span><strong>Brouillon :</strong> cette correction n'est pas enregistrée. Elle n'apparaît pas dans l'historique et ne compte ni dans tes statistiques ni dans ta progression. Elle sera supprimée automatiquement dans 14 jours.</span><span class="spacer"></span><button class="btn sm primary" id="r-keep"><i class="fa-solid fa-floppy-disk"></i>Enregistrer</button></div>`}
    <div class="card result-head">
      <div class="score">${ring(r.score_pourcentage)}
        <div class="score-txt"><div class="grade">${fr(r.note.obtenue)}<span>/${r.note.sur}</span></div><div class="pct">${fr(r.score_pourcentage, 1)} %</div></div>
      </div>
      <div style="flex:1;min-width:0">
        <div class="row wrap">
          <span class="badge brand"><i class="fa-solid ${TYPE_ICONS[r.type_exercice] || 'fa-file'}"></i>${esc(TYPE_LABELS[r.type_exercice] || r.type_exercice)}</span>
          ${r.matiere ? `<span class="badge">${esc(r.matiere)}</span>` : ''}
          ${r.langage ? `<span class="badge">${esc(r.langage)}</span>` : ''}
          ${rec.kind === 'practice' ? '<span class="badge brand"><i class="fa-solid fa-dumbbell"></i>Entraînement</span>' : ''}
        </div>
        <div class="r-title">${esc(r.titre)}</div>
        <div class="xs dim"><i class="fa-solid fa-magnifying-glass"></i> ${esc(rec.name)}</div>
        ${r.appreciation ? `<p class="appreciation">${esc(r.appreciation)}</p>` : ''}
        <div class="row wrap">
          <span class="badge ok">${n('correct')} correct</span>
          <span class="badge mid">${n('partiel')} partiel</span>
          <span class="badge ko">${n('incorrect')} incorrect</span>
          <span class="badge none">${n('non_traite')} non traité</span>
          <span class="badge">${r.fautes.length} faute(s)</span>
          ${ex.length ? (() => { const counted = ex.filter((e) => !(e.internal && !e.ok) && !e.unavailable); return `<span class="badge ${counted.every((e) => e.ok) ? 'ok' : 'ko'}"><i class="fa-solid fa-terminal"></i>${counted.filter((e) => e.ok).length}/${counted.length} test(s) réussi(s)${counted.length < ex.length ? ` · ${ex.length - counted.length} non compté(s)` : ''}</span>`; })() : ''}
        </div>
      </div>
    </div>

    <div id="r-attempts" class="no-print"></div>
    <nav class="tabs no-print">
      <a href="#sec-synthese">Synthèse</a><a href="#sec-questions">Questions</a><a href="#sec-fautes">Fautes (${r.fautes.length})</a>
      ${ex.length ? '<a href="#sec-exec">Exécution du code</a>' : ''}
      <a href="#sec-ameliorations">Améliorations</a><a href="#sec-revoir">À revoir</a><a href="#sec-modele">Correction modèle</a><a href="#sec-chat">Discuter avec l'IA</a><a href="#sec-sources">Documents lus</a>
    </nav>

    <section class="card" id="sec-synthese">
      <h2><i class="fa-solid fa-clipboard-check"></i>Synthèse</h2>
      <div class="md" data-md="resume"></div>
      ${r.points_forts.length ? `<h3>Points forts</h3><ul style="padding-left:0;list-style:none;margin:0">${r.points_forts.map((p) => `<li class="md-inline" style="margin:4px 0"><i class="fa-solid fa-check" style="color:var(--emerald);margin-right:8px"></i>${mdToHtml(p, { inline: true })}</li>`).join('')}</ul>` : ''}
      <h3>Identification automatique des documents</h3>
      <div class="card-inner" style="display:grid;gap:4px">
        <div><i class="fa-solid fa-clipboard-list" style="color:var(--brand400);width:18px"></i> <strong>Énoncé :</strong> ${r.identification.enonce.length ? r.identification.enonce.map(esc).join(', ') : (r.identification.enonce_present ? '—' : '<em>absent — questions déduites de tes réponses</em>')}</div>
        <div><i class="fa-solid fa-pen-nib" style="color:var(--emerald);width:18px"></i> <strong>Réponses :</strong> ${r.identification.reponses.map(esc).join(', ') || '—'}</div>
        ${r.identification.bareme?.length ? `<div><i class="fa-solid fa-scale-balanced" style="color:var(--amber);width:18px"></i> <strong>Barème / corrigé :</strong> ${r.identification.bareme.map(esc).join(', ')}</div>` : ''}
        ${r.identification.remarques ? `<div class="small muted">${esc(r.identification.remarques)}</div>` : ''}
      </div>
    </section>

    <section class="card" id="sec-questions">
      <h2><i class="fa-solid fa-list-check"></i>Détail par question</h2>
      ${r.questions.length ? r.questions.map((q, i) => `
        <div class="q">
          <div class="q-head">
            <span class="q-num">${esc(q.numero || i + 1)}</span>
            <span class="q-title md-inline">${mdToHtml(q.intitule, { inline: true })}</span>
            <span class="tag ${STATUT[q.statut][1]}">${STATUT[q.statut][0]}</span>
            <span class="q-pts" style="color:${scoreColor(q.points_max ? (q.points_obtenus / q.points_max) * 100 : null)}">${fr(q.points_obtenus)} / ${fr(q.points_max)}</span>
          </div>
          <div class="md q-body" data-md="q:${i}"></div>
        </div>`).join('') : '<p class="muted">Pas de détail par question.</p>'}
    </section>

    <section class="card" id="sec-fautes">
      <h2><i class="fa-solid fa-bug"></i>Rapport de fautes</h2>
      ${r.fautes.length ? r.fautes.map((f, i) => `
        <div class="faute g-${f.gravite}">
          <div class="faute-head">
            <span class="tag ${f.gravite === 'majeure' ? 'ko' : f.gravite === 'moyenne' ? 'mid' : 'brand'}">${f.gravite}</span>
            <strong style="text-transform:capitalize">${esc(f.categorie.replace(/_/g, ' '))}</strong>
            ${f.notion ? `<span class="badge">${esc(f.notion)}</span>` : ''}
            ${f.question ? `<span class="xs dim">Question ${esc(f.question)}</span>` : ''}
          </div>
          <div class="md" data-md="f:${i}:description"></div>
          ${f.extrait ? `<div class="extrait"><div class="lbl">Ta réponse</div><pre>${esc(f.extrait)}</pre></div>` : ''}
          ${f.correction ? `<div class="fix"><div class="lbl">Correction</div><div class="md" data-md="f:${i}:correction"></div></div>` : ''}
        </div>`).join('') : '<p class="muted">Aucune faute relevée. Bravo ! 🎉</p>'}
    </section>

    ${ex.length ? `
    <section class="card" id="sec-exec">
      <h2><i class="fa-solid fa-terminal"></i>Vérification par exécution réelle</h2>
      <p class="small muted" style="margin-top:-6px">Ton code a été réellement exécuté par l'application avec des tests préparés par l'IA.</p>
      ${ex.map((e, i) => `
        <div class="faute exec ${execTone(e)}">
          <div class="faute-head">
            <span class="tag ${e.unavailable || (e.internal && !e.ok) ? 'brand' : e.ok ? 'ok' : 'ko'}">${e.unavailable ? 'non exécuté' : e.internal && !e.ok ? 'limite de l\'outil — non compté' : e.timedOut ? 'temps dépassé' : e.ok ? 'exécuté' : 'erreur'}</span>
            <strong>${esc(e.but)}</strong><span class="badge">${esc(e.langage)}</span>
            ${e.durationMs ? `<span class="xs dim">${e.durationMs} ms</span>` : ''}
          </div>
          ${e.internal ? `<div class="small" style="color:var(--brand400);margin:4px 0"><i class="fa-solid fa-circle-info"></i> ${esc(e.explication || 'Limite de l\'outil d\'exécution : ce n\'est pas une erreur de ta part.')}</div>` : ''}
          <details class="src"><summary>Programme de test</summary><pre>${esc(e.code)}</pre>${e.entree ? `<div class="lbl">Entrée</div><pre>${esc(e.entree)}</pre>` : ''}</details>
          <div class="grid2">
            <div><div class="lbl">Sortie attendue</div><pre>${esc(e.sortie_attendue || '—')}</pre></div>
            <div><div class="lbl">Sortie obtenue</div><pre>${esc(e.stdout || '(vide)')}${e.stderr ? `\n${esc(e.stderr)}` : ''}</pre></div>
          </div>
        </div>`).join('')}
    </section>` : ''}

    <section class="card" id="sec-ameliorations">
      <h2><i class="fa-solid fa-lightbulb"></i>Améliorations possibles</h2>
      ${r.ameliorations.length ? `<div class="cards-grid">${r.ameliorations.map((a, i) => `<div class="mini"><div class="mini-title"><i class="fa-solid fa-lightbulb"></i>${esc(a.titre)}</div><div class="md" data-md="a:${i}"></div></div>`).join('')}</div>` : '<p class="muted">—</p>'}
    </section>

    <section class="card" id="sec-revoir">
      <h2><i class="fa-solid fa-book-open"></i>Notions à revoir</h2>
      ${r.a_revoir.length ? r.a_revoir.map((a, i) => `
        <div class="q rv">
          <div class="q-head"><span class="tag ${a.priorite === 'haute' ? 'ko' : a.priorite === 'moyenne' ? 'mid' : 'ok'}">${a.priorite}</span><span class="q-title">${esc(a.notion)}</span></div>
          <div class="md q-body" data-md="rv:${i}:pourquoi"></div>
          ${a.ressources ? `<div class="small muted" style="margin-top:4px"><i class="fa-solid fa-book"></i> <span class="md-inline" data-md-inline="rv:${i}:ressources"></span></div>` : ''}
        </div>`).join('') : '<p class="muted">Rien de particulier à revoir.</p>'}
    </section>

    <section class="card" id="sec-modele">
      <h2><i class="fa-solid fa-graduation-cap"></i>Correction modèle</h2>
      <div class="md" data-md="modele"></div>
    </section>

    <section class="card no-print" id="sec-chat">
      <div class="row between"><h2 style="margin:0"><i class="fa-solid fa-comments"></i>Discuter avec l'IA de cette correction</h2><button class="btn sm ghost" id="chat-clear"><i class="fa-solid fa-eraser"></i>Effacer</button></div>
      <p class="small muted">Pose tes questions : l'IA connaît ta copie, la correction et les résultats des tests.</p>
      <div class="chat-log" id="chat-log"></div>
      <div class="row wrap" id="chat-suggest" style="margin:10px 0">
        ${['Explique-moi ma faute la plus grave', 'Pourquoi j\'ai perdu des points ?', 'Donne-moi un exercice similaire', 'Comment éviter ces erreurs à l\'examen ?'].map((t) => `<button class="btn sm" data-suggest="${esc(t)}">${esc(t)}</button>`).join('')}
      </div>
      <div class="chat-input">
        <textarea id="chat-text" rows="2" placeholder="Ta question… (Entrée pour envoyer, Maj+Entrée pour aller à la ligne)"></textarea>
        <button class="btn primary" id="chat-send"><i class="fa-solid fa-paper-plane"></i></button>
      </div>
    </section>

    <section class="card no-print" id="sec-sources">
      <h2><i class="fa-solid fa-eye"></i>Documents lus par l'IA</h2>
      <p class="small muted" style="margin-top:-6px">Texte extrait et transcription des images : vérifie qu'un manuscrit a bien été déchiffré.</p>
      ${rec.sources.map((s, i) => `<details class="src"><summary>${esc(s.label)} <span class="xs dim">· ${s.kind === 'image' ? 'image transcrite' : s.kind === 'audio' ? 'audio transcrit' : 'texte'} · ${s.text.length.toLocaleString('fr-FR')} car.</span></summary><div class="md" data-md="src:${i}"></div></details>`).join('')}
      ${rec.consigne ? `<p class="small"><strong>Indications données :</strong> ${esc(rec.consigne)}</p>` : ''}
      <p class="xs dim">Modèle : ${esc(rec.model || '—')} · ${formatDate(rec.created_at)}${r.mots_cles.length ? ` · Mots-clés : ${r.mots_cles.map(esc).join(', ')}` : ''}</p>
    </section>`;

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
  $$('[data-md]', root).forEach((d) => setMd(d, get(d.dataset.md)));
  $$('[data-md-inline]', root).forEach((d) => setMd(d, get(d.dataset.mdInline), { inline: true }));
  renderMath(root);
  bind(root, rec);
}

function bind(root, rec) {
  const r = rec.result;
  $('#r-back', root).onclick = back;
  $('#r-folder', root).onclick = () => chooseFolder(rec);
  $('#r-keep', root)?.addEventListener('click', async () => {
    await api.update(rec.id, { counted: true });
    toast('Correction enregistrée : elle compte maintenant dans ton historique et tes statistiques.', 'ok', 5000);
    refreshStats();
    go('result', { id: rec.id });
  });
  renderAttempts(root, rec);
  $('#r-rename', root).onclick = async () => {
    const name = await promptText('Renommer la correction', rec.name, 'Nom (utilisé pour la recherche dans l\'historique)');
    if (!name) return;
    await api.update(rec.id, { name });
    go('result', { id: rec.id });
  };
  $('#r-train', root).onclick = () => go('training', { fromCorrection: rec });
  $('#r-annot', root).onclick = () => go('annotate', { id: rec.id });
  $('#r-chat', root).onclick = () => { $('#sec-chat', root).scrollIntoView({ behavior: 'smooth' }); $('#chat-text', root).focus(); };
  initChat(root, rec);
  $('#r-cards', root).onclick = async (e) => {
    const btn = e.currentTarget;
    const existing = await api.cards({ correctionId: rec.id });
    if (existing.length) return go('cards', { correctionId: rec.id });
    btn.disabled = true;
    try {
      const n = await api.generateCards(rec.id);
      toast(`${n} fiche(s) de révision créée(s).`, 'ok');
      refreshStats();
      go('cards', { correctionId: rec.id });
    } catch (err) {
      toast(err.message, 'error', 8000);
      btn.disabled = false;
    }
  };
  $('#r-compare', root).onclick = () => go('compare', { a: rec.id });
  $('#r-rerun', root).onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.innerHTML = '<div class="spinner sm"></div>Correction…';
    try {
      const { id, warnings } = await api.recorrect(rec.id);
      warnings?.forEach((w) => toast(w, 'warn', 8000));
      toast('Nouvelle correction enregistrée.', 'ok');
      go('result', { id });
    } catch (err) {
      toast(err.message, 'error', 10000);
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-rotate"></i>Re-corriger';
    }
  };
  $('#r-md', root).onclick = async () => {
    const p = await api.exportMarkdown(rec.id).catch((err) => toast(err.message, 'error'));
    if (p) toast('Exporté : ' + p, 'ok');
  };
  $('#r-pdf', root).onclick = async () => {
    const p = await api.exportPdf(rec.id).catch((err) => toast(err.message, 'error'));
    if (p) toast('PDF enregistré : ' + p, 'ok');
  };
  $('#r-del', root).onclick = async () => {
    if (!(await confirmBox('Supprimer la correction', `Supprimer définitivement « ${rec.name} » ?`))) return;
    await api.remove(rec.id);
    toast('Correction supprimée.', 'info');
    refreshStats();
    back();
  };
  $$('.tabs a', root).forEach((a) => (a.onclick = (e) => {
    e.preventDefault();
    $(a.getAttribute('href'), root).scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
  void r;
}

// ---------- Tentatives du même exercice ----------
async function renderAttempts(root, rec) {
  const box = $('#r-attempts', root);
  if (!rec.counted) {
    box.innerHTML = '';
    return;
  }
  const s = await api.attempts(rec.id);
  const choices = await api.seriesChoices(rec.id);
  const others = choices.filter((c) => c.key !== rec.exercise_key);
  const linkUi = `
    <div class="row wrap" style="margin-top:10px">
      <select id="r-link" style="max-width:420px"><option value="">Lier à un autre exercice (même énoncé)…</option>${others.map((c) => `<option value="${esc(c.key)}">${esc(c.title)}${c.subject ? ` — ${esc(c.subject)}` : ''} (${c.count} tentative${c.count > 1 ? 's' : ''})</option>`).join('')}</select>
      ${s && s.count > 1 ? '<button class="btn sm ghost" id="r-unlink"><i class="fa-solid fa-link-slash"></i>Détacher de cette série</button>' : ''}
    </div>`;
  if (!s || s.count < 2) {
    box.innerHTML = `<div class="card tight" style="margin-top:16px"><div class="row wrap small muted"><i class="fa-solid fa-repeat"></i><span>Première tentative de cet exercice. Les prochaines copies du même énoncé seront regroupées automatiquement pour mesurer ta progression.</span></div>${others.length ? linkUi : ''}</div>`;
  } else {
    const k = s.index + 1;
    const first = s.attempts[0];
    const delta = rec.score != null && s.index > 0 ? rec.score - first.score : null;
    box.innerHTML = `
      <div class="card tight" style="margin-top:16px">
        <div class="row wrap">
          <span class="badge brand"><i class="fa-solid fa-repeat"></i>Tentative ${k} sur ${s.count}</span>
          <span class="small muted">1re tentative : <strong style="color:${scoreColor(first.score)}">${fr(first.score, 1)} %</strong> ${first.score >= 50 ? '(réussie du premier coup)' : '(non réussie)'}</span>
          ${delta != null ? `<span class="delta ${delta >= 0 ? 'up' : 'down'}">${delta >= 0 ? '+' : ''}${fr(delta, 1)} pts depuis la 1re</span>` : ''}
          ${s.improvement != null ? `<span class="small muted">· progression totale de la série : <span class="delta ${s.improvement >= 0 ? 'up' : 'down'}">${s.improvement >= 0 ? '+' : ''}${fr(s.improvement, 1)} pts</span></span>` : ''}
        </div>
        <div class="attempt-track">${s.attempts.map((a, i) => `
          <button class="attempt ${a.id === rec.id ? 'current' : ''}" data-open="${a.id}" title="${new Date(a.date).toLocaleString('fr-FR')}">
            <span class="xs dim">n°${i + 1}</span><b style="color:${scoreColor(a.score)}">${fr(a.grade)}/${a.gradeMax}</b>
          </button>${i < s.attempts.length - 1 ? `<i class="fa-solid fa-arrow-right dim"></i>` : ''}`).join('')}</div>
        ${linkUi}
      </div>`;
  }
  $$('[data-open]', box).forEach((b) => (b.onclick = () => go('result', { id: Number(b.dataset.open) })));
  $('#r-link', box)?.addEventListener('change', async (e) => {
    if (!e.target.value) return;
    await api.update(rec.id, { exerciseKey: e.target.value });
    toast('Correction rattachée à cet exercice.', 'ok');
    go('result', { id: rec.id });
  });
  $('#r-unlink', box)?.addEventListener('click', async () => {
    await api.update(rec.id, { exerciseKey: null });
    toast('Correction détachée : elle forme maintenant un exercice à part.', 'info');
    go('result', { id: rec.id });
  });
}

// ---------- Discussion avec l'IA ----------
function drawChat(root, msgs) {
  const log = $('#chat-log', root);
  log.innerHTML = msgs.length ? msgs.map((m) => `
    <div class="chat-msg ${m.role}">
      <div class="chat-who">${m.role === 'user' ? '<i class="fa-solid fa-user"></i> Toi' : m.role === 'error' ? '<i class="fa-solid fa-triangle-exclamation"></i> Erreur' : '<i class="fa-solid fa-robot"></i> Tuteur IA'}</div>
      <div class="md" data-chat="${m.id}"></div>
    </div>`).join('') : '<div class="small dim" style="text-align:center;padding:12px">Aucun message pour l\'instant.</div>';
  for (const m of msgs) setMd($(`[data-chat="${m.id}"]`, log), m.content);
  log.scrollTop = log.scrollHeight;
}

async function initChat(root, rec) {
  let msgs = await api.chatList(rec.id);
  drawChat(root, msgs);
  const input = $('#chat-text', root);
  const btn = $('#chat-send', root);
  const sendMsg = async (text) => {
    const t = String(text || '').trim();
    if (!t || btn.disabled) return;
    btn.disabled = true;
    input.value = '';
    drawChat(root, [...msgs, { id: 'tmp', role: 'user', content: t }, { id: 'wait', role: 'assistant', content: '_Réflexion en cours…_' }]);
    const off = api.onChatProgress((p) => {
      const w = $('[data-chat="wait"]', root);
      if (p.correctionId === rec.id && w) w.textContent = p.message;
    });
    try {
      msgs = await api.chatSend(rec.id, t);
      drawChat(root, msgs);
    } catch (err) {
      toast(err.message, 'error', 8000);
      drawChat(root, msgs);
    } finally {
      off();
      btn.disabled = false;
      input.focus();
    }
  };
  btn.onclick = () => sendMsg(input.value);
  input.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMsg(input.value);
    }
  };
  $$('[data-suggest]', root).forEach((b) => (b.onclick = () => sendMsg(b.dataset.suggest)));
  $('#chat-clear', root).onclick = async () => {
    if (!msgs.length || !(await confirmBox('Effacer la discussion', 'Effacer tous les messages de cette discussion ?', 'Effacer'))) return;
    await api.chatClear(rec.id);
    msgs = [];
    drawChat(root, msgs);
  };
}

async function chooseFolder(rec) {
  state.folders = await api.folders();
  const b = await modal({
    title: 'Enregistrer dans un dossier',
    icon: 'fa-folder-plus',
    okLabel: 'Enregistrer',
    body: `
      <div class="field"><label class="label">Dossier existant</label>
        <select id="m-folder"><option value="">— Aucun (historique seulement) —</option>${folderOptions(state.folders, rec.folder_id)}</select></div>
      <div class="field"><label class="label">…ou créer un nouveau dossier (dans le dossier choisi ci-dessus)</label>
        <input id="m-newfolder" placeholder="Ex. : S1 — R1.05 Bases de données" /></div>
      <div class="field"><label class="label">Nom de la correction</label><input id="m-name" value="${esc(rec.name)}" /></div>`
  });
  if (!b) return;
  let folderId = Number($('#m-folder', b).value) || null;
  const newName = $('#m-newfolder', b).value.trim();
  try {
    if (newName) folderId = await api.createFolder(newName, folderId);
    const name = $('#m-name', b).value.trim();
    // Classer une correction l'enregistre (un brouillon rangé dans un dossier devient « compté »)
    await api.update(rec.id, { folderId, ...(folderId ? { counted: true } : {}), ...(name && name !== rec.name ? { name } : {}) });
    state.folders = await api.folders();
    toast(folderId ? 'Correction enregistrée dans le dossier.' : 'Correction retirée du dossier.', 'ok');
    refreshStats();
    go('result', { id: rec.id });
  } catch (err) {
    toast(err.message, 'error');
  }
}

register('result', {
  title: 'Résultat de la correction',
  nav: 'history',
  async show(root, { id }) {
    const rec = await api.get(id);
    if (!rec) {
      toast('Correction introuvable.', 'error');
      return back();
    }
    if (!state.folders.length) state.folders = await api.folders();
    render(root, rec);
  }
});
