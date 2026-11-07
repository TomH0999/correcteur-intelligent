# ✓ Correcteur Intelligent

Application Windows de **correction automatique d'exercices par IA**, pensée pour le **BUT Informatique** :
maths manuscrites, code (tous langages), bases de données (MCD/MLD, SQL), réseaux, systèmes, UML, etc.
Le style reprend celui du [Gestionnaire de notes](https://github.com/TomH0999/gestionnaire_de_notes).

Tu importes l'énoncé, tes réponses (et éventuellement le barème du prof) — en un ou plusieurs fichiers,
dans n'importe quel format — et l'application :

1. **convertit tout en texte** lisible par l'IA : lecture des manuscrits et schémas par un modèle de vision
   (testé automatiquement), OCR local de secours, transcription audio… ;
2. **détermine elle-même** ce qui est l'énoncé, ta copie et le barème ;
3. **exécute réellement ton code** (Python, JavaScript, SQL intégrés ; Java, C, C++, PHP si installés) avec des tests
   préparés par l'IA ;
4. renvoie une **note** et un **score**, le **détail par question**, un **rapport de fautes**, des **améliorations**,
   les **notions à revoir** et une **correction modèle** (LaTeX et code mis en forme) ;
5. **enregistre** chaque correction dans l'historique (base SQLite locale) avec un nom précis et recherchable,
   par ex. `[BDD] — R1.05 Bases de données — TD3 jointures — 14,5/20 — 2026-11-07 18h42`, et te laisse la classer
   dans des **dossiers / sous-dossiers**.

## ✨ Fonctionnalités

| | |
|---|---|
| 🤖 **Plusieurs IA au choix** | Groq (gratuit), Google Gemini (gratuit), Anthropic Claude, OpenAI, ou **Ollama hors ligne**. Les modèles sont lus en direct sur ton compte : plus jamais de « modèle invalide ». |
| 🔄 **Mises à jour automatiques** | Téléchargées depuis les Releases GitHub et installées à la fermeture. |
| 🔒 **Données locales** | Une base propre à chaque installation, dans `%APPDATA%\Correcteur Intelligent`. Clés API chiffrées (coffre-fort Windows). |
| 📈 **Progression** | Courbe des scores par matière, notions qui reviennent dans tes fautes, types d'erreurs. |
| 🧠 **Fiches de révision** | Créées automatiquement à partir de tes erreurs, révisées en répétition espacée (boîtes de Leitner). |
| 🏋️ **Exercices d'entraînement** | Générés sur tes points faibles ; réponds dans l'app (avec bouton « Tester mon code »), puis fais corriger. |
| ⚖️ **Comparaison** | Deux corrections côte à côte : erreurs corrigées, persistantes, nouvelles ; écart question par question. |
| 📏 **Barème du prof** | Importe une grille ou un corrigé officiel : l'IA l'applique strictement. |
| 📱 **Photo depuis le téléphone** | Scanne un QR code : les photos de ta copie arrivent directement dans l'app (même Wi-Fi). |
| 💾 **Sauvegarde & synchro** | Export/import sans doublon ; synchronisation facultative entre tes PC via un dossier OneDrive / Google Drive / Dropbox. |
| 📄 **Export** | Rapport en Markdown ou PDF. |
| 💬 **Discuter avec l'IA** | Pose des questions sur chaque correction : le tuteur connaît ta copie, la correction et les tests. |
| 📋 **File d'attente / lots** | Corrige plusieurs copies à la suite en arrière-plan (une copie par fichier avec le même énoncé) ; reprise automatique après fermeture, notification à la fin. |
| 🖍️ **Copie annotée** | Les fautes sont surlignées directement sur ta copie : par le texte pour les PDF, par l'IA de vision pour les photos/scans, dans le texte pour le code. |
| 🧩 **Gros devoirs** | Si les documents dépassent les limites du modèle (sortie max, jetons par minute de l'offre gratuite), la correction est automatiquement découpée : lecture document par document, correction par lots de questions, synthèse finale. |
| 🛟 **Données protégées** | Conservées lors des mises à jour, sauvegarde automatique quotidienne et avant chaque mise à jour / réinitialisation, bouton de réinitialisation avec confirmation. |

## 📥 Installation

1. Va dans les **[Releases](https://github.com/TomH0999/correcteur-intelligent/releases)** du dépôt.
2. Télécharge `Correcteur-Intelligent-Setup-x.y.z.exe` et lance-le.
   *SmartScreen* peut avertir que l'application n'est pas signée : **Informations complémentaires → Exécuter quand même**.
3. Au premier lancement, ouvre **Réglages** et colle une clé API — la plus simple : **Groq**, gratuite, sur
   <https://console.groq.com/keys>.

Les mises à jour suivantes s'installent ensuite toutes seules (à partir de la version 1.1).

## 📄 Formats acceptés

| Catégorie | Formats | Traitement |
|---|---|---|
| PDF | `.pdf` (texte **ou** scanné/manuscrit) | texte extrait + pages scannées, manuscrites ou avec figures lues par l'IA de vision |
| Images | `.jpg .png .webp .gif .bmp .avif`, **Ctrl+V** d'une capture, **photo du téléphone** | vision : texte, formules → LaTeX, code, MCD/UML/schémas réseau décrits de façon structurée ; OCR local en secours |
| Bureautique | `.docx .pptx .xlsx .xls .odt .ods .odp .rtf .csv` (+ images intégrées) | texte, tableaux, formules de tableur, images |
| Code | `.py .java .c .cpp .cs .js .ts .php .sql .html .css .sh .kt .go .rs …` et **tout fichier texte** | conservé tel quel, exécuté si possible |
| Notebooks | `.ipynb` | cellules + sorties |
| Diagrammes | `.drawio .dio` (draw.io), `.puml`, `.mmd` | entités, attributs, associations et cardinalités extraites |
| Archives / dossiers | `.zip .tar .tar.gz` ou un **dossier entier** | parcourus récursivement (ignore `node_modules`, `.git`, `__MACOSX`…) |
| Audio / vidéo | `.mp3 .wav .m4a .ogg .webm .mp4` (≤ 25 Mo) | transcription Whisper (Groq ou OpenAI) |

## 🛠 Développement

```bash
npm install
npm start          # lance l'application (données séparées : « Correcteur Intelligent (dev) »)
npm test           # tests : extraction, base de données, sauvegarde/fusion, modèles IA, exécution de code, serveur téléphone
npm run dist:win   # construit l'installateur .exe (sous Windows)
```

À chaque push, **GitHub Actions** (`.github/workflows/build-windows.yml`) lance les tests, construit l'installateur,
lui attribue la version `1.2.<numéro de build>` et publie une Release avec `latest.yml` : c'est ce fichier que les
applications installées consultent pour se mettre à jour.

**Signature de code (facultatif)** : ajoute les secrets `WIN_CSC_LINK` (certificat `.pfx` en base64) et
`WIN_CSC_KEY_PASSWORD` dans *Settings → Secrets and variables → Actions* pour signer l'installateur et supprimer
l'avertissement SmartScreen.

```
src/main/          processus principal Electron
  extractors.js    conversion universelle fichier → texte / images / audio
  providers.js     Groq, OpenAI, Gemini, Ollama (API compatible OpenAI) et Anthropic (SDK officiel)
  models.js        liste des modèles en direct, test des modèles de vision, choix automatique
  corrector.js     prompts, lecture des images, tests d'exécution, correction (un appel ou découpée), tuteur, fiches, exercices
  limits.js        limites des modèles (contexte, sortie max, jetons/minute) apprises en direct + régulateur de débit
  queue.js         file d'attente persistante (reprise après redémarrage)
  pages.js         aperçus des pages de copie pour l'affichage annoté
  runner.js        exécution de code (worker Python/JS/SQL + compilateurs locaux)
  ocr.js           OCR local Tesseract (secours hors ligne)
  db.js            SQLite (sql.js) : dossiers, corrections, fiches, exercices, tableau de bord, fusion
  backup.js        sauvegarde, restauration, synchronisation par dossier cloud
  updater.js       mises à jour automatiques (electron-updater)
  phone.js         serveur local + QR code pour envoyer des photos depuis le téléphone
src/renderer/      interface (HTML/CSS/JS, Inter, Font Awesome, pdf.js, KaTeX, marked)
```
