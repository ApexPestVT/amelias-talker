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
  '- Positions are percentages, never pixels: x_percent is 0 at the left edge and 100 at the right edge; y_percent is 0 at the top and 100 at the bottom.',
  'Answer by calling place_words with the list, for example {"words":[{"label":"dog","x_percent":42,"y_percent":61}]}.'
].join('\n');
let selftests = [];
const visionHits = new Map();   // ip -> [timestamps], separate from the listening allowance
function visionAllowed(ip) {
  const now = Date.now(), mine = (visionHits.get(ip) || []).filter(t => now - t < 3600e3);
  if (mine.length >= 40) return false;
  mine.push(now); visionHits.set(ip, mine); return true;
}
const SELFTEST_IMG = 'data:image/jpeg;base64,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';
function readBody(req, max) {
  return new Promise((resolve, reject) => {
    let n = 0; const parts = [];
    req.on('data', c => { n += c.length; if (n > max) { reject(new Error('photo too large')); req.destroy(); } else parts.push(c); });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}
async function sceneWords(image, w, h) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(image || ''));
  if (!m) throw new Error('not a photo');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': VISION_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: VISION_MODEL, max_tokens: 1024,
      // Make the model answer through a form, so the word list always comes back in a shape the app can read.
      tools: [{
        name: 'place_words',
        description: 'Place the words on the photo.',
        input_schema: { type: 'object', required: ['words'], properties: { words: { type: 'array', items: {
          type: 'object', required: ['label', 'x_percent', 'y_percent'],
          properties: {
            label: { type: 'string', description: 'one simple lowercase word' },
            x_percent: { type: 'number', minimum: 0, maximum: 100, description: 'centre of the thing, as a percent of the photo WIDTH from the left edge. Not pixels.' },
            y_percent: { type: 'number', minimum: 0, maximum: 100, description: 'centre of the thing, as a percent of the photo HEIGHT from the top edge. Not pixels.' }
          } } } } }
      }],
      tool_choice: { type: 'tool', name: 'place_words' },
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } },
        { type: 'text', text: SCENE_PROMPT + (w && h ? '\nFor reference, the photo is ' + w + ' pixels wide and ' + h + ' pixels tall.' : '') }
      ] }]
    })
  });
  if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error('AI service ' + r.status + ' ' + t.slice(0, 140)); }
  const d = await r.json();
  const blocks = d.content || [];
  const form = blocks.find(b => b.type === 'tool_use' && b.input);
  const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('');
  let out = form ? form.input : null;
  if (!out) {                                   // older reply style: look for a JSON list in the text
    const a = text.indexOf('{'), z = text.lastIndexOf('}');
    if (a >= 0 && z > a) { try { out = JSON.parse(text.slice(a, z + 1)); } catch (e) { out = null; } }
  }
  if (!out) throw new Error('AI gave no word list (stop: ' + (d.stop_reason || '?') + '; blocks: ' + (blocks.map(b => b.type).join(',') || 'none') + '; said: ' + (text.slice(0, 160) || 'nothing') + ')');
  if (typeof out.words === 'string') { try { out.words = JSON.parse(out.words); } catch (e) {} }
  const seen = new Set();
  const clamp = v => Math.max(5, Math.min(95, Math.round(Number(v))));
  const list = (Array.isArray(out.words) ? out.words : []).map(o => ({ label: o.label, x: Number(o.x_percent !== undefined ? o.x_percent : o.x), y: Number(o.y_percent !== undefined ? o.y_percent : o.y) }));
  // Safety net: if any position is over 100 the model answered in pixels, so convert using the photo size.
  const pixels = w && h && list.some(o => o.x > 100 || o.y > 100);
  return list.map(o => ({
    label: String(o.label || '').toLowerCase().replace(/[^a-z0-9' -]/g, '').trim().slice(0, 24),
    x: clamp(pixels ? o.x / w * 100 : o.x), y: clamp(pixels ? o.y / h * 100 : o.y)
  })).filter(w => w.label && Number.isFinite(w.x) && Number.isFinite(w.y) && !seen.has(w.label) && seen.add(w.label)).slice(0, 8);
}

http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/api/stt/status') return json(res, 200, { enabled: !!STT_KEY, provider: STT_PROVIDER === 'deepgram' ? 'deepgram' : 'assemblyai ' + STT_MODEL });
  if (p === '/api/vision/status') return json(res, 200, { enabled: !!VISION_KEY });
  if (p === '/api/vision/selftest') {          // sends a tiny built-in drawing (no user photo) so a failure can be read from outside
    if (!VISION_KEY) return json(res, 200, { ok: false, error: 'no AI key set' });
    const now = Date.now(); selftests = selftests.filter(t => now - t < 3600e3);
    if (selftests.length >= 8) return json(res, 429, { ok: false, error: 'self-test limit reached, try again in an hour' });
    selftests.push(now);
    return sceneWords(SELFTEST_IMG, 256, 192).then(words => json(res, 200, { ok: true, model: VISION_MODEL, words }), e => json(res, 200, { ok: false, model: VISION_MODEL, error: e.message }));
  }
  if (p === '/api/scene-words') {
    if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
    if (!VISION_KEY) return json(res, 503, { error: 'no AI key set' });
    if (!sameSite(req)) return json(res, 403, { error: 'wrong site' });
    const ip2 = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    if (!visionAllowed(ip2)) return json(res, 429, { error: 'too many photo suggestions this hour, try again later' });
    return readBody(req, 4 * 1024 * 1024).then(b => { const q = JSON.parse(b); return sceneWords(q.image, Number(q.w) || 0, Number(q.h) || 0); })
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
