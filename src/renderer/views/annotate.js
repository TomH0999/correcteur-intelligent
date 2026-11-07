// Copie annotée : les fautes sont surlignées directement sur les pages de la copie
// (position des mots pour les PDF avec texte, localisation par l'IA de vision pour les photos/scans)
// ou dans le texte des fichiers (code, documents).
import { api, $, $$, esc, toast, emptyState } from '../ui.js';
import { register, go } from '../router.js';
import { setMd } from '../markdown.js';

const COLORS = { majeure: '#fb7185', moyenne: '#fbbf24', mineure: '#60a5fa' };
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Boîtes (coordonnées 0–1) des mots d'une page correspondant à un extrait de la copie. */
function findBoxes(items, extrait) {
  if (!items?.length || !extrait) return [];
  let big = '';
  const map = [];
  items.forEach((it, i) => {
    for (const ch of norm(it[0])) {
      big += ch;
      map.push(i);
    }
  });
  const full = norm(extrait);
  for (const len of [80, 40, 20]) {
    const target = full.slice(0, len);
    if (target.length < Math.min(8, full.length) || target.length < 4) continue;
    const idx = big.indexOf(target);
    if (idx < 0) continue;
    const end = Math.min(map.length - 1, idx + Math.max(target.length, full.length) - 1);
    const used = [...new Set(map.slice(idx, end + 1))].map((i) => items[i]);
    // Un rectangle par ligne
    const lines = [];
    for (const it of used) {
      const line = lines.find((l) => Math.abs(l.y - it[2]) < it[4] * 0.6);
      if (line) {
        line.x0 = Math.min(line.x0, it[1]);
        line.x1 = Math.max(line.x1, it[1] + it[3]);
        line.y1 = Math.max(line.y1, it[2] + it[4]);
      } else lines.push({ x0: it[1], y: it[2], x1: it[1] + it[3], y1: it[2] + it[4] });
    }
    return lines.map((l) => [l.x0 - 0.004, l.y - 0.003, l.x1 + 0.004, l.y1 + 0.003]);
  }
  return [];
}

function highlightText(text, fautes) {
  let html = esc(text);
  fautes.forEach((f, i) => {
    if (!f.extrait || f.extrait.length < 3) return;
    const words = esc(f.extrait.slice(0, 220)).trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (!words.length) return;
    const re = new RegExp(words.join('\\s+'));
    html = html.replace(re, (m) => `<mark class="ann-mark" data-f="${i}" style="--c:${COLORS[f.gravite]}">${m}<sup>${i + 1}</sup></mark>`);
  });
  return html;
}

