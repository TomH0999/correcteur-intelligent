'use strict';
/**
 * Extraction universelle de contenu.
 * Transforme n'importe quel fichier en « parties » exploitables par l'IA :
 *   { type: 'text',  text, label }
 *   { type: 'image', mime, base64, label }       -> transcrite ensuite par le modèle de vision
 *   { type: 'pdf',   base64, label }             -> traité côté interface (texte + rendu des pages)
 *   { type: 'audio', mime, base64, label, filename } -> transcrit par Whisper (Groq)
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const JSZip = require('jszip');
const mammoth = require('mammoth');
const XLSX = require('xlsx');

const MAX_FILE_SIZE = 200 * 1024 * 1024; // 200 Mo
const MAX_AUDIO_SIZE = 25 * 1024 * 1024; // limite Groq Whisper (offre gratuite)
const MAX_ARCHIVE_ENTRIES = 300;
const MAX_ARCHIVE_DEPTH = 3;
const MAX_TEXT_PER_FILE = 400_000;

const IMAGE_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.jfif': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp', '.avif': 'image/avif',
  '.ico': 'image/x-icon'
};
const UNSUPPORTED_IMAGE_EXT = ['.heic', '.heif', '.tif', '.tiff', '.raw', '.cr2', '.nef', '.psd'];
const AUDIO_EXT = {
  '.mp3': 'audio/mpeg', '.mpga': 'audio/mpeg', '.mpeg': 'audio/mpeg', '.wav': 'audio/wav',
  '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.flac': 'audio/flac',
  '.webm': 'audio/webm', '.mp4': 'video/mp4'
};
const SPREADSHEET_EXT = ['.xlsx', '.xlsm', '.xls', '.ods', '.csv', '.tsv', '.numbers'];
const IGNORED_ENTRIES = /(^|\/)(__MACOSX|\.git|node_modules|\.idea|\.vscode|__pycache__|\.DS_Store|Thumbs\.db|bin\/Debug|obj\/)/i;

// Langages / formats texte courants en BUT Informatique (liste indicative : tout fichier texte est accepté)
const LANG_BY_EXT = {
  '.py': 'python', '.ipynb': 'python', '.java': 'java', '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.hpp': 'cpp',
  '.cc': 'cpp', '.cs': 'csharp', '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.ts': 'typescript',
  '.tsx': 'tsx', '.jsx': 'jsx', '.php': 'php', '.rb': 'ruby', '.go': 'go', '.rs': 'rust', '.kt': 'kotlin',
  '.swift': 'swift', '.sql': 'sql', '.html': 'html', '.htm': 'html', '.css': 'css', '.scss': 'scss',
  '.vue': 'vue', '.svelte': 'svelte', '.sh': 'bash', '.bash': 'bash', '.ps1': 'powershell', '.bat': 'batch',
  '.json': 'json', '.xml': 'xml', '.yml': 'yaml', '.yaml': 'yaml', '.md': 'markdown', '.tex': 'latex',
  '.r': 'r', '.m': 'matlab', '.asm': 'asm', '.s': 'asm', '.hs': 'haskell', '.ml': 'ocaml', '.scala': 'scala',
  '.dart': 'dart', '.lua': 'lua', '.pl': 'perl', '.puml': 'plantuml', '.plantuml': 'plantuml', '.mmd': 'mermaid',
  '.dockerfile': 'dockerfile', '.toml': 'toml', '.ini': 'ini', '.gradle': 'groovy', '.twig': 'twig',
  '.cypher': 'cypher', '.graphql': 'graphql', '.prolog': 'prolog', '.pro': 'prolog', '.vhd': 'vhdl', '.v': 'verilog'
};

function langFor(name) {
  const base = path.basename(name).toLowerCase();
  if (base === 'dockerfile') return 'dockerfile';
  if (base === 'makefile') return 'makefile';
  return LANG_BY_EXT[path.extname(base)] || '';
}

/** Détecte si un buffer est du texte (UTF-8 / UTF-16 / Latin-1). Renvoie la chaîne ou null. */
function decodeText(buf) {
  if (!buf || buf.length === 0) return '';
  // BOM UTF-16
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.slice(2).toString('utf16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.slice(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  const sample = buf.subarray(0, Math.min(buf.length, 65536));
  let nul = 0;
  let ctrl = 0;
  for (const b of sample) {
    if (b === 0) nul++;
    else if (b < 9 || (b > 13 && b < 32)) ctrl++;
  }
  if (nul > 0 || ctrl / sample.length > 0.05) return null;
  let text = buf.toString('utf8');
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) text = text.slice(1);
  const bad = (text.match(/�/g) || []).length;
  if (bad > text.length * 0.01) text = buf.toString('latin1'); // fichiers Windows-1252 (Notepad, etc.)
  return text;
}

