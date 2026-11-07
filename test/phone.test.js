const test = require('node:test');
const assert = require('node:assert');
const phone = require('../src/main/phone');

test('serveur téléphone : jeton obligatoire, réception d\'une photo', async (t) => {
  if (!phone.lanAddresses().length) return t.skip('pas de réseau local');
  const received = [];
  const info = await phone.start((f) => received.push(f));
  assert.match(info.qr, /^data:image\/png;base64,/);
  const url = new URL(info.url);
  const base = `http://127.0.0.1:${url.port}`;
  const bad = await fetch(`${base}/?t=mauvais`);
  assert.equal(bad.status, 403);
  const page = await fetch(`${base}/?${url.searchParams}`);
  assert.match(await page.text(), /Envoyer des photos/);
  const up = await fetch(`${base}/upload?${url.searchParams}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'p.jpg', mime: 'image/jpeg', data: 'AAAA' }) });
  assert.equal(up.status, 200);
  assert.equal(received[0].name, 'p.jpg');
  const refused = await fetch(`${base}/upload?${url.searchParams}`, { method: 'POST', body: JSON.stringify({ name: 'x.exe', mime: 'application/x-msdownload', data: 'AA' }) });
  assert.equal(refused.status, 400);
  phone.stop();
});
