'use strict';
/**
 * Envoi de photos depuis le téléphone : petit serveur web temporaire sur le réseau local (Wi-Fi),
 * protégé par un jeton aléatoire, accessible en scannant un QR code. Il s'arrête tout seul après 30 min.
 */
const http = require('http');
const os = require('os');
const crypto = require('crypto');
const QRCode = require('qrcode');

const MAX_BODY = 30 * 1024 * 1024;
const LIFETIME = 30 * 60 * 1000;

let server = null;
let token = null;
let stopTimer = null;
let info = null;

function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal && !/^169\.254\./.test(a.address)) out.push({ name, address: a.address });
    }
  }
  // Les réseaux domestiques (192.168.x.x) d'abord, les adaptateurs virtuels (VirtualBox, WSL, VPN) ensuite
  const score = (x) => (/^192\.168\./.test(x.address) ? 0 : /^10\./.test(x.address) ? 1 : 2) + (/virtual|vbox|vmware|wsl|hyper-v|docker|vethernet|tailscale|zerotier/i.test(x.name) ? 5 : 0);
  return out.sort((a, b) => score(a) - score(b));
}

const PAGE = (t) => `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Correcteur Intelligent — Envoi de photos</title>
<style>
  *{box-sizing:border-box} body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#020617;color:#f1f5f9;padding:20px}
  .card{background:#0f172a;border:1px solid #1e293b;border-radius:16px;padding:20px;max-width:480px;margin:0 auto}
  h1{font-size:20px;margin:0 0 6px} p{color:#94a3b8;font-size:14px;line-height:1.5}
  label.btn,button{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;min-height:52px;border-radius:12px;border:0;font-size:16px;font-weight:600;margin-top:12px;cursor:pointer}
  label.btn{background:#2563eb;color:#fff} button{background:#1e293b;color:#e2e8f0;border:1px solid #334155}
  input{display:none} #list{list-style:none;padding:0;margin:16px 0 0} #list li{background:#020617;border:1px solid #1e293b;border-radius:10px;padding:10px 12px;margin-top:8px;font-size:14px;display:flex;justify-content:space-between;gap:8px}
  .ok{color:#34d399} .ko{color:#fb7185}
</style></head><body><div class="card">
<h1>📸 Envoyer des photos</h1>
<p>Photographie ta copie (une page par photo, bien à plat, sans ombre). Les photos apparaissent directement dans le Correcteur Intelligent sur ton PC.</p>
<label class="btn">📷 Prendre une photo<input id="cam" type="file" accept="image/*" capture="environment"></label>
<label class="btn" style="background:#1d4ed8">🖼️ Choisir dans la galerie<input id="gal" type="file" accept="image/*,application/pdf" multiple></label>
<ul id="list"></ul>
</div>
<script>
const T=${JSON.stringify(t)};
const list=document.getElementById('list');
async function shrink(file){
  if(!file.type.startsWith('image/'))return {name:file.name,mime:file.type,data:await b64(file)};
  const bmp=await createImageBitmap(file);const s=Math.min(1,2200/Math.max(bmp.width,bmp.height));
  const c=document.createElement('canvas');c.width=Math.round(bmp.width*s);c.height=Math.round(bmp.height*s);
  c.getContext('2d').drawImage(bmp,0,0,c.width,c.height);
  return {name:(file.name||'photo').replace(/\\.[^.]+$/,'')+'.jpg',mime:'image/jpeg',data:c.toDataURL('image/jpeg',0.88).split(',')[1]};
}
function b64(file){return new Promise(r=>{const fr=new FileReader();fr.onload=()=>r(fr.result.split(',')[1]);fr.readAsDataURL(file);});}
async function send(files){
  for(const f of files){
    const li=document.createElement('li');li.innerHTML='<span></span><span>envoi…</span>';li.firstChild.textContent=f.name||'photo';list.prepend(li);
    try{const p=await shrink(f);const r=await fetch('/upload?t='+T,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(p)});
      if(!r.ok)throw new Error(await r.text());li.lastChild.textContent='✓ reçue';li.lastChild.className='ok';}
    catch(e){li.lastChild.textContent='✗ '+e.message;li.lastChild.className='ko';}
  }
}
for(const id of ['cam','gal'])document.getElementById(id).onchange=e=>{send([...e.target.files]);e.target.value='';};
</script></body></html>`;

/**
 * @param {(file: {name, mime, base64}) => void} onFile
 */
async function start(onFile) {
  if (server) return info;
  token = crypto.randomBytes(16).toString('hex');
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const valid = url.searchParams.get('t') === token;
    if (!valid) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Lien expiré : rescanne le QR code affiché dans l\'application.');
    }
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(PAGE(token));
    }
    if (req.method === 'POST' && url.pathname === '/upload') {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) { res.writeHead(413); res.end('Fichier trop lourd'); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!/^(image\/|application\/pdf)/.test(body.mime || '')) throw new Error('Type non accepté');
          onFile({ name: String(body.name || 'photo.jpg').slice(0, 120), mime: body.mime, base64: String(body.data || '') });
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('ok');
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(err.message);
        }
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', resolve);
  });
  const port = server.address().port;
  const addrs = lanAddresses();
  if (!addrs.length) {
    stop();
    throw new Error('Aucun réseau local détecté : connecte le PC et le téléphone au même Wi-Fi.');
  }
  const urls = addrs.map((a) => `http://${a.address}:${port}/?t=${token}`);
  info = { url: urls[0], urls, qr: await QRCode.toDataURL(urls[0], { margin: 1, width: 280, color: { dark: '#020617', light: '#ffffff' } }), expiresAt: Date.now() + LIFETIME };
  stopTimer = setTimeout(stop, LIFETIME);
  return info;
}

function stop() {
  clearTimeout(stopTimer);
  if (server) server.close();
  server = null;
  token = null;
  info = null;
}

module.exports = { start, stop, lanAddresses };
