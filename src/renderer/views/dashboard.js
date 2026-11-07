// Tableau de bord de progression : notes dans le temps, matières, notions qui reviennent.
import { api, $, $$, esc, fr, emptyState, scoreColor } from '../ui.js';
import { register, go } from '../router.js';

// Palette catégorielle validée (daltonisme + contraste) sur la surface #0f172a — ordre fixe, jamais recyclé
const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#9085e9'];
const OTHER = '#64748b';

let tip;
function showTip(e, html) {
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'chart-tip';
    document.body.appendChild(tip);
  }
  tip.innerHTML = html;
  tip.style.display = 'block';
  const x = Math.min(window.innerWidth - tip.offsetWidth - 12, e.clientX + 14);
  const y = Math.min(window.innerHeight - tip.offsetHeight - 12, e.clientY + 14);
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
}
function hideTip() {
  if (tip) tip.style.display = 'none';
}

function kpi(icon, label, value, sub = '') {
  return `<div class="kpi"><div class="kpi-label"><i class="fa-solid ${icon}"></i>${label}</div><div class="kpi-value">${value}</div><div class="kpi-sub">${sub}</div></div>`;
}

/** Courbe des scores (%) dans le temps, une série par matière (6 max + « Autres »). */
function lineChart(timeline, subjectsOrder) {
  const pts = timeline.filter((p) => p.score != null);
  if (pts.length < 2) return emptyState('fa-chart-line', 'La courbe apparaîtra après au moins deux corrections.');
  const top = subjectsOrder.slice(0, SERIES.length);
  const colorOf = (s) => (top.includes(s) ? SERIES[top.indexOf(s)] : OTHER);
  const groupOf = (s) => (top.includes(s) ? s : 'Autres matières');
  const W = 900;
  const H = 300;
  const m = { l: 44, r: 150, t: 14, b: 30 };
  // Axe horizontal ordinal (1re, 2e… correction) : lisible même si plusieurs corrections ont lieu le même jour
  const index = new Map(pts.map((p, i) => [p, i]));
  const Xi = (i) => m.l + 12 + (i / Math.max(1, pts.length - 1)) * (W - m.l - m.r - 24);
  const X = (p) => Xi(index.get(p));
  const Y = (v) => m.t + (1 - v / 100) * (H - m.t - m.b);
  const groups = {};
  for (const p of pts) (groups[groupOf(p.subject)] ||= []).push(p);
  const names = Object.keys(groups);
  const single = names.length === 1;
  let svg = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Évolution des scores">`;
  for (const v of [0, 25, 50, 75, 100]) {
    svg += `<line class="grid-line" x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}"/><text class="axis-label" x="${m.l - 8}" y="${Y(v) + 4}" text-anchor="end">${v} %</text>`;
  }
  // Repères de dates
  const step = Math.max(1, Math.ceil(pts.length / 6));
  let lastLabel = '';
  for (let i = 0; i < pts.length; i += step) {
    const lab = new Date(pts[i].date).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' });
    if (lab !== lastLabel) svg += `<text class="axis-label" x="${Xi(i)}" y="${H - 8}" text-anchor="middle">${lab}</text>`;
    lastLabel = lab;
  }
  const labels = [];
  for (const name of names) {
    const g = groups[name];
    const color = single ? SERIES[0] : name === 'Autres matières' ? OTHER : colorOf(name);
    if (g.length > 1) svg += `<polyline fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" points="${g.map((p) => `${X(p)},${Y(p.score)}`).join(' ')}"/>`;
    for (const p of g) {
      svg += `<circle class="dot" cx="${X(p)}" cy="${Y(p.score)}" r="4.5" fill="${color}"/>`;
      svg += `<circle cx="${X(p)}" cy="${Y(p.score)}" r="11" fill="transparent" data-id="${p.id}" data-tip="${esc(`<strong>${esc(p.name)}</strong><br>${fr(p.score, 1)} % · ${new Date(p.date).toLocaleDateString('fr-FR')}`)}" style="cursor:pointer"/>`;
    }
    const last = g[g.length - 1];
    labels.push({ y: Y(last.score), name, color, x: X(last) });
  }
  // Étiquettes directes (≤ 4 séries), décalées pour éviter les chevauchements
  if (!single && names.length <= 4) {
    labels.sort((a, b) => a.y - b.y);
    for (let i = 1; i < labels.length; i++) if (labels[i].y - labels[i - 1].y < 14) labels[i].y = labels[i - 1].y + 14;
    for (const l of labels) svg += `<text x="${W - m.r + 10}" y="${l.y + 4}" fill="#cbd5e1" font-size="12">${esc(l.name.length > 20 ? l.name.slice(0, 19) + '…' : l.name)}</text>`;
  }
  svg += '</svg>';
  const legend = single ? '' : `<div class="legend">${names.map((n) => `<span><i style="background:${n === 'Autres matières' ? OTHER : colorOf(n)}"></i>${esc(n)}</span>`).join('')}</div>`;
  return svg + legend;
}

