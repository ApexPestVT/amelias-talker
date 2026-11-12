// Amelia's Talker: tiny static server for Railway. No dependencies.
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, 'public');
const PORT = process.env.PORT || 3000;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png'
};

// ---- Speech service (cloud listening). The key stays here; tablets only get a short-lived token. ----
const STT_PROVIDER = (process.env.STT_PROVIDER || 'assemblyai').toLowerCase();
const STT_KEY = STT_PROVIDER === 'deepgram' ? process.env.DEEPGRAM_API_KEY : process.env.ASSEMBLYAI_API_KEY;
const hits = new Map();           // ip -> [timestamps]
const PER_IP_PER_HOUR = 90, ALL_PER_HOUR = 900;
function allowed(ip) {
  const now = Date.now(), hour = 3600e3;
  let total = 0;
  for (const [k, v] of hits) { const keep = v.filter(t => now - t < hour); if (keep.length) { hits.set(k, keep); total += keep.length; } else hits.delete(k); }
  const mine = hits.get(ip) || [];
  if (mine.length >= PER_IP_PER_HOUR || total >= ALL_PER_HOUR) return false;
  mine.push(now); hits.set(ip, mine); return true;
}
function sameSite(req) {
  const origin = req.headers.origin;
  if (origin) { try { return new URL(origin).host === req.headers.host; } catch (e) { return false; } }
  return req.headers['sec-fetch-site'] === 'same-origin';
}
function json(res, code, body) { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); }
async function sttToken() {
  if (STT_PROVIDER === 'deepgram') {
    const r = await fetch('https://api.deepgram.com/v1/auth/grant', {
      method: 'POST', headers: { Authorization: 'Token ' + STT_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ ttl_seconds: 60 })
    });
    if (!r.ok) throw new Error('deepgram ' + r.status);
    const d = await r.json();
    return { provider: 'deepgram', protocols: ['bearer', d.access_token],
      url: 'wss://api.deepgram.com/v1/listen?model=nova-3&language=en&encoding=linear16&sample_rate=16000&channels=1&interim_results=true&punctuate=true' };
  }
  const r = await fetch('https://streaming.assemblyai.com/v3/token?expires_in_seconds=60', { headers: { Authorization: STT_KEY } });
  if (!r.ok) throw new Error('assemblyai ' + r.status);
  const d = await r.json();
  return { provider: 'assemblyai',
    url: 'wss://streaming.assemblyai.com/v3/ws?sample_rate=16000&encoding=pcm_s16le&speech_model=universal-streaming-english&token=' + encodeURIComponent(d.token) };
}

http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/api/stt/status') return json(res, 200, { enabled: !!STT_KEY, provider: STT_PROVIDER });
  if (p === '/api/stt/token') {
    if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
    if (!STT_KEY) return json(res, 503, { error: 'no speech key set' });
    if (!sameSite(req)) return json(res, 403, { error: 'wrong site' });
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    if (!allowed(ip)) return json(res, 429, { error: 'too many requests' });
    return sttToken().then(t => json(res, 200, t), e => { console.error('stt token failed:', e.message); json(res, 502, { error: 'speech service refused: ' + e.message }); });
  }
  if (p === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"ok":true}'); }
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'Permissions-Policy': 'microphone=(self), camera=(self)'
    });
    res.end(data);
  });
}).listen(PORT, () => console.log('Amelia\'s Talker listening on ' + PORT));
