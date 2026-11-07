// Rendu Markdown sécurisé + formules LaTeX (KaTeX).
/* global marked, DOMPurify, renderMathInElement */

marked.setOptions({ gfm: true, breaks: true });

const MATH_RE = /(\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|(?<![\\$\w])\$(?!\s)[^$\n]+?(?<!\s)\$(?!\w))/g;

/** Protège les formules mathématiques pour que Markdown ne les abîme pas (_ * \ …). */
function protectMath(src) {
  const store = [];
  // On ne touche pas au code
  const codeStore = [];
  let s = src.replace(/```[\s\S]*?```|`[^`\n]+`/g, (m) => {
    codeStore.push(m);
    return `\u0000C${codeStore.length - 1}\u0000`;
  });
  s = s.replace(MATH_RE, (m) => {
    store.push(m);
    return `\u0000M${store.length - 1}\u0000`;
  });
  s = s.replace(/\u0000C(\d+)\u0000/g, (_, i) => codeStore[Number(i)]);
  return { s, store };
}

const escapeHtml = (t) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export function mdToHtml(src, { inline = false } = {}) {
  if (!src) return '';
  const { s, store } = protectMath(String(src));
  let html = inline ? marked.parseInline(s) : marked.parse(s);
  html = html.replace(/\u0000M(\d+)\u0000/g, (_, i) => escapeHtml(store[Number(i)]));
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}

export function renderMath(el) {
  try {
    renderMathInElement(el, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '\\[', right: '\\]', display: true },
        { left: '\\(', right: '\\)', display: false },
        { left: '$', right: '$', display: false }
      ],
      throwOnError: false,
      ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code']
    });
  } catch (e) {
    console.warn('KaTeX', e);
  }
}

/** Remplit un élément avec du Markdown rendu (maths comprises). */
export function setMd(el, src, opts) {
  el.innerHTML = mdToHtml(src, opts);
  renderMath(el);
  el.querySelectorAll('a[href]').forEach((a) => a.setAttribute('target', '_blank'));
}
