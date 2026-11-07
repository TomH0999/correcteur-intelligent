const test = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const JSZip = require('jszip');
const XLSX = require('xlsx');
const { extractBuffer, decodeText, extractDrawio } = require('../src/main/extractors');

test('fichier de code -> texte avec langage', async () => {
  const r = await extractBuffer('tp1.py', Buffer.from('def f(x):\n    return x*2\n'));
  assert.equal(r.parts[0].type, 'text');
  assert.equal(r.parts[0].lang, 'python');
});

test('texte Latin-1 (Windows) décodé', () => {
  assert.equal(decodeText(Buffer.from('réponse', 'latin1')), 'réponse');
});

test('binaire inconnu ignoré proprement', async () => {
  const r = await extractBuffer('x.bin', Buffer.from([0, 1, 2, 3, 0, 0, 5]));
  assert.equal(r.parts.length, 0);
  assert.ok(r.warnings.length);
});

test('image -> partie image', async () => {
  const r = await extractBuffer('copie.JPG', Buffer.from([0xff, 0xd8, 0xff]));
  assert.equal(r.parts[0].type, 'image');
  assert.equal(r.parts[0].mime, 'image/jpeg');
});

test('archive zip récursive (ignore __MACOSX)', async () => {
  const zip = new JSZip();
  zip.file('projet/Main.java', 'class Main {}');
  zip.file('projet/schema.sql', 'CREATE TABLE t (id INT PRIMARY KEY);');
  zip.file('__MACOSX/._Main.java', 'xx');
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  const r = await extractBuffer('rendu.zip', buf);
  assert.deepEqual(r.parts.map((p) => p.lang).sort(), ['java', 'sql']);
});

test('tableur xlsx avec formules', async () => {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([['a', 'b'], [1, 2]]);
  ws.C2 = { t: 'n', f: 'A2+B2', v: 3 };
  ws['!ref'] = 'A1:C2';
  XLSX.utils.book_append_sheet(wb, ws, 'Feuil1');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const r = await extractBuffer('tp.xlsx', buf);
  assert.match(r.parts[0].text, /Feuil1/);
  assert.match(r.parts[0].text, /C2: =A2\+B2/);
});

test('notebook Jupyter', async () => {
  const nb = { cells: [{ cell_type: 'markdown', source: ['# Ex 1'] }, { cell_type: 'code', source: ['print(1)'], outputs: [{ text: ['1\n'] }] }], metadata: {} };
  const r = await extractBuffer('tp.ipynb', Buffer.from(JSON.stringify(nb)));
  assert.match(r.parts[0].text, /print\(1\)/);
  assert.match(r.parts[0].text, /\[Sortie\]/);
});

test('draw.io compressé (MCD) -> description structurée', () => {
  const model = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
    '<mxCell id="2" value="CLIENT" vertex="1" parent="1"/><mxCell id="3" value="id_client" vertex="1" parent="2"/>' +
    '<mxCell id="4" value="COMMANDE" vertex="1" parent="1"/>' +
    '<mxCell id="5" value="passe (0,n)" edge="1" source="2" target="4" parent="1"/></root></mxGraphModel>';
  const compressed = zlib.deflateRawSync(Buffer.from(encodeURIComponent(model))).toString('base64');
  const xml = `<mxfile><diagram name="MCD">${compressed}</diagram></mxfile>`;
  const out = extractDrawio(xml, 'mcd.drawio');
  assert.match(out, /CLIENT : \[id_client\]/);
  assert.match(out, /CLIENT → COMMANDE \(libellé : passe \(0,n\)\)/);
});

test('docx via mammoth', async () => {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Exercice 1 : calculer la dérivée</w:t></w:r></w:p></w:body></w:document>');
  const r = await extractBuffer('sujet.docx', await zip.generateAsync({ type: 'nodebuffer' }));
  assert.match(r.parts[0].text, /Exercice 1/);
});