async function render(root, { id }) {
  const rec = await api.get(id);
  if (!rec) return go('history');
  const r = rec.result;
  const fautes = r.fautes;
  const answerFiles = new Set(r.identification?.reponses || []);
  const isAnswer = (file, label = '') => !answerFiles.size || answerFiles.has(file) || [...answerFiles].some((f) => label.includes(f) || f.includes(file));
  const pages = (rec.pages || []).filter((p) => isAnswer(p.file, p.label));
  const pageFiles = new Set(pages.map((p) => p.file));
  // Documents texte (code, Word…) sans aperçu d'image
  const texts = (rec.sources || []).filter((s) => s.kind !== 'image' && !pageFiles.has(s.file) && isAnswer(s.file, s.label));
  const visionPages = pages.filter((p) => !p.items?.length);
  root.innerHTML = `
    <div class="toolbar">
      <button class="btn sm" id="an-back"><i class="fa-solid fa-arrow-left"></i>Retour à la correction</button>
      <span class="spacer"></span>
      ${visionPages.length ? `<button class="btn sm primary" id="an-locate"><i class="fa-solid fa-crosshairs"></i>${rec.annotations?.length ? 'Relocaliser' : 'Localiser'} les fautes sur les photos (IA)</button>` : ''}
    </div>
    <div class="annot-layout">
      <div id="an-docs">
        ${!pages.length && !texts.length ? emptyState('fa-file-image', 'Aucune page de copie enregistrée pour cette correction (les corrections faites avant la version 1.2 n\'ont pas d\'aperçu).') : ''}
        ${pages.map((p) => `
          <div class="card tight annot-page" data-page="${p.id}">
            <div class="row between small muted" style="margin-bottom:8px"><span><i class="fa-solid fa-file-image"></i> ${esc(p.label)}</span><span>${p.items?.length ? 'repérage par le texte' : 'repérage par l\'IA de vision'}</span></div>
            <div class="annot-wrap" style="aspect-ratio:${p.w}/${p.h}"><img alt="" data-img="${esc(p.img)}" /><svg viewBox="0 0 1000 ${Math.round((1000 * p.h) / p.w)}" preserveAspectRatio="none"></svg></div>
          </div>`).join('')}
        ${texts.map((s, i) => `
          <div class="card tight" style="margin-top:16px">
            <div class="small muted" style="margin-bottom:8px"><i class="fa-solid fa-file-code"></i> ${esc(s.label)}</div>
            <pre class="annot-text" data-text="${i}"></pre>
          </div>`).join('')}
      </div>
      <div class="card tight annot-side">
        <div class="section-title"><i class="fa-solid fa-bug"></i>Fautes (${fautes.length})</div>
        <div id="an-status" class="xs dim"></div>
        ${fautes.map((f, i) => `
          <div class="annot-fault" data-f="${i}" style="--c:${COLORS[f.gravite]}">
            <div class="row"><span class="annot-num">${i + 1}</span><span class="tag ${f.gravite === 'majeure' ? 'ko' : f.gravite === 'moyenne' ? 'mid' : 'brand'}">${f.gravite}</span><span class="xs dim">${f.question ? `Q. ${esc(f.question)}` : ''}</span><span class="spacer"></span><span class="xs dim" data-found="${i}"></span></div>
            <div class="md small" data-desc="${i}"></div>
          </div>`).join('') || '<p class="muted small">Aucune faute à afficher.</p>'}
      </div>
    </div>`;
  $$('[data-desc]', root).forEach((el) => setMd(el, fautes[Number(el.dataset.desc)].description));
  $('#an-back', root).onclick = () => go('result', { id });

  const found = new Map(); // faute -> nombre de repérages
  const draw = (annotations) => {
    found.clear();
    for (const p of pages) {
      const svg = $(`[data-page="${p.id}"] svg`, root);
      const H = Math.round((1000 * p.h) / p.w);
      const boxes = [];
      if (p.items?.length) fautes.forEach((f, i) => findBoxes(p.items, f.extrait).forEach((b) => boxes.push({ f: i, b })));
      for (const a of annotations || []) if (a.page === p.id) a.boxes.forEach((b) => boxes.push({ f: a.faute, b }));
      svg.innerHTML = boxes.map(({ f, b }, k) => {
        const [x0, y0, x1, y1] = b;
        const c = COLORS[fautes[f]?.gravite] || COLORS.moyenne;
        found.set(f, (found.get(f) || 0) + 1);
        const first = boxes.findIndex((x) => x.f === f) === k;
        return `<g class="ann-box" data-f="${f}"><rect x="${x0 * 1000}" y="${y0 * H}" width="${(x1 - x0) * 1000}" height="${(y1 - y0) * H}" rx="4" fill="${c}33" stroke="${c}" stroke-width="2.5"/>${first ? `<circle cx="${x0 * 1000}" cy="${y0 * H}" r="13" fill="${c}"/><text x="${x0 * 1000}" y="${y0 * H + 5}" text-anchor="middle" font-size="15" font-weight="700" fill="#020617">${f + 1}</text>` : ''}</g>`;
      }).join('');
    }
    $$('[data-text]', root).forEach((pre) => {
      pre.innerHTML = highlightText(texts[Number(pre.dataset.text)].text, fautes);
      $$('.ann-mark', pre).forEach((m) => found.set(Number(m.dataset.f), (found.get(Number(m.dataset.f)) || 0) + 1));
    });
    $$('[data-found]', root).forEach((el) => {
      const n = found.get(Number(el.dataset.found));
      el.innerHTML = n ? '<i class="fa-solid fa-location-dot" style="color:var(--emerald)"></i> repérée' : 'non repérée';
    });
    bindHover();
  };

  const focusFault = (i, scroll) => {
    $$('.ann-box, .ann-mark', root).forEach((el) => el.classList.toggle('active', Number(el.dataset.f) === i));
    $$('.annot-fault', root).forEach((el) => el.classList.toggle('active', Number(el.dataset.f) === i));
    if (scroll) $(`.ann-box[data-f="${i}"], .ann-mark[data-f="${i}"]`, root)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  function bindHover() {
    $$('.ann-box, .ann-mark', root).forEach((el) => (el.onclick = () => {
      const i = Number(el.dataset.f);
      focusFault(i, false);
      $(`.annot-fault[data-f="${i}"]`, root)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }));
  }
  $$('.annot-fault', root).forEach((el) => (el.onclick = () => focusFault(Number(el.dataset.f), true)));

  // Images chargées depuis le dossier de données
  await Promise.all($$('[data-img]', root).map(async (img) => { img.src = await api.readPage(img.dataset.img); }));
  draw(rec.annotations);

  const btn = $('#an-locate', root);
  if (btn) {
    btn.onclick = async () => {
      btn.disabled = true;
      btn.innerHTML = '<div class="spinner sm"></div>Localisation…';
      const off = api.onAnnotateProgress((p) => { if (p.correctionId === id) $('#an-status', root).textContent = p.message; });
      try {
        const ann = await api.locateFaults(id);
        draw(ann);
        $('#an-status', root).textContent = `${ann.length} repérage(s) sur les photos.`;
      } catch (err) {
        toast(err.message, 'error', 8000);
      } finally {
        off();
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-crosshairs"></i>Relocaliser les fautes sur les photos (IA)';
      }
    };
    // Premier affichage : localisation automatique si rien n'a encore été fait
    if (!rec.annotations?.length && fautes.length) btn.click();
  }
}

register('annotate', { title: 'Copie annotée', nav: 'history', show: (root, params) => render(root, params) });