/** Extraction de chaînes lisibles dans un binaire inconnu (dernier recours). */
function extractStrings(buf, min = 5) {
  const out = [];
  let cur = '';
  for (const b of buf.subarray(0, Math.min(buf.length, 5 * 1024 * 1024))) {
    if ((b >= 32 && b < 127) || b === 9 || b >= 192) cur += String.fromCharCode(b);
    else {
      if (cur.length >= min) out.push(cur);
      cur = '';
    }
  }
  if (cur.length >= min) out.push(cur);
  return out.join('\n');
}

function xmlDecode(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

function htmlToText(html) {
  return xmlDecode(
    String(html)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|tr|h\d)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  ).replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

function truncate(text, max = MAX_TEXT_PER_FILE) {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n\n[… contenu tronqué : ${text.length - max} caractères supplémentaires non inclus …]`;
}

function textPart(text, label, lang = '') {
  return { type: 'text', text: truncate(text), label, lang };
}

// ---------- Formats spécifiques ----------

async function zipMediaImages(zip, prefix, label) {
  const parts = [];
  const files = Object.keys(zip.files).filter((f) => f.startsWith(prefix) && IMAGE_EXT[path.extname(f).toLowerCase()]);
  for (const f of files.slice(0, 40)) {
    const data = await zip.file(f).async('nodebuffer');
    if (data.length < 3000) continue; // icônes / puces
    parts.push({ type: 'image', mime: IMAGE_EXT[path.extname(f).toLowerCase()], base64: data.toString('base64'), label: `${label} — image intégrée ${path.basename(f)}` });
  }
  return parts;
}

async function extractDocx(buf, name) {
  const parts = [];
  const { value } = await mammoth.extractRawText({ buffer: buf });
  if (value.trim()) parts.push(textPart(value, name));
  try {
    const zip = await JSZip.loadAsync(buf);
    parts.push(...(await zipMediaImages(zip, 'word/media/', name)));
  } catch { /* ignore */ }
  return parts;
}

async function extractPptx(buf, name) {
  const zip = await JSZip.loadAsync(buf);
  const slides = Object.keys(zip.files)
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  const texts = [];
  for (const s of slides) {
    const xml = await zip.file(s).async('string');
    const paras = xml.split(/<\/a:p>/).map((p) => (p.match(/<a:t>([^<]*)<\/a:t>/g) || []).map((t) => xmlDecode(t.replace(/<\/?a:t>/g, ''))).join('')).filter(Boolean);
    texts.push(`--- Diapositive ${s.match(/\d+/)[0]} ---\n${paras.join('\n')}`);
  }
  const parts = [];
  if (texts.length) parts.push(textPart(texts.join('\n\n'), name));
  parts.push(...(await zipMediaImages(zip, 'ppt/media/', name)));
  return parts;
}

async function extractOpenDocument(buf, name) {
  const zip = await JSZip.loadAsync(buf);
  const content = zip.file('content.xml');
  const parts = [];
  if (content) {
    const xml = await content.async('string');
    const text = xmlDecode(
      xml
        .replace(/<text:tab\/>/g, '\t')
        .replace(/<text:line-break\/>/g, '\n')
        .replace(/<text:s(?: text:c="(\d+)")?\/>/g, (_, n) => ' '.repeat(Number(n || 1)))
        .replace(/<\/(text:p|text:h|table:table-row)>/g, '\n')
        .replace(/<\/table:table-cell>/g, '\t')
        .replace(/<[^>]+>/g, '')
    );
    if (text.trim()) parts.push(textPart(text, name));
  }
  parts.push(...(await zipMediaImages(zip, 'Pictures/', name)));
  return parts;
}

function extractSpreadsheet(buf, name) {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const sheets = wb.SheetNames.map((sn) => {
    const sh = wb.Sheets[sn];
    const csv = XLSX.utils.sheet_to_csv(sh, { FS: ';', blankrows: false });
    // Formules : utiles pour corriger un TP tableur
    const formulas = [];
    for (const [addr, cell] of Object.entries(sh)) {
      if (addr[0] !== '!' && cell && cell.f) formulas.push(`${addr}: =${cell.f}`);
    }
    return `--- Feuille « ${sn} » ---\n${csv}${formulas.length ? `\n[Formules]\n${formulas.slice(0, 500).join('\n')}` : ''}`;
  });
  return [textPart(sheets.join('\n\n'), name)];
}

function extractNotebook(buf, name) {
  const nb = JSON.parse(buf.toString('utf8'));
  const lang = nb.metadata?.kernelspec?.language || nb.metadata?.language_info?.name || 'python';
  const cells = (nb.cells || []).map((c, i) => {
    const src = Array.isArray(c.source) ? c.source.join('') : String(c.source || '');
    if (c.cell_type === 'markdown') return `[Cellule ${i + 1} — texte]\n${src}`;
    let out = '';
    for (const o of c.outputs || []) {
      if (o.text) out += Array.isArray(o.text) ? o.text.join('') : o.text;
      else if (o.data?.['text/plain']) out += [].concat(o.data['text/plain']).join('');
      else if (o.ename) out += `${o.ename}: ${o.evalue}`;
    }
    return `[Cellule ${i + 1} — code ${lang}]\n\`\`\`${lang}\n${src}\n\`\`\`${out ? `\n[Sortie]\n${out.slice(0, 3000)}` : ''}`;
  });
  return [textPart(cells.join('\n\n'), name, 'markdown')];
}

