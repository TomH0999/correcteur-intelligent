'use strict';
const { TYPE_LABELS } = require('./corrector');

const STATUT = { correct: '✅ Correct', partiel: '🟠 Partiel', incorrect: '❌ Incorrect', non_traite: '⬜ Non traité' };
const fr = (n) => String(Math.round(n * 100) / 100).replace('.', ',');
const cell = (s) => String(s || '').replace(/\|/g, '\\|').replace(/\n+/g, ' ');

/** Rapport complet au format Markdown (export, partage, impression). */
function toMarkdown(rec) {
  const r = rec.result;
  const L = [];
  L.push(`# ${r.titre}`);
  L.push('');
  L.push(`**Nom :** ${rec.name}  `);
  L.push(`**Matière :** ${r.matiere || '—'} · **Type :** ${TYPE_LABELS[r.type_exercice] || r.type_exercice}${r.langage ? ` · **Langage/outil :** ${r.langage}` : ''}  `);
  L.push(`**Date :** ${new Date(rec.created_at || Date.now()).toLocaleString('fr-FR')} · **Modèle :** ${rec.model || '—'}`);
  L.push('');
  L.push(`## Note : ${fr(r.note.obtenue)} / ${r.note.sur} (${fr(r.score_pourcentage)} %)`);
  if (r.appreciation) L.push(`> ${r.appreciation}`);
  L.push('');
  if (r.resume) L.push(r.resume, '');
  if (r.points_forts.length) {
    L.push('### Points forts');
    r.points_forts.forEach((p) => L.push(`- ${p}`));
    L.push('');
  }
  L.push('## Identification des documents');
  L.push(`- **Énoncé :** ${r.identification.enonce.join(', ') || (r.identification.enonce_present ? '—' : 'absent (déduit des réponses)')}`);
  L.push(`- **Réponses :** ${r.identification.reponses.join(', ') || '—'}`);
  if (r.identification.remarques) L.push(`- ${r.identification.remarques}`);
  L.push('');
  if (r.questions.length) {
    L.push('## Détail par question');
    L.push('| N° | Question | Statut | Points | Commentaire |');
    L.push('|---|---|---|---|---|');
    r.questions.forEach((q) => L.push(`| ${cell(q.numero)} | ${cell(q.intitule)} | ${STATUT[q.statut]} | ${fr(q.points_obtenus)}/${fr(q.points_max)} | ${cell(q.commentaire)} |`));
    L.push('');
  }
  L.push('## Rapport de fautes');
  if (!r.fautes.length) L.push('Aucune faute relevée. 🎉');
  r.fautes.forEach((f, i) => {
    L.push(`### ${i + 1}. [${f.gravite}] ${f.categorie}${f.question ? ` — question ${f.question}` : ''}`);
    L.push(f.description);
    if (f.extrait) L.push('', `*Ta réponse :*`, '', '```', f.extrait, '```');
    if (f.correction) L.push('', `*Correction :* ${f.correction}`);
    L.push('');
  });
  L.push('## Améliorations possibles');
  r.ameliorations.forEach((a) => L.push(`- **${a.titre}** — ${a.detail}`));
  L.push('');
  L.push('## À revoir');
  r.a_revoir.forEach((a) => L.push(`- **${a.notion}** (priorité ${a.priorite}) — ${a.pourquoi}${a.ressources ? `  \n  📚 ${a.ressources}` : ''}`));
  L.push('');
  if (r.correction_modele) {
    L.push('## Correction modèle');
    L.push(r.correction_modele);
    L.push('');
  }
  if (r.mots_cles.length) L.push(`*Mots-clés : ${r.mots_cles.join(', ')}*`);
  return L.join('\n');
}

module.exports = { toMarkdown };
