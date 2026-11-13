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
// AssemblyAI model: 'universal-streaming-english' (default, $0.15/hr) or 'whisper-rt' (Whisper streaming, about $0.30/hr).
const STT_MODELS = ['universal-streaming-english', 'universal-streaming-multilingual', 'whisper-rt'];
const STT_MODEL = STT_MODELS.includes(process.env.STT_MODEL) ? process.env.STT_MODEL : STT_MODELS[0];
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
    url: 'wss://streaming.assemblyai.com/v3/ws?sample_rate=16000&encoding=pcm_s16le&speech_model=' + STT_MODEL + '&token=' + encodeURIComponent(d.token) };
}

// ---- Photo scenes: ask Claude which things in a photo a young child would want to talk about ----
const VISION_KEY = process.env.ANTHROPIC_API_KEY;
const VISION_MODEL = process.env.VISION_MODEL || 'claude-haiku-5-5';
const SCENE_PROMPT = [
  'This photo will become a talking picture for a young child who cannot speak. She touches a spot and her tablet says the word.',
  'Pick up to 8 things in the photo she would most want to talk about: people, animals, food, drinks, toys, favourite objects, places to go.',
  'Rules:',
  '- One simple everyday word each, lowercase, the word a parent would say to a toddler ("dog", "swing", "cup").',
  '- Never name or identify a person. For people use a role word only: "girl", "boy", "baby", "woman", "man".',
  '- No brand names. Skip tiny background clutter. No duplicates.',
  '- x and y are the centre of the thing as a percent of the photo width and height (0 to 100, origin top left).',
  'Reply with JSON only, no other text: {"words":[{"label":"dog","x":42,"y":61}]}'
].join('\n');
function readBody(req, max) {
  return new Promise((resolve, reject) => {
    let n = 0; const parts = [];
    req.on('data', c => { n += c.length; if (n > max) { reject(new Error('photo too large')); req.destroy(); } else parts.push(c); });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}
async function sceneWords(image) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(image || ''));
  if (!m) throw new Error('not a photo');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': VISION_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: VISION_MODEL, max_tokens: 600,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } },
        { type: 'text', text: SCENE_PROMPT }
      ] }]
    })
  });
  if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error('AI service ' + r.status + ' ' + t.slice(0, 140)); }
  const d = await r.json();
  const text = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const a = text.indexOf('{'), z = text.lastIndexOf('}');
  if (a < 0 || z <= a) throw new Error('AI gave no word list');
  const out = JSON.parse(text.slice(a, z + 1));
  const seen = new Set();
  const clamp = v => Math.max(5, Math.min(95, Math.round(Number(v))));
  return (Array.isArray(out.words) ? out.words : []).map(w => ({
    label: String(w.label || '').toLowerCase().replace(/[^a-z0-9' -]/g, '').trim().slice(0, 24), x: clamp(w.x), y: clamp(w.y)
  })).filter(w => w.label && Number.isFinite(w.x) && Number.isFinite(w.y) && !seen.has(w.label) && seen.add(w.label)).slice(0, 8);
}

http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/api/stt/status') return json(res, 200, { enabled: !!STT_KEY, provider: STT_PROVIDER === 'deepgram' ? 'deepgram' : 'assemblyai ' + STT_MODEL });
  if (p === '/api/vision/status') return json(res, 200, { enabled: !!VISION_KEY });
  if (p === '/api/scene-words') {
    if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
    if (!VISION_KEY) return json(res, 503, { error: 'no AI key set' });
    if (!sameSite(req)) return json(res, 403, { error: 'wrong site' });
    const ip2 = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    if (!allowed(ip2)) return json(res, 429, { error: 'too many requests' });
    return readBody(req, 4 * 1024 * 1024).then(b => sceneWords(JSON.parse(b).image))
      .then(words => json(res, 200, { words }), e => { console.error('scene words failed:', e.message); json(res, 502, { error: e.message }); });
  }
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