/** Fichiers draw.io / diagrams.net (très utilisés pour les MCD, UML, schémas réseau). */
function decodeDrawioDiagram(content) {
  const trimmed = content.trim();
  if (trimmed.startsWith('<')) return trimmed;
  try {
    const raw = zlib.inflateRawSync(Buffer.from(trimmed, 'base64')).toString('utf8');
    return decodeURIComponent(raw);
  } catch {
    return '';
  }
}

function extractDrawio(xml, name) {
  const diagrams = [];
  const re = /<diagram([^>]*)>([\s\S]*?)<\/diagram>/g;
  let m;
  while ((m = re.exec(xml))) {
    const title = (m[1].match(/name="([^"]*)"/) || [])[1] || `Page ${diagrams.length + 1}`;
    diagrams.push({ title: xmlDecode(title), model: decodeDrawioDiagram(m[2]) });
  }
  if (!diagrams.length && xml.includes('<mxGraphModel')) diagrams.push({ title: 'Diagramme', model: xml });
  const out = [];
  for (const d of diagrams) {
    const cells = {};
    const cellRe = /<mxCell\b([^>]*?)(\/>|>)/g;
    let c;
    while ((c = cellRe.exec(d.model))) {
      const attrs = {};
      c[1].replace(/(\w+)="([^"]*)"/g, (_, k, v) => { attrs[k] = xmlDecode(v); return ''; });
      if (attrs.id) cells[attrs.id] = attrs;
    }
    // Les objets <object label="..."> encapsulent parfois les cellules
    d.model.replace(/<(?:object|UserObject)\b([^>]*)>\s*<mxCell\b([^>]*)/g, (_, oa, ca) => {
      const label = (oa.match(/label="([^"]*)"/) || [])[1];
      const id = (oa.match(/\bid="([^"]*)"/) || [])[1];
      if (id && label != null) cells[id] = { ...(cells[id] || {}), id, value: xmlDecode(label), ...Object.fromEntries([...ca.matchAll(/(\w+)="([^"]*)"/g)].filter(([, k]) => k !== 'id').map(([, k, v]) => [k, xmlDecode(v)])) };
      return '';
    });
    const label = (cell) => htmlToText(cell?.value || '').replace(/\n/g, ' | ') || `#${cell?.id}`;
    const vertices = Object.values(cells).filter((x) => x.vertex === '1' && x.value);
    const edges = Object.values(cells).filter((x) => x.edge === '1');
    const children = {};
    for (const v of vertices) if (v.parent && cells[v.parent]?.vertex === '1') (children[v.parent] ||= []).push(v);
    const lines = [`### Diagramme « ${d.title} »`, '#### Éléments'];
    for (const v of vertices) {
      if (v.parent && cells[v.parent]?.vertex === '1') continue;
      const kids = (children[v.id] || []).map(label);
      lines.push(`- ${label(v)}${kids.length ? ` : [${kids.join(' ; ')}]` : ''}`);
    }
    if (edges.length) {
      lines.push('#### Liens / associations');
      for (const e of edges) {
        const src = cells[e.source];
        const tgt = cells[e.target];
        const top = (x) => (x && x.parent && cells[x.parent]?.vertex === '1' ? cells[x.parent] : x);
        lines.push(`- ${label(top(src))} → ${label(top(tgt))}${e.value ? ` (libellé : ${htmlToText(e.value)})` : ''}`);
      }
    }
    out.push(lines.join('\n'));
  }
  return out.join('\n\n');
}

function extractRtf(text) {
  return text
    .replace(/\\par[d]?/g, '\n')
    .replace(/\\'([0-9a-f]{2})/gi, (_, h) => Buffer.from([parseInt(h, 16)]).toString('latin1'))
    .replace(/\\u(-?\d+)\??/g, (_, n) => String.fromCharCode(Number(n) < 0 ? Number(n) + 65536 : Number(n)))
    .replace(/\{\\\*[^{}]*\}/g, '')
    .replace(/\\[a-z]+-?\d* ?/gi, '')
    .replace(/[{}]/g, '')
    .trim();
}

// ---------- Dispatcher ----------

async function extractBuffer(name, buf, depth = 0) {
  const ext = path.extname(name).toLowerCase();
  const parts = [];
  const warnings = [];

  try {
    if (ext === '.pdf') {
      parts.push({ type: 'pdf', base64: buf.toString('base64'), label: name });
    } else if (IMAGE_EXT[ext]) {
      parts.push({ type: 'image', mime: IMAGE_EXT[ext], base64: buf.toString('base64'), label: name });
    } else if (UNSUPPORTED_IMAGE_EXT.includes(ext)) {
      warnings.push(`${name} : format d'image ${ext} non lisible directement. Convertissez-le en JPG/PNG (ou faites une capture d'écran).`);
    } else if (AUDIO_EXT[ext]) {
      if (buf.length > MAX_AUDIO_SIZE) warnings.push(`${name} : fichier audio/vidéo trop lourd (> 25 Mo) pour la transcription.`);
      else parts.push({ type: 'audio', mime: AUDIO_EXT[ext], base64: buf.toString('base64'), label: name, filename: path.basename(name) });
    } else if (['.docx', '.docm', '.dotx'].includes(ext)) {
      parts.push(...(await extractDocx(buf, name)));
    } else if (['.pptx', '.ppsx', '.pptm'].includes(ext)) {
      parts.push(...(await extractPptx(buf, name)));
    } else if (['.odt', '.odp', '.odg'].includes(ext)) {
      parts.push(...(await extractOpenDocument(buf, name)));
    } else if (SPREADSHEET_EXT.includes(ext)) {
      parts.push(...extractSpreadsheet(buf, name));
    } else if (ext === '.ipynb') {
      parts.push(...extractNotebook(buf, name));
    } else if (['.zip', '.jar', '.war', '.apk', '.mwb', '.sb3'].includes(ext)) {
      if (depth >= MAX_ARCHIVE_DEPTH) {
        warnings.push(`${name} : archive trop imbriquée, ignorée.`);
      } else {
        const zip = await JSZip.loadAsync(buf);
        const entries = Object.values(zip.files).filter((f) => !f.dir && !IGNORED_ENTRIES.test(f.name));
        const tooMany = entries.length > MAX_ARCHIVE_ENTRIES;
        if (tooMany) warnings.push(`${name} : ${entries.length} fichiers, seuls les ${MAX_ARCHIVE_ENTRIES} premiers sont analysés.`);
        const skipBinary = ['.jar', '.war', '.apk'].includes(ext);
        for (const entry of entries.slice(0, MAX_ARCHIVE_ENTRIES)) {
          if (skipBinary && /\.(class|dex|so|png|jpg|gif)$/i.test(entry.name)) continue;
          const inner = await entry.async('nodebuffer');
          const res = await extractBuffer(`${name}/${entry.name}`, inner, depth + 1);
          parts.push(...res.parts);
          warnings.push(...res.warnings);
        }
      }
    } else if (['.rar', '.7z', '.tar', '.gz', '.tgz', '.bz2', '.xz'].includes(ext)) {
      if (['.gz', '.tgz'].includes(ext)) {
        try {
          const unz = zlib.gunzipSync(buf);
          if (ext === '.tgz' || name.toLowerCase().endsWith('.tar.gz')) {
            parts.push(...(await extractTar(unz, name, depth, warnings)));
          } else {
            const res = await extractBuffer(name.slice(0, -3), unz, depth + 1);
            parts.push(...res.parts);
            warnings.push(...res.warnings);
          }
        } catch {
          warnings.push(`${name} : archive illisible.`);
        }
      } else if (ext === '.tar') {
        parts.push(...(await extractTar(buf, name, depth, warnings)));
      } else {
        warnings.push(`${name} : format d'archive ${ext} non pris en charge, utilisez .zip.`);
      }
    } else if (['.drawio', '.dio'].includes(ext) || (ext === '.xml' && buf.includes('<mxfile'))) {
      const xml = buf.toString('utf8');
      const desc = extractDrawio(xml, name);
      parts.push(textPart(desc || xml, name, 'markdown'));
    } else if (ext === '.svg' && buf.includes('<mxfile')) {
      const content = xmlDecode((buf.toString('utf8').match(/content="([^"]*)"/) || [])[1] || '');
      parts.push(textPart(extractDrawio(content, name) || buf.toString('utf8'), name, 'markdown'));
    } else if (ext === '.rtf') {
      parts.push(textPart(extractRtf(buf.toString('latin1')), name));
    } else if (ext === '.doc') {
      const s = extractStrings(buf, 4);
      parts.push(textPart(s, name));
      warnings.push(`${name} : ancien format Word (.doc), extraction approximative. Préférez .docx ou PDF.`);
    } else {
      const text = decodeText(buf);
      if (text !== null) {
        parts.push(textPart(text, name, langFor(name)));
      } else {
        const s = extractStrings(buf);
        if (s.trim().length > 50) {
          parts.push(textPart(s, name));
          warnings.push(`${name} : format binaire inconnu, seules les chaînes lisibles ont été extraites.`);
        } else {
          warnings.push(`${name} : format binaire non reconnu, ignoré.`);
        }
      }
    }
  } catch (err) {
    warnings.push(`${name} : erreur de lecture (${err.message}).`);
    const text = decodeText(buf);
    if (text) parts.push(textPart(text, name, langFor(name)));
  }
  return { parts, warnings };
}

async function extractTar(buf, name, depth, warnings) {
  const parts = [];
  let off = 0;
  let count = 0;
  while (off + 512 <= buf.length && count < MAX_ARCHIVE_ENTRIES) {
    const header = buf.subarray(off, off + 512);
    const fname = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    if (!fname) break;
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim() || '0', 8);
    const type = String.fromCharCode(header[156]);
    const full = prefix ? `${prefix}/${fname}` : fname;
    off += 512;
    if ((type === '0' || type === '\0') && !IGNORED_ENTRIES.test(full)) {
      const res = await extractBuffer(`${name}/${full}`, buf.subarray(off, off + size), depth + 1);
      parts.push(...res.parts);
      warnings.push(...res.warnings);
      count++;
    }
    off += Math.ceil(size / 512) * 512;
  }
  return parts;
}

async function extractFile(filePath) {
  const name = path.basename(filePath);
  const stat = await fs.promises.stat(filePath);
  if (stat.isDirectory()) return extractDirectory(filePath);
  if (stat.size > MAX_FILE_SIZE) return { name, parts: [], warnings: [`${name} : fichier trop volumineux (${Math.round(stat.size / 1e6)} Mo).`] };
  const buf = await fs.promises.readFile(filePath);
  const res = await extractBuffer(name, buf);
  return { name, size: stat.size, ...res };
}

/** Un dossier entier (projet de code, TP…) peut être glissé dans l'application. */
async function extractDirectory(dirPath) {
  const root = path.basename(dirPath);
  const parts = [];
  const warnings = [];
  let count = 0;
  async function walk(dir) {
    for (const ent of await fs.promises.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      const rel = path.relative(path.dirname(dirPath), full).split(path.sep).join('/');
      if (IGNORED_ENTRIES.test(rel + (ent.isDirectory() ? '/' : '')) || ent.name.startsWith('.')) continue;
      if (ent.isDirectory()) await walk(full);
      else if (count < MAX_ARCHIVE_ENTRIES) {
        count++;
        const stat = await fs.promises.stat(full);
        if (stat.size > MAX_FILE_SIZE) continue;
        const res = await extractBuffer(rel, await fs.promises.readFile(full));
        parts.push(...res.parts);
        warnings.push(...res.warnings);
      }
    }
  }
  await walk(dirPath);
  if (count >= MAX_ARCHIVE_ENTRIES) warnings.push(`${root} : dossier volumineux, seuls ${MAX_ARCHIVE_ENTRIES} fichiers analysés.`);
  return { name: root + '/', parts, warnings };
}

module.exports = { extractFile, extractBuffer, decodeText, extractDrawio, langFor, htmlToText };
