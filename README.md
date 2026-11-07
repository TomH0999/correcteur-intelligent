# ✓ Correcteur Intelligent

Application Windows de **correction automatique d'exercices par IA**, pensée pour le **BUT Informatique** :
maths manuscrites, code (tous langages), bases de données (MCD/MLD, SQL), réseaux, systèmes, UML, etc.

Tu importes l'énoncé **et** tes réponses — en un ou plusieurs fichiers, dans n'importe quel format —
et l'application :

1. **convertit tout en texte** lisible par l'IA (OCR/vision pour les manuscrits et schémas, transcription audio…) ;
2. **détermine elle-même** ce qui est l'énoncé et ce qui est ta copie ;
3. renvoie une **note** (sur 20 par défaut) et un **score de réussite**, un **rapport de fautes**, des **améliorations possibles**,
   les **notions à revoir** et une **correction modèle** (avec rendu LaTeX et coloration du code) ;
4. **enregistre automatiquement** chaque correction dans l'**historique** (base SQLite locale) avec un nom précis et
   recherchable, par ex. `[BDD] — R1.05 Bases de données — TD3 jointures — 14,5/20 — 2026-11-07 18h42` ;
5. te permet de **classer** les corrections dans des **dossiers / sous-dossiers** (par semestre, ressource…).

## 📥 Installation

1. Va dans l'onglet **[Releases](https://github.com/TomH0999/correcteur-intelligent/releases)** du dépôt
   (ou dans **Actions → Build Windows → Artifacts**).
2. Télécharge `Correcteur-Intelligent-Setup-x.y.z.exe` et lance-le.
   *SmartScreen* peut avertir que l'application n'est pas signée : **Informations complémentaires → Exécuter quand même**.
3. Crée une clé API **gratuite** sur <https://console.groq.com/keys>, puis colle-la dans **Paramètres** de l'application
   (elle est chiffrée sur ton PC avec le coffre-fort Windows).

## 📄 Formats acceptés

| Catégorie | Formats | Traitement |
|---|---|---|
| PDF | `.pdf` (texte **ou** scanné/manuscrit) | texte extrait + pages scannées, manuscrites ou avec figures rendues en image puis lues par l'IA de vision |
| Images | `.jpg .png .webp .gif .bmp .avif` + **Ctrl+V** d'une capture | lues par un modèle de vision : texte, formules → LaTeX, code, MCD/UML/schémas réseau décrits de façon structurée |
| Bureautique | `.docx .pptx .xlsx .xls .odt .ods .odp .rtf .csv` (+ images intégrées) | texte, tableaux, formules de tableur, images des documents |
| Code | `.py .java .c .cpp .cs .js .ts .php .sql .html .css .sh .kt .go .rs …` et **tout fichier texte** | conservé tel quel avec le langage détecté |
| Notebooks | `.ipynb` | cellules + sorties |
| Diagrammes | `.drawio .dio` (draw.io / diagrams.net), `.puml`, `.mmd` | entités, attributs, associations et cardinalités extraites |
| Archives / dossiers | `.zip .tar .tar.gz` ou un **dossier entier** (projet) | parcourus récursivement (ignore `node_modules`, `.git`, `__MACOSX`…) |
| Audio / vidéo | `.mp3 .wav .m4a .ogg .webm .mp4` (≤ 25 Mo) | transcription Whisper (oral, consignes dictées) |

Chaque fichier peut être laissé en **🤖 Auto** (l'IA décide) ou forcé en **📋 Énoncé** / **✍ Mes réponses**.

## 🧠 IA utilisée (Groq)

| Étape | Modèle par défaut | Rôle |
|---|---|---|
| Vision | `meta-llama/llama-4-scout-17b-16e-instruct` | transcription des images / pages scannées |
| Audio | `whisper-large-v3` | transcription |
| Correction | `openai/gpt-oss-120b` | identification énoncé/réponses + correction en JSON |
| Secours | `llama-3.3-70b-versatile`, `llama-4-scout` | utilisés automatiquement si le modèle principal est indisponible ou si la requête dépasse les limites de l'offre gratuite |

Tous les modèles, le niveau (BUT 1/2/3…), la sévérité, le barème et la stratégie d'analyse des PDF sont réglables dans **Paramètres**.

## 🛠 Développement

```bash
npm install
npm start          # lance l'application
npm test           # tests (extraction, base de données, pipeline IA simulé)
npm run dist:win   # construit l'installateur .exe (sous Windows)
```

L'installateur Windows est construit automatiquement par **GitHub Actions** (`.github/workflows/build-windows.yml`)
à chaque push, et publié dans les Releases.

Architecture :

```
src/main/        processus principal Electron
  extractors.js  conversion universelle fichier → texte / images / audio
  groq.js        client API Groq (reprises automatiques, limites de débit)
  corrector.js   prompts, transcription vision/audio, correction, normalisation de la note
  db.js          base SQLite (sql.js) : dossiers + corrections + recherche
  report.js      export Markdown
src/renderer/    interface (HTML/CSS/JS, pdf.js, KaTeX, marked)
```

Les données (base `corrections.sqlite`, paramètres) sont stockées dans `%APPDATA%\Correcteur Intelligent`.