function bars(items, { valueLabel, color = SERIES[0], onClick } = {}) {
  if (!items.length) return emptyState('fa-circle-check', 'Rien à signaler pour l\'instant.');
  const max = Math.max(...items.map((i) => i.value));
  return items.map((i, k) => `
    <div class="hbar" ${onClick ? `data-k="${k}" style="cursor:pointer"` : ''} title="${esc(i.title || '')}">
      <div class="hbar-name">${esc(i.label)}</div>
      <div class="hbar-track"><div class="hbar-fill" style="width:${(i.value / max) * 100}%;background:${color}"></div></div>
      <div class="small muted mono">${valueLabel(i)}</div>
    </div>`).join('');
}

/** Réussite du premier coup et amélioration entre la 1re et la dernière tentative (corrections enregistrées). */
function attemptsSection(a) {
  if (!a || !a.exercises) return '';
  const pct = (v) => (v == null ? '—' : `${fr(v, 1)} %`);
  const signed = (v) => (v == null ? '—' : `<span class="delta ${v >= 0 ? 'up' : 'down'}">${v >= 0 ? '+' : ''}${fr(v, 1)} pts</span>`);
  return `
    <div class="card" style="margin-top:16px">
      <h2><i class="fa-solid fa-bullseye"></i>Réussite des exercices</h2>
      <p class="small muted" style="margin-top:-6px">Calculé uniquement sur les corrections <strong>enregistrées</strong>. Un exercice est réussi à partir de ${a.threshold} % (${a.threshold / 5}/20). Les copies d'un même énoncé sont regroupées en tentatives ; une re-correction de la même copie ne compte pas comme nouvelle tentative.</p>
      <div class="grid4">
        ${kpi('fa-bolt', 'Réussite du premier coup', `<span style="color:${scoreColor(a.firstTryRate)}">${pct(a.firstTryRate)}</span>`, `${a.exercises} exercice(s) · 1re tentative : ${pct(a.avgFirstScore)} en moyenne`)}
        ${kpi('fa-arrow-trend-up', 'Amélioration moyenne', a.avgImprovement == null ? '—' : `${a.avgImprovement >= 0 ? '+' : ''}${fr(a.avgImprovement, 1)} pts`, a.reworked ? `de la 1re à la dernière réponse · ${a.reworked} exercice(s) retravaillé(s)` : 'renvoie une nouvelle réponse à un exercice pour la mesurer')}
        ${kpi('fa-chart-simple', 'Exercices en progrès', pct(a.improvedRate), 'parmi les exercices retravaillés')}
        ${kpi('fa-life-ring', 'Rattrapés', pct(a.recoveredRate), `exercices ratés du 1er coup puis réussis · réussite finale ${pct(a.finalRate)}`)}
      </div>
      ${a.series.length ? `
      <table class="cmp-table" style="margin-top:16px">
        <thead><tr><th>Exercice</th><th>Tentatives</th><th>1re</th><th>Dernière</th><th>Évolution</th><th></th></tr></thead>
        <tbody>${a.series.slice(0, 15).map((s) => `<tr data-series="${s.attempts[s.attempts.length - 1].id}" style="cursor:pointer">
          <td>${esc(s.title)}${s.subject ? `<div class="xs dim">${esc(s.subject)}</div>` : ''}</td>
          <td class="mono">${s.count}</td>
          <td class="mono" style="color:${scoreColor(s.first)}">${fr(s.first, 1)} %</td>
          <td class="mono" style="color:${scoreColor(s.last)}">${s.count > 1 ? `${fr(s.last, 1)} %` : '—'}</td>
          <td>${signed(s.improvement)}</td>
          <td>${s.firstSuccess ? '<span class="tag ok">1er coup</span>' : s.finalSuccess ? '<span class="tag brand">rattrapé</span>' : '<span class="tag ko">à retravailler</span>'}</td>
        </tr>`).join('')}</tbody>
      </table>` : ''}
    </div>`;
}

