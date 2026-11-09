# ✓ Correcteur Intelligent

Application Windows de **correction automatique d'exercices par IA**, pensée pour le **BUT Informatique** :
maths manuscrites, code (tous langages), bases de données (MCD/MLD, SQL), réseaux, systèmes, UML, etc.
Le style reprend celui du [Gestionnaire de notes](https://github.com/TomH0999/gestionnaire_de_notes).

## 🪄 Corriger avec Claude (mode principal)

Tu corriges tes contrôles **directement dans Claude** (claude.ai, avec ton abonnement) ; l'application prépare
le prompt et garde tout dans ta base locale :

1. **Choisis le cas** : contrôle / DS, contrôle blanc, exercice / TD, interro, QCM (points négatifs possibles),
   TP / code, projet / SAÉ, ou corrigé d'un sujet sans copie, puis la **matière** (ressources du BUT, modifiables).
   Chaque matière ajoute ses propres vérifications : requêtes SQL testées sur un jeu de données, calculs refaits,
   code exécuté mentalement sur des cas limites, sous-réseaux recalculés…
2. **« Copier le prompt et ouvrir Claude »** : Claude s'ouvre avec le prompt prérempli (et copié). Joins l'énoncé et
   ta copie (PDF, photos, code…) puis envoie.
3. **Copie la réponse de Claude** et reviens dans l'application : elle est **détectée automatiquement**. Vérifie
   l'aperçu (note, questions, fautes) puis enregistre. Tu peux ajouter le lien de la conversation et joindre tes fichiers.

Ensuite, depuis chaque correction : **réexpliquer mes erreurs**, **exercice similaire**, **questions flash**,
**nouvelle tentative** (la progression entre tentatives est mesurée), **ouvrir la conversation Claude**. La page
Exercices prépare un entraînement ou un contrôle blanc ciblé sur tes notions les plus souvent ratées.

**Peu de jetons, sans perdre en qualité** : Claude répond par un seul bloc JSON compact (commentaires vides quand c'est
juste, solution seulement pour les questions ratées) et l'application se charge de la mise en forme. La note est
recalculée à partir des points de chaque question. Avec le **mode Projet Claude** (Réglages → Claude), les règles sont
collées une seule fois dans les instructions d'un projet : chaque prompt fait alors environ 60 jetons au lieu de 700.

La correction automatique par API (Groq, Gemini, Anthropic, OpenAI, Ollama) reste disponible si tu enregistres une clé.

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
| ⚖️ **Pas de fausses erreurs** | Le code est exécuté sur de vrais moteurs : **PostgreSQL embarqué** avec conversion automatique d'Oracle (MINUS, NVL, DECODE, DUAL, ROWNUM, séquences, PL/SQL, scripts SQL*Plus…), MySQL et SQL Server ; vrai Node.js pour JavaScript/TypeScript ; Python avec bibliothèques. Les erreurs dues à l'outil (dialecte non convertible, saisie clavier non fournie, module absent…) sont signalées « limite de l'outil » et ne coûtent jamais de points. |
| 🔗 **Réponses bien rattachées** | Ta numérotation peut différer de l'énoncé (« Q3 » pour « Exercice 2 – Question 1 », « 3) », « II.1 », réponses sans numéro) : chaque réponse est rattachée à la bonne question. Si des questions restent « non traitées », l'IA les recherche à nouveau dans toute ta copie avant de noter. |
| ⚡ **Correction rapide** | Images lues dès l'import (et mises en cache), tests de code écrits pendant la correction, modèle rapide pour les tâches secondaires, lots en parallèle quand ton offre le permet, note affichée au fur et à mesure, correction modèle rédigée après l'affichage de la note. Réglage **Rapide / Équilibré / Approfondi** et durée de chaque étape affichée. Astuce : l'offre payante de Groq (Dev tier) supprime presque toutes les pauses liées aux jetons par minute. |
| 📝 **Brouillons** | Case « Enregistrer » : décochée, la correction s'affiche mais ne compte ni dans l'historique, ni dans les statistiques, ni dans les fiches (supprimée après 14 jours, enregistrable après coup). |
| 🎯 **Réussite & amélioration** | Les copies d'un même énoncé sont regroupées en tentatives : taux de réussite du premier coup, amélioration de la 1re à la dernière réponse, exercices rattrapés (corrections enregistrées uniquement). |
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
lui attribue la version `1.4.<numéro de build>` et publie une Release avec `latest.yml` : c'est ce fichier que les
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
  runner.js        exécution de code (worker Python/SQL, Node.js pour JS/TS, compilateurs locaux)
  sqlcompat.js     conversion Oracle / MySQL / SQL Server -> PostgreSQL (PGlite), scripts SQL*Plus, PL/SQL
  execclass.js     distingue les erreurs de l'outil des vraies erreurs de l'étudiant
  ocr.js           OCR local Tesseract (secours hors ligne)
  db.js            SQLite (sql.js) : dossiers, corrections, fiches, exercices, tableau de bord, fusion
  backup.js        sauvegarde, restauration, synchronisation par dossier cloud
  updater.js       mises à jour automatiques (electron-updater)
  phone.js         serveur local + QR code pour envoyer des photos depuis le téléphone
src/renderer/      interface (HTML/CSS/JS, Inter, Font Awesome, pdf.js, KaTeX, marked)
```
