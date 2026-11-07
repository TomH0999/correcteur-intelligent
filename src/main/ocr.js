'use strict';
/** OCR local (Tesseract, hors ligne) : secours quand aucun modèle de vision n'est disponible. */
const path = require('path');
const os = require('os');

let workerPromise = null;

function dataDir(lang) {
  const pkg = path.dirname(require.resolve(`@tesseract.js-data/${lang}/package.json`)).replace('app.asar', 'app.asar.unpacked');
  return path.join(pkg, '4.0.0_best_int');
}

async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const Tesseract = require('tesseract.js');
      // Les deux langues sont dans des dossiers distincts : on charge le français, puis l'anglais (code, termes techniques)
      const worker = await Tesseract.createWorker(['fra'], 1, {
        langPath: dataDir('fra'),
        cachePath: path.join(os.tmpdir(), 'correcteur-ocr-cache'),
        gzip: true
      });
      return worker;
    })().catch((err) => {
      workerPromise = null;
      throw err;
    });
  }
  return workerPromise;
}

async function ocrImage(base64) {
  const worker = await getWorker();
  const { data } = await worker.recognize(Buffer.from(base64, 'base64'));
  return `[Texte lu par OCR local — vérifie les formules et l'écriture manuscrite, qui peuvent être mal reconnues]\n${data.text.trim()}`;
}

async function shutdown() {
  if (workerPromise) {
    try { (await workerPromise).terminate(); } catch { /* ignore */ }
    workerPromise = null;
  }
}

module.exports = { ocrImage, shutdown };