async function render(root) {
  const d = await api.dashboard();
  const scored = d.timeline.filter((t) => t.score != null);
  const avg = scored.length ? scored.reduce((s, t) => s + t.score, 0) / scored.length : null;
  const last5 = scored.slice(-5);
  const prev5 = scored.slice(-10, -5);
  const mean = (a) => (a.length ? a.reduce((s, t) => s + t.score, 0) / a.length : null);
  const trend = last5.length && prev5.length ? mean(last5) - mean(prev5) : null;
  if (!d.timeline.length) {
    root.innerHTML = emptyState('fa-chart-line', 'Ton tableau de bord se remplira au fil de tes corrections.<br><br><button class="btn primary" id="d-start"><i class="fa-solid fa-wand-magic-sparkles"></i>Lancer une correction</button>');
    $('#d-start', root).onclick = () => go('new');
    return;
  }
  root.innerHTML = `
    <div class="grid4">
      ${kpi('fa-file-circle-check', 'Corrections', d.timeline.length, `${d.timeline.filter((t) => t.kind === 'practice').length} entraînement(s)`)}
      ${kpi('fa-percent', 'Score moyen', avg != null ? `<span style="color:${scoreColor(avg)}">${fr(avg, 1)} %</span>` : '—', trend != null ? `${trend >= 0 ? '▲' : '▼'} ${fr(Math.abs(trend), 1)} pts sur les 5 dernières` : 'sur l\'ensemble')}
      ${kpi('fa-layer-group', 'Fiches à réviser', d.cards.due || 0, `${d.cards.total || 0} fiche(s) · ${d.cards.mastered || 0} maîtrisée(s)`)}
      ${kpi('fa-dumbbell', 'Exercices faits', `${d.exercises.done || 0}/${d.exercises.total || 0}`, 'exercices d\'entraînement')}
    </div>
    ${attemptsSection(d.attempts)}
    <div class="card" style="margin-top:16px">
      <h2><i class="fa-solid fa-chart-line"></i>Évolution de tes scores</h2>
      <div id="d-line">${lineChart(d.timeline, d.bySubject.map((s) => s.subject))}</div>
    </div>
    <div class="grid2" style="margin-top:16px">
      <div class="card">
        <h2><i class="fa-solid fa-bullseye"></i>Notions qui reviennent dans tes fautes</h2>
        <div id="d-notions">${bars(d.topNotions.slice(0, 10).map((n) => ({ label: n.notion, value: n.count, title: `${n.subjects.join(', ')} · dernière fois le ${new Date(n.last).toLocaleDateString('fr-FR')}`, raw: n })), { valueLabel: (i) => `${fr(i.value, 1)}×${i.raw.majeures ? ` · ${i.raw.majeures} maj.` : ''}`, onClick: true })}</div>
        <p class="xs dim" style="margin-bottom:0">Clique sur une notion pour générer un exercice d'entraînement ciblé.</p>
      </div>
      <div class="card">
        <h2><i class="fa-solid fa-tags"></i>Types d'erreurs</h2>
        ${bars(d.categories.slice(0, 10).map((c) => ({ label: c.categorie.replace(/_/g, ' '), value: c.count })), { valueLabel: (i) => `${i.value}`, color: SERIES[1] })}
      </div>
    </div>
    <div class="card" style="margin-top:16px">
      <h2><i class="fa-solid fa-table"></i>Par matière</h2>
      <table class="cmp-table">
        <thead><tr><th>Matière</th><th>Corrections</th><th>Score moyen</th><th>Tendance</th><th>Dernière</th></tr></thead>
        <tbody>${d.bySubject.map((s) => `<tr>
          <td>${esc(s.subject)}</td><td class="mono">${s.count}</td>
          <td class="mono" style="color:${scoreColor(s.avg)}">${s.avg != null ? `${fr(s.avg, 1)} %` : '—'}</td>
          <td>${s.trend == null ? '<span class="dim">—</span>' : `<span class="delta ${s.trend >= 0 ? 'up' : 'down'}">${s.trend >= 0 ? '▲' : '▼'} ${fr(Math.abs(s.trend), 1)} pts</span>`}</td>
          <td class="small muted">${new Date(s.last).toLocaleDateString('fr-FR')}</td></tr>`).join('')}</tbody>
      </table>
    </div>`;
  $$('[data-series]', root).forEach((el) => (el.onclick = () => go('result', { id: Number(el.dataset.series) })));
  $$('[data-tip]', root).forEach((el) => {
    el.addEventListener('mousemove', (e) => showTip(e, el.dataset.tip));
    el.addEventListener('mouseleave', hideTip);
    el.addEventListener('click', () => { hideTip(); go('result', { id: Number(el.dataset.id) }); });
  });
  $$('#d-notions .hbar', root).forEach((el) => (el.onclick = () => {
    const n = d.topNotions[Number(el.dataset.k)];
    go('training', { notions: [n.notion], matiere: n.subjects[0] });
  }));
}

register('dashboard', { title: 'Progression', show: (root) => render(root) });
