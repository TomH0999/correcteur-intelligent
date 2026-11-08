// Révisions (fiches à répétition espacée) et exercices d'entraînement générés.
import { api, $, $$, esc, fr, toast, modal, confirmBox, emptyState, scoreColor, TYPE_LABELS } from '../ui.js';
import { register, go, state } from '../router.js';
import { setMd, renderMath } from '../markdown.js';
import { refreshStats } from '../shared.js';
import { processPdf, normalizeImage } from '../pdf.js';

// ======================================================= Fiches de révision
let session = null;

const BOX_LABEL = ['Nouvelle', '1 j', '2 j', '4 j', '8 j', '16 j', '32 j', '64 j'];

async function renderCards(root, params = {}) {
  const all = await api.cards(params.correctionId ? { correctionId: params.correctionId } : {});
  const due = (await api.cards({ dueOnly: true })).filter((c) => !params.correctionId || c.correction_id === params.correctionId);
  const boxes = Array(8).fill(0);
  all.forEach((c) => boxes[c.box]++);
  root.innerHTML = `
    <p class="page-intro">Des fiches sont créées automatiquement à partir de tes erreurs. Elles reviennent au bon moment (répétition espacée) : plus tu réponds juste, plus l'intervalle s'allonge.</p>
    ${params.correctionId ? `<div class="banner info"><i class="fa-solid fa-filter"></i><span>Fiches issues d'une seule correction.</span><span class="spacer"></span><button class="btn sm" id="c-all">Voir toutes les fiches</button></div>` : ''}
    <div class="grid2">
      <div class="card">
        <h2><i class="fa-solid fa-play"></i>Session de révision</h2>
        <div class="kpi-value">${due.length}<span class="small muted" style="font-weight:500"> fiche(s) à réviser maintenant</span></div>
        <div class="row" style="margin-top:16px">
          <button class="btn primary" id="c-start" ${due.length ? '' : 'disabled'}><i class="fa-solid fa-play"></i>Commencer</button>
          <button class="btn" id="c-add"><i class="fa-solid fa-plus"></i>Créer une fiche</button>
        </div>
      </div>
      <div class="card">
        <h2><i class="fa-solid fa-box-archive"></i>Boîtes de révision</h2>
        <div class="boxes">${boxes.map((n, i) => `<div><b>${n}</b>${BOX_LABEL[i]}</div>`).join('')}</div>
        <p class="xs dim" style="margin-bottom:0">Une fiche monte d'une boîte quand tu la réussis et redescend en boîte 1 quand tu l'oublies.</p>
      </div>
    </div>
    <div id="c-session"></div>
    <div class="card" style="margin-top:16px">
      <div class="row between"><h2 style="margin:0"><i class="fa-solid fa-layer-group"></i>Toutes les fiches (${all.length})</h2><input id="c-search" type="search" placeholder="Filtrer…" style="width:240px" /></div>
      <div class="list" id="c-list" style="margin-top:12px"></div>
    </div>`;
  const drawList = (q = '') => {
    const nq = q.toLowerCase();
    const items = all.filter((c) => !nq || `${c.front} ${c.back} ${c.notion} ${c.subject}`.toLowerCase().includes(nq));
    $('#c-list', root).innerHTML = items.map((c) => `
      <div class="item" data-id="${c.id}" style="cursor:default">
        <div class="item-icon"><i class="fa-solid fa-note-sticky"></i></div>
        <div class="item-main"><div class="item-name md-inline" data-front></div><div class="item-meta">${esc(c.notion || '')}${c.subject ? ` · ${esc(c.subject)}` : ''} · boîte ${c.box} · prochaine : ${new Date(c.due_at).toLocaleDateString('fr-FR')}</div></div>
        <button class="icon-btn" data-edit title="Modifier"><i class="fa-solid fa-pen"></i></button>
        <button class="icon-btn danger" data-del title="Supprimer"><i class="fa-solid fa-trash-can"></i></button>
      </div>`).join('') || emptyState('fa-layer-group', 'Aucune fiche. Elles sont créées automatiquement après chaque correction contenant des fautes.');
    $$('#c-list .item', root).forEach((el) => {
      const c = all.find((x) => x.id === Number(el.dataset.id));
      setMd($('[data-front]', el), c.front, { inline: true });
      $('[data-del]', el).onclick = async () => {
        if (!(await confirmBox('Supprimer la fiche', 'Supprimer cette fiche de révision ?'))) return;
        await api.deleteCard(c.id);
        refreshStats();
        renderCards(root, params);
      };
      $('[data-edit]', el).onclick = async () => {
        const b = await modal({ title: 'Modifier la fiche', icon: 'fa-pen', okLabel: 'Enregistrer', body: `<div class="field"><label class="label">Recto (question)</label><textarea id="m-front">${esc(c.front)}</textarea></div><div class="field"><label class="label">Verso (réponse)</label><textarea id="m-back" rows="5">${esc(c.back)}</textarea></div>` });
        if (!b) return;
        await api.updateCard(c.id, { front: $('#m-front', b).value, back: $('#m-back', b).value });
        renderCards(root, params);
      };
    });
  };
  drawList();
  $('#c-search', root).oninput = (e) => drawList(e.target.value);
  $('#c-all', root)?.addEventListener('click', () => go('cards'));
  $('#c-add', root).onclick = async () => {
    const b = await modal({ title: 'Nouvelle fiche', icon: 'fa-plus', okLabel: 'Créer', body: `<div class="field"><label class="label">Recto (question)</label><textarea id="m-front"></textarea></div><div class="field"><label class="label">Verso (réponse — Markdown et LaTeX $…$ acceptés)</label><textarea id="m-back" rows="5"></textarea></div><div class="field"><label class="label">Notion / matière</label><input id="m-notion" /></div>` });
    if (!b || !$('#m-front', b).value.trim()) return;
    await api.addCard({ front: $('#m-front', b).value.trim(), back: $('#m-back', b).value.trim(), notion: $('#m-notion', b).value.trim() });
    refreshStats();
    renderCards(root, params);
  };
  $('#c-start', root).onclick = () => {
    session = { queue: [...due], done: 0, total: due.length };
    nextCard(root, params);
  };
}

function nextCard(root, params) {
  const box = $('#c-session', root);
  if (!session.queue.length) {
    box.innerHTML = `<div class="card" style="margin-top:16px;text-align:center"><div style="font-size:40px">🎉</div><h2 style="justify-content:center">Session terminée</h2><p class="muted">${session.total} fiche(s) révisée(s). Reviens demain pour la suite !</p></div>`;
    session = null;
    refreshStats();
    return;
  }
  const c = session.queue[0];
  box.innerHTML = `
    <div style="margin-top:16px">
      <div class="row between small muted"><span>Fiche ${session.done + 1} / ${session.total}</span><span>${esc(c.notion || '')}${c.subject ? ` · ${esc(c.subject)}` : ''}</span></div>
      <div class="bar"><div style="width:${(session.done / session.total) * 100}%"></div></div>
      <div class="flashcard">
        <div class="front md" id="fc-front"></div>
        <div class="back md hidden" id="fc-back"></div>
        <div><button class="btn primary" id="fc-show"><i class="fa-solid fa-eye"></i>Voir la réponse (Espace)</button></div>
      </div>
      <div class="review-btns hidden" id="fc-grades">
        <button class="btn danger" data-g="again">Oublié<small>dans 10 min · 1</small></button>
        <button class="btn warn" data-g="hard">Difficile<small>2</small></button>
        <button class="btn primary" data-g="good">Bien<small>3</small></button>
        <button class="btn success" data-g="easy">Facile<small>4</small></button>
      </div>
    </div>`;
  setMd($('#fc-front', box), c.front);
  setMd($('#fc-back', box), c.back);
  const reveal = () => {
    $('#fc-back', box).classList.remove('hidden');
    $('#fc-show', box).parentElement.classList.add('hidden');
    $('#fc-grades', box).classList.remove('hidden');
  };
  const grade = async (g) => {
    document.onkeydown = null;
    await api.reviewCard(c.id, g);
    session.queue.shift();
    if (g === 'again') session.queue.push(c);
    else session.done++;
    nextCard(root, params);
  };
  $('#fc-show', box).onclick = reveal;
  $$('[data-g]', box).forEach((b) => (b.onclick = () => grade(b.dataset.g)));
  document.onkeydown = (e) => {
    if (state.current !== 'cards' || /INPUT|TEXTAREA/.test(e.target.tagName)) return;
    if (e.code === 'Space') { e.preventDefault(); reveal(); }
    const g = { 1: 'again', 2: 'hard', 3: 'good', 4: 'easy' }[e.key];
    if (g && !$('#fc-grades', box).classList.contains('hidden')) grade(g);
  };
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

register('cards', { title: 'Révisions', show: (root, params) => renderCards(root, params) });

// ======================================================= Exercices d'entraînement
async function renderTraining(root, params = {}) {
  const list = await api.exercises();
  const from = params.fromCorrection;
  const preNotions = params.notions || (from ? from.result.a_revoir.map((a) => a.notion).concat(from.result.fautes.map((f) => f.notion)).filter(Boolean) : []);
  const uniq = [...new Set(preNotions)].slice(0, 6);
  root.innerHTML = `
    <p class="page-intro">Génère des exercices ciblés sur tes points faibles, réponds directement dans l'application (texte, code ou photos), puis fais-les corriger. Tu peux tester ton code avant d'envoyer.</p>
    <div class="card">
      <h2><i class="fa-solid fa-wand-magic-sparkles"></i>Nouvel exercice</h2>
      <div class="grid2">
        <div class="field"><label class="label">Notions à travailler (séparées par des virgules)</label><input id="t-notions" value="${esc(uniq.join(', '))}" placeholder="Ex. : jointures SQL, GROUP BY / HAVING" /></div>
        <div class="field"><label class="label">Matière</label><input id="t-matiere" value="${esc(params.matiere || from?.result.matiere || '')}" placeholder="Ex. : R1.05 Bases de données" /></div>
        <div class="field"><label class="label">Type</label><select id="t-type"><option value="">Au choix</option>${Object.entries(TYPE_LABELS).map(([k, v]) => `<option value="${k}" ${from?.result.type_exercice === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
        <div class="field"><label class="label">Difficulté</label><select id="t-diff"><option value="facile">Facile</option><option value="moyenne" selected>Moyenne</option><option value="difficile">Difficile (niveau examen)</option></select></div>
      </div>
      <div class="field" style="margin-top:12px"><label class="label">Demande particulière (facultatif)</label><input id="t-consigne" placeholder="Ex. : en Java, avec des tests unitaires · sur le thème d'une bibliothèque" /></div>
      <div class="row" style="margin-top:16px;justify-content:flex-end"><button class="btn primary" id="t-gen"><i class="fa-solid fa-wand-magic-sparkles"></i>Générer l'exercice</button></div>
    </div>
    <div class="card" style="margin-top:16px">
      <h2><i class="fa-solid fa-dumbbell"></i>Mes exercices (${list.length})</h2>
      <div class="list">${list.map((e) => `
        <div class="item" data-id="${e.id}">
          <div class="item-icon"><i class="fa-solid ${e.done_correction_id ? 'fa-circle-check' : 'fa-dumbbell'}" style="${e.done_correction_id ? 'color:var(--emerald)' : ''}"></i></div>
          <div class="item-main"><div class="item-name">${esc(e.title)}</div><div class="item-meta">${esc(e.subject || '')} · ${esc(e.difficulty || '')} · ${e.notions.map(esc).join(', ')}</div></div>
          ${e.done_correction_id ? `<div class="item-score" style="color:${scoreColor(e.done_score)}">${fr(e.done_grade)}<span>/${e.done_grade_max}</span></div>` : '<span class="badge">à faire</span>'}
        </div>`).join('') || emptyState('fa-dumbbell', 'Aucun exercice pour l\'instant.')}</div>
    </div>`;
  $$('.item', root).forEach((el) => (el.onclick = () => go('exercise', { id: Number(el.dataset.id) })));
  $('#t-gen', root).onclick = async (e) => {
    const notions = $('#t-notions', root).value.split(',').map((s) => s.trim()).filter(Boolean);
    if (!notions.length) return toast('Indique au moins une notion à travailler.', 'warn');
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.innerHTML = '<div class="spinner sm"></div>Génération…';
    try {
      const id = await api.generateExercise({ notions, matiere: $('#t-matiere', root).value.trim(), type: $('#t-type', root).value, difficulte: $('#t-diff', root).value, consigne: $('#t-consigne', root).value.trim(), sourceCorrectionId: from?.id || null });
      go('exercise', { id });
    } catch (err) {
      toast(err.message, 'error', 10000);
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i>Générer l\'exercice';
    }
  };
}

register('training', { title: 'Exercices d\'entraînement', show: (root, params) => renderTraining(root, params) });

// ---------- Faire un exercice ----------
const RUN_LANGS = [['python', 'Python'], ['javascript', 'JavaScript'], ['typescript', 'TypeScript'], ['sql', 'SQL (Oracle, MySQL, PostgreSQL…)'], ['java', 'Java'], ['c', 'C'], ['cpp', 'C++'], ['php', 'PHP']];

function guessLang(ex) {
  const l = `${ex.language || ''} ${ex.exercise_type || ''}`.toLowerCase();
  if (/sql|base_de_donnees/.test(l)) return 'sql';
  if (/typescript|\bts\b/.test(l)) return 'typescript';
  if (/java(?!script)/.test(l)) return 'java';
  if (/javascript|js|web/.test(l)) return 'javascript';
  if (/c\+\+|cpp/.test(l)) return 'cpp';
  if (/\bc\b/.test(l)) return 'c';
  if (/php/.test(l)) return 'php';
  return 'python';
}

async function renderExercise(root, { id }) {
  const ex = await api.exercise(id);
  if (!ex) return go('training');
  const attachments = [];
  root.innerHTML = `
    <div class="toolbar"><button class="btn sm" id="e-back"><i class="fa-solid fa-arrow-left"></i>Exercices</button><span class="spacer"></span>
      ${ex.done_correction_id ? '<button class="btn sm" id="e-see"><i class="fa-solid fa-clipboard-check"></i>Voir la correction</button>' : ''}
      <button class="btn sm danger" id="e-del"><i class="fa-solid fa-trash-can"></i></button></div>
    <div class="card">
      <div class="row wrap">${ex.notions.map((n) => `<span class="badge brand">${esc(n)}</span>`).join('')}<span class="badge">${esc(ex.difficulty || '')}</span></div>
      <div class="r-title">${esc(ex.title)}</div>
      <div class="md" id="e-statement"></div>
      ${ex.answer_format ? `<p class="small muted"><i class="fa-solid fa-circle-info"></i> ${esc(ex.answer_format)}</p>` : ''}
    </div>
    <div class="card" style="margin-top:16px">
      <h2><i class="fa-solid fa-pen-nib"></i>Ma réponse</h2>
      <textarea id="e-answer" class="code" rows="14" placeholder="Rédige ta réponse ici (texte, code, requêtes…). Tu peux aussi joindre des photos de ta copie.">${esc(ex.draft || '')}</textarea>
      <div class="row wrap" style="margin-top:10px">
        <select id="e-lang" style="width:170px">${RUN_LANGS.map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
        <button class="btn" id="e-run"><i class="fa-solid fa-play"></i>Tester mon code</button>
        <button class="btn" id="e-attach"><i class="fa-solid fa-paperclip"></i>Joindre des fichiers / photos</button>
        <span class="small muted" id="e-attached"></span>
        <span class="spacer"></span>
        <label class="check" title="Décoche pour un essai qui ne compte pas dans tes statistiques"><input type="checkbox" id="e-save" checked /><span>Enregistrer</span></label>
        <button class="btn primary" id="e-submit"><i class="fa-solid fa-paper-plane"></i>Faire corriger</button>
      </div>
      <div class="field hidden" id="e-stdin-wrap" style="margin-top:10px"><label class="label">Entrée standard (facultatif)</label><textarea id="e-stdin" rows="2" class="code"></textarea></div>
      <pre id="e-output" class="hidden" style="margin-top:10px;max-height:260px;overflow:auto"></pre>
    </div>`;
  setMd($('#e-statement', root), ex.statement);
  $('#e-lang', root).value = guessLang(ex);
  let saveTimer;
  $('#e-answer', root).oninput = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => api.updateExercise(id, { draft: $('#e-answer', root).value }), 600); };
  $('#e-back', root).onclick = () => go('training');
  $('#e-see', root)?.addEventListener('click', () => go('result', { id: ex.done_correction_id }));
  $('#e-del', root).onclick = async () => {
    if (!(await confirmBox('Supprimer l\'exercice', `Supprimer « ${ex.title} » ?`))) return;
    await api.deleteExercise(id);
    go('training');
  };
  $('#e-run', root).onclick = async (e) => {
    const btn = e.currentTarget;
    $('#e-stdin-wrap', root).classList.remove('hidden');
    const out = $('#e-output', root);
    out.classList.remove('hidden');
    out.textContent = 'Exécution…';
    btn.disabled = true;
    try {
      const r = await api.runCode({ language: $('#e-lang', root).value, code: $('#e-answer', root).value, stdin: $('#e-stdin', root).value, timeoutMs: 10000 });
      out.textContent = `${r.stdout || ''}${r.stderr ? `\n${r.stderr}` : ''}`.trim() || '(aucune sortie)';
      out.style.borderColor = r.ok ? 'rgb(16 185 129 / .4)' : 'rgb(244 63 94 / .4)';
    } catch (err) {
      out.textContent = err.message;
    }
    btn.disabled = false;
  };
  $('#e-attach', root).onclick = async () => {
    for (const p of await api.pickFiles()) {
      const res = await api.extract(p);
      const parts = [];
      for (const part of res.parts) {
        if (part.type === 'pdf') parts.push(...(await processPdf(part.base64, part.label, state.settings?.pdfMode || 'auto')).parts);
        else if (part.type === 'image') parts.push({ ...part, ...(await normalizeImage(part.base64, part.mime)) });
        else parts.push(part);
      }
      attachments.push({ name: res.name, parts });
    }
    $('#e-attached', root).textContent = attachments.length ? `${attachments.length} fichier(s) joint(s)` : '';
  };
  $('#e-submit', root).onclick = async (e) => {
    const answer = $('#e-answer', root).value;
    if (!answer.trim() && !attachments.length) return toast('Écris ta réponse ou joins une photo de ta copie.', 'warn');
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.innerHTML = '<div class="spinner sm"></div>Correction…';
    const off = api.onProgress((p) => { btn.lastChild.textContent = p.message.length > 40 ? p.message.slice(0, 40) + '…' : p.message; });
    try {
      const { id: cid, warnings } = await api.submitExercise({ id, answer, files: attachments, counted: $('#e-save', root).checked });
      warnings?.forEach((w) => toast(w, 'warn', 8000));
      refreshStats();
      go('result', { id: cid });
    } catch (err) {
      toast(err.message, 'error', 10000);
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i>Faire corriger';
    } finally {
      off();
    }
  };
  renderMath(root);
}

register('exercise', { title: 'Exercice d\'entraînement', nav: 'training', show: (root, params) => renderExercise(root, params) });
