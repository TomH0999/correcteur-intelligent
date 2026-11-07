// Traitement des PDF dans l'interface (pdf.js) : extraction du texte + rendu en image
// des pages scannées, manuscrites ou contenant des figures (schémas, graphes…).
import * as pdfjsLib from '../../node_modules/pdfjs-dist/build/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../../node_modules/pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href;

const MAX_RENDERED_PAGES = 40;
const MAX_PAGES = 200;

function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function pageText(page) {
  const content = await page.getTextContent();
  let out = '';
  let lastY = null;
  for (const it of content.items) {
    if (!('str' in it)) continue;
    const y = it.transform[5];
    if (lastY !== null && Math.abs(y - lastY) > 2) out += '\n';
    else if (out && !out.endsWith(' ') && it.str && !it.str.startsWith(' ')) out += ' ';
    out += it.str;
    if (it.hasEOL) out += '\n';
    lastY = y;
  }
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function hasFigures(page) {
  try {
    const ops = await page.getOperatorList();
    const O = pdfjsLib.OPS;
    let paths = 0;
    for (const fn of ops.fnArray) {
      if (fn === O.paintImageXObject || fn === O.paintInlineImageXObject || fn === O.paintImageMaskXObject) return true;
      if (fn === O.constructPath) paths++;
    }
    return paths > 60; // dessin vectoriel conséquent (schéma, graphe, MCD…)
  } catch {
    return false;
  }
}

async function renderPage(page, maxSide = 1700) {
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(2.5, maxSide / Math.max(base.width, base.height));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
  return dataUrl.split(',')[1];
}

/**
 * @param {string} base64 contenu du PDF
 * @param {string} label nom du fichier
 * @param {'auto'|'always'|'text'} mode
 * @returns {Promise<{parts: object[], warnings: string[], pages: number}>}
 */
export async function processPdf(base64, label, mode = 'auto', onPage = () => {}) {
  const warnings = [];
  const doc = await pdfjsLib.getDocument({ data: b64ToBytes(base64), isEvalSupported: false }).promise;
  const n = Math.min(doc.numPages, MAX_PAGES);
  if (doc.numPages > MAX_PAGES) warnings.push(`${label} : ${doc.numPages} pages, seules les ${MAX_PAGES} premières sont analysées.`);
  const parts = [];
  let rendered = 0;
  for (let i = 1; i <= n; i++) {
    onPage(i, n);
    const page = await doc.getPage(i);
    const text = await pageText(page);
    const pageLabel = `${label} — page ${i}`;
    if (text) parts.push({ type: 'text', text, label: pageLabel, fromPdf: true });
    let needImage = false;
    if (mode === 'always') needImage = true;
    else if (mode === 'auto') needImage = text.replace(/\s/g, '').length < 200 || (await hasFigures(page));
    if (needImage) {
      if (rendered < MAX_RENDERED_PAGES) {
        parts.push({ type: 'image', mime: 'image/jpeg', base64: await renderPage(page), label: `${pageLabel} (image)` });
        rendered++;
      } else if (rendered === MAX_RENDERED_PAGES) {
        warnings.push(`${label} : au-delà de ${MAX_RENDERED_PAGES} pages, seules le texte des pages est analysé.`);
        rendered++;
      }
    }
    page.cleanup();
  }
  await doc.destroy();
  return { parts, warnings, pages: n };
}

/** Redimensionne / normalise une image (JPEG ≤ 1800 px) pour la vision. */
export async function normalizeImage(base64, mime, maxSide = 1800) {
  const blob = new Blob([b64ToBytes(base64)], { type: mime });
  const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  return { base64: canvas.toDataURL('image/jpeg', 0.88).split(',')[1], mime: 'image/jpeg', width: canvas.width, height: canvas.height };
}
