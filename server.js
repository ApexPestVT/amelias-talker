// My Turn: tiny static server for Railway. No dependencies.
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
// The tablet app (iPad and Android wrapper) serves its pages from these addresses and calls this server from there.
const APP_ORIGINS = ['https://localhost', 'capacitor://localhost'];
function sameSite(req) {
  const origin = req.headers.origin;
  if (origin && APP_ORIGINS.includes(origin)) return true;
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
  'Work in two steps. Step 1: write one short line per thing you picked, saying where it sits (for example "dog: left side, a bit below the middle"). Keep each line under 12 words.',
  'Step 2: call place_words with the list, for example {"words":[{"label":"dog","x_percent":25,"y_percent":61}]}. You must call place_words.'
].join('\n');
let selftests = [];
// What the AI service charges, in dollars per million tokens (Claude Haiku 5.5 list price read Nov 2026). Change with AI_PRICE_IN / AI_PRICE_OUT.
const AI_PRICE_IN = Number(process.env.AI_PRICE_IN) || 0.10, AI_PRICE_OUT = Number(process.env.AI_PRICE_OUT) || 0.50;
function aiCost(usage) {
  const i = (usage && usage.input_tokens) || 0, o = (usage && usage.output_tokens) || 0;
  return { tokensIn: i, tokensOut: o, usd: +((i * AI_PRICE_IN + o * AI_PRICE_OUT) / 1e6).toFixed(6) };
}
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
async function sceneWords(image, w, h, model) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(image || ''));
  if (!m) throw new Error('not a photo');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': VISION_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: model || VISION_MODEL, max_tokens: 2000,
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
      tool_choice: { type: 'auto' },   // lets it look and describe before placing; forcing the form straight away gave worse positions
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } },
        { type: 'text', text: SCENE_PROMPT + (w && h ? '\nFor reference, the photo is ' + w + ' pixels wide and ' + h + ' pixels tall.' : '') }
      ] }]
    })
  });
  if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error('AI service ' + r.status + ' ' + t.slice(0, 140)); }
  const d = await r.json();
  const blocks = d.content || [];
  const forms = blocks.filter(b => b.type === 'tool_use' && b.input);
  const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('');
  // Gather every item from every form call, whatever the list is called and however it was wrapped.
  const items = [];
  const take = v => {
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { return; } }
    if (Array.isArray(v)) v.forEach(o => { if (o && typeof o === 'object') items.push(o); });
    else if (v && typeof v === 'object') { if (v.label || v.word || v.name) items.push(v); else Object.keys(v).forEach(k => take(v[k])); }
  };
  forms.forEach(f => take(f.input));
  if (!items.length) {                           // older reply style: look for a JSON list in the text
    const a = text.indexOf('{'), z = text.lastIndexOf('}');
    if (a >= 0 && z > a) { try { take(JSON.parse(text.slice(a, z + 1))); } catch (e) {} }
  }
  const num = v => parseFloat(String(v === undefined || v === null ? '' : v).replace(/[^0-9.+-]/g, ''));   // "85%" -> 85
  const pick = (o, names) => { for (const n of names) if (o[n] !== undefined) return o[n]; return (o.position && o.position[names[names.length - 1]]); };
  const list = items.map(o => ({ label: o.label || o.word || o.name, x: num(pick(o, ['x_percent', 'xPercent', 'x'])), y: num(pick(o, ['y_percent', 'yPercent', 'y'])) }));
  // Safety net: if any position is over 100 the model answered in pixels, so convert using the photo size.
  const pixels = w && h && list.some(o => o.x > 100 || o.y > 100);
  const clamp = v => Math.max(5, Math.min(95, Math.round(v)));
  const seen = new Set();
  const words = list.map(o => ({
    label: String(o.label || '').toLowerCase().replace(/[^a-z0-9' -]/g, '').trim().slice(0, 24),
    x: clamp(pixels ? o.x / w * 100 : o.x), y: clamp(pixels ? o.y / h * 100 : o.y)
  })).filter(o => o.label && Number.isFinite(o.x) && Number.isFinite(o.y) && !seen.has(o.label) && seen.add(o.label)).slice(0, 8);
  // Keep a short record of the last reply (never the photo) so a bad result can be diagnosed.
  lastVision = {
    at: new Date().toISOString(), model: model || VISION_MODEL, photo: (w || '?') + 'x' + (h || '?'), stop: d.stop_reason || '?',
    blocks: blocks.map(b => b.type).join(',') || 'none', itemsSeen: items.length, wordsKept: words.length, treatedAsPixels: !!pixels,
    said: text.slice(0, 400), form: JSON.stringify(forms.map(f => f.input)).slice(0, 900)
  };
  words.cost = aiCost(d.usage);
  if (!words.length) throw new Error('AI answered without usable words (stop: ' + lastVision.stop + '; blocks: ' + lastVision.blocks + '; items: ' + items.length + ')');
  return words;
}
let lastVision = null;

// ---- Harder questions: ask Claude what was asked and which answers fit. Only the heard words are sent, never sound. ----
const ASK_URL = process.env.ANTHROPIC_ENDPOINT || 'https://api.anthropic.com';   // override is for local tests only
const ASK_LEVELS = {
  1: 'a beginner with about 20 picture words (think of a toddler). If yes or no can answer it, use yes/no. Otherwise give 2 or 3 choices, each ONE very common word. Sentences of 3 to 5 words.',
  2: 'a young child who uses word pages and short sentences. Give 2 to 4 choices of one or two simple words. Sentences of 3 to 7 words.',
  3: 'a teenager or adult. Give 2 to 6 choices that can be short phrases. Use ordinary grown-up wording, never baby talk. Sentences up to 10 words.'
};
function askPrompt(level, words) {
  return [
    'A person who cannot speak uses a talking tablet. Someone nearby just said something to them. Decide whether it is a question for them, and if so offer answers they can tap.',
    'The person is ' + ASK_LEVELS[level],
    'Rules:',
    '- If it is not a question to them, or you are not sure what is being asked, use kind "none" with no options. Offering nothing is better than offering a wrong answer.',
    '- If yes or no answers it, use kind "yesno" with exactly two options labelled "yes" and "no".',
    '- Otherwise use kind "choices". Take the choices from the question itself when it names them ("the red one or the blue one" gives "red" and "blue").',
    '- For open questions with no named choices, offer the most ordinary answers a person that age would give. Include one honest negative or unsure answer when it fits ("bad", "not sure").',
    '- Each option has a short label and a full first-person sentence the tablet will say. The sentence must only say what the label means. Add no facts, names, reasons or feelings that were not asked about.',
    '- Every option needs a picture: one single standard emoji that shows what the label means (soccer gets the soccer ball, not sure gets the thinking or shrugging face). Never a flag, never text.',
    '- When the question asks for a favorite or a pick from a well-known group (sports, animals, seasons, school subjects and the like), use every choice you are allowed, with the most common answers for a person in the United States first. For sports that includes football.',
    '- Never answer with the word that was asked about: "restaurant" is not an answer to "what is your favorite restaurant".',
    '- When the true answer would be a particular business or place you cannot know (a restaurant, a store, a park), first offer any matching names from their board words. Then fill the remaining choices with kinds a person that age would say (for restaurants: "pizza place", "burger place", "tacos", "chicken place", "ice cream shop"). Never invent or use a brand name that is not on their board.',
    '- Never use the name of a real person. No slang. Nothing rude, scary, medical or grown-up for a young child.',
    words && words.length ? '- Words already on their board (prefer these as labels when they fit): ' + words.join(', ') + '.' : '',
    'Reply only by calling offer_answers.'
  ].filter(Boolean).join('\n');
}
const askHits = new Map();
function askAllowed(ip) {
  const now = Date.now(), mine = (askHits.get(ip) || []).filter(t => now - t < 3600e3);
  if (mine.length >= 240) return false;
  mine.push(now); askHits.set(ip, mine); return true;
}
// One picture only: must be a real emoji, short, and not a flag. Anything else is dropped and the button shows the word alone.
function askEmoji(v) {
  const e = String(v || '').trim();
  if (!e || e.length > 14 || [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(e)].length !== 1 || /[\p{L}\p{N}<>&"']/u.test(e) || /\p{Regional_Indicator}/u.test(e) || !/\p{Extended_Pictographic}/u.test(e)) return '';
  return e;
}
const askCache = new Map();       // same question at the same level: answer once
let lastAsk = null;
async function askHelp(heard, stage, words) {
  const text = String(heard || '').replace(/[^\p{L}\p{N} ,.?!'’-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (text.length < 4) return { kind: 'none', options: [] };
  const level = stage >= 5 ? 3 : (stage >= 3 ? 2 : 1), max = level === 3 ? 6 : (level === 2 ? 4 : 3);
  const board = (Array.isArray(words) ? words : []).map(w => String(w).toLowerCase().replace(/[^a-z0-9' -]/g, '').trim().slice(0, 24)).filter(Boolean).slice(0, 160);
  const key = level + '|' + text.toLowerCase();
  if (askCache.has(key)) return Object.assign({}, askCache.get(key), { cost: { tokensIn: 0, tokensOut: 0, usd: 0, reused: true } });   // already answered once: no new charge
  const r = await fetch(ASK_URL + '/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': VISION_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: VISION_MODEL, max_tokens: 500,
      tools: [{ name: 'offer_answers', description: 'Offer answers the person can tap, or none.',
        input_schema: { type: 'object', required: ['kind', 'options'], properties: {
          kind: { type: 'string', enum: ['yesno', 'choices', 'none'] },
          options: { type: 'array', items: { type: 'object', required: ['label', 'emoji', 'sentence'], properties: {
            emoji: { type: 'string', description: 'exactly one standard emoji picture for this label' },
            label: { type: 'string', description: 'what is shown on the button, lowercase, 1 to 3 words' },
            sentence: { type: 'string', description: 'the full first-person sentence the tablet says' } } } } } } }],
      tool_choice: { type: 'tool', name: 'offer_answers' },
      messages: [{ role: 'user', content: askPrompt(level, board) + '\n\nWhat was said: "' + text + '"' }]
    })
  });
  if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error('AI service ' + r.status + ' ' + t.slice(0, 140)); }
  const d = await r.json();
  const form = (d.content || []).filter(b => b.type === 'tool_use' && b.input)[0];
  const inp = (form && form.input) || {};
  let kind = ['yesno', 'choices', 'none'].includes(inp.kind) ? inp.kind : 'none';
  const seen = new Set();
  let options = (Array.isArray(inp.options) ? inp.options : []).map(o => ({
    label: String((o && o.label) || '').toLowerCase().replace(/[^a-z0-9' -]/g, '').trim().slice(0, 28),
    sentence: String((o && o.sentence) || '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 90),
    emoji: askEmoji(o && o.emoji)
  })).filter(o => o.label && o.sentence && !seen.has(o.label) && seen.add(o.label));
  // The asked-about word is not an answer ("restaurant" to "favorite restaurant"), unless the speaker offered it as a choice ("X or Y").
  const asked = ' ' + text.toLowerCase().replace(/[^a-z0-9' ]/g, ' ').replace(/\s+/g, ' ') + ' ';
  if (kind === 'choices' && !/ or /.test(asked)) options = options.filter(o => !asked.includes(' ' + o.label + ' ') && !asked.includes(' ' + o.label + 's '));
  if (kind === 'yesno') {
    const y = options.find(o => o.label === 'yes'), n = options.find(o => o.label === 'no');
    if (y && n) options = [y, n]; else kind = 'none';
  } else if (kind === 'choices') { options = options.slice(0, max); if (options.length < 2) kind = 'none'; }
  if (kind === 'none') options = [];
  const out = { kind, options, level, cost: aiCost(d.usage) };
  lastAsk = { at: new Date().toISOString(), level, kind, options: options.length, stop: d.stop_reason || '?' };   // never the words heard
  if (askCache.size < 500) askCache.set(key, out);
  return out;
}

// ---- Child voices (Amazon Polly). Keys stay here. Tablets save each clip, so a word is paid for once. ----
const crypto = require('crypto');
const AWS_ID = process.env.AWS_ACCESS_KEY_ID, AWS_SECRET = process.env.AWS_SECRET_ACCESS_KEY;
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const POLLY_HOST = 'polly.' + AWS_REGION + '.amazonaws.com';
const POLLY_URL = process.env.POLLY_ENDPOINT || ('https://' + POLLY_HOST);      // override is for local tests only
const POLLY_VOICES = [{ id: 'Ivy', label: 'Girl (Ivy)' }, { id: 'Kevin', label: 'Boy (Kevin)' }, { id: 'Justin', label: 'Boy (Justin)' }];
// ---- Child voice from Microsoft Azure Speech ("Ana"). The Free (F0) resource cannot be billed; it only slows or refuses when its monthly allowance is used. ----
const AZ_KEY = process.env.AZURE_SPEECH_KEY, AZ_REGION = process.env.AZURE_SPEECH_REGION || 'eastus';
const AZ_URL = process.env.AZURE_SPEECH_ENDPOINT || ('https://' + AZ_REGION + '.tts.speech.microsoft.com');   // override is for local tests only
const AZ_PACE = process.env.AZURE_PACE_MS === undefined ? 3200 : Math.max(0, +process.env.AZURE_PACE_MS || 0);   // the free resource allows about 20 requests a minute
const AZ_PAID = process.env.AZURE_PAID === '1';                                                                // set when the Speech resource is a paid one, so the cost tracker counts it
const AZ_VOICES = [{ id: 'Ana', label: 'Girl (Ana)', az: 'en-US-AnaNeural' },
  { id: 'AnaBoyA', label: 'Boy test A (Ana, a little lower)', az: 'en-US-AnaNeural', pitch: '-6%', noSave: true },
  { id: 'AnaBoyB', label: 'Boy test B (Ana, lower)', az: 'en-US-AnaNeural', pitch: '-12%', noSave: true },
  { id: 'AnaBoyC', label: 'Boy test C (Ana, lowest)', az: 'en-US-AnaNeural', pitch: '-20%', noSave: true }];
const VOICES = (AZ_KEY ? AZ_VOICES : []).concat(AWS_ID && AWS_SECRET ? POLLY_VOICES : []);
const VOICE_ON = VOICES.length > 0;
const xml = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
function azureSsml(text, v) {
  const inner = v.pitch ? "<prosody pitch='" + v.pitch + "'>" + xml(text) + '</prosody>' : xml(text);
  return "<speak version='1.0' xml:lang='en-US'><voice name='" + v.az + "'>" + inner + '</voice></speak>';
}
async function azureOnce(text, v) {
  const r = await fetch(AZ_URL + '/cognitiveservices/v1', { method: 'POST', body: azureSsml(text, v),
    headers: { 'Ocp-Apim-Subscription-Key': AZ_KEY, 'Content-Type': 'application/ssml+xml', 'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3', 'User-Agent': 'my-turn-talker' } });
  if (!r.ok) { const t = await r.text().catch(() => ''); const e = new Error('voice service ' + r.status + ' ' + t.replace(/\s+/g, ' ').slice(0, 140).trim()); e.status = r.status; throw e; }
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 100) throw new Error('voice service sent no sound');
  return buf;
}
// One request at a time. Words being saved for later are spaced out to stay under the free limit; a word a child is waiting to hear goes first and does not wait for a slot.
const azQueue = []; let azBusy = false, azTimer = null, azLast = 0, azHold = 0, azStats = { sent: 0, waited: 0, refused: 0, longest: 0, longestLive: 0 };
let azMonth = { month: '', chars: 0 };
const AZ_MONTH_SAVE = +process.env.AZURE_MONTH_SAVE || 450000, AZ_MONTH_ALL = +process.env.AZURE_MONTH_ALL || 495000;   // characters; the free allowance is 500,000 a month. Counted since the server last restarted.
function azureSay(text, v, warm) {
  return new Promise((resolve, reject) => {
    const m = new Date().toISOString().slice(0, 7); if (azMonth.month !== m) azMonth = { month: m, chars: 0 };
    if (!AZ_PAID && azMonth.chars + text.length > (warm ? AZ_MONTH_SAVE : AZ_MONTH_ALL)) return reject(Object.assign(new Error("this month's free voice allowance is used up; saving starts again next month"), { code: 429 }));
    azMonth.chars += text.length;
    const job = { text, v, resolve, reject, at: Date.now(), tries: 0, warm: !!warm };
    if (warm) azQueue.push(job); else { let i = 0; while (i < azQueue.length && !azQueue[i].warm) i++; azQueue.splice(i, 0, job); }
    if (azQueue.length > 400) { const drop = azQueue.pop(); drop.reject(Object.assign(new Error('voice is busy, try again soon'), { code: 429 })); }
    if (!warm && azTimer) { clearTimeout(azTimer); azTimer = null; azBusy = false; }      // do not make her wait behind a saving slot
    azurePump();
  });
}
function azurePump() {
  if (azBusy || !azQueue.length) return;
  azBusy = true;
  const now = Date.now(), first = azQueue[0];
  const wait = Math.max(0, azHold - now, first.warm ? azLast + AZ_PACE - now : 0);
  azTimer = setTimeout(() => {
    azTimer = null;
    const job = azQueue.shift(); if (job.warm) azLast = Date.now(); job.tries++;
    azureOnce(job.text, job.v).then(buf => { const took = Date.now() - job.at; azStats.sent++; azStats.longest = Math.max(azStats.longest, took); if (!job.warm) azStats.longestLive = Math.max(azStats.longestLive, took); job.resolve(buf); },
      e => { if (e.status === 429 && job.tries < 3) { azStats.waited++; azQueue.unshift(job); azHold = Date.now() + 4000; } else { if (e.status === 429) azStats.refused++; job.reject(e); } })
      .then(() => { azBusy = false; azurePump(); });
  }, wait);
}
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d, 'utf8').digest();
const sha = d => crypto.createHash('sha256').update(d, 'utf8').digest('hex');
// AWS Signature Version 4 for one JSON POST.
function signPolly(body, now, id, secret, region, host) {
  const amz = now.toISOString().replace(/[:-]|\.\d{3}/g, ''), day = amz.slice(0, 8);
  const scope = day + '/' + region + '/polly/aws4_request';
  const canon = ['POST', '/v1/speech', '', 'content-type:application/json', 'host:' + host, 'x-amz-date:' + amz, '', 'content-type;host;x-amz-date', sha(body)].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', amz, scope, sha(canon)].join('\n');
  const key = hmac(hmac(hmac(hmac('AWS4' + secret, day), region), 'polly'), 'aws4_request');
  return { 'content-type': 'application/json', 'x-amz-date': amz,
    authorization: 'AWS4-HMAC-SHA256 Credential=' + id + '/' + scope + ', SignedHeaders=content-type;host;x-amz-date, Signature=' + hmac(key, toSign).toString('hex') };
}
const clips = new Map();          // "Voice|text" -> mp3, shared by every tablet until the server restarts
// Kept for good: with VOICE_DIR set (a Railway volume), every clip is also written to disk, so a word is asked of the voice service once, ever, for all tablets.
const VOICE_DIR = process.env.VOICE_DIR || (process.env.RAILWAY_VOLUME_MOUNT_PATH ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'voice') : '');
const VOICE_DIR_MAX = (+process.env.VOICE_DIR_MAX_MB || 1500) * 1024 * 1024;
let kept = { ok: false, files: 0, bytes: 0, hits: 0, error: '' };
const clipFile = (voice, text) => path.join(VOICE_DIR, voice.replace(/\W/g, ''), crypto.createHash('sha1').update(text, 'utf8').digest('hex') + '.mp3');
if (VOICE_DIR) {
  try {
    fs.mkdirSync(VOICE_DIR, { recursive: true });
    for (const d of fs.readdirSync(VOICE_DIR, { withFileTypes: true })) { if (!d.isDirectory()) continue;
      for (const f of fs.readdirSync(path.join(VOICE_DIR, d.name))) { if (!f.endsWith('.mp3')) continue; kept.files++; kept.bytes += fs.statSync(path.join(VOICE_DIR, d.name, f)).size; } }
    kept.ok = true;
  } catch (e) { kept.error = String(e.message).slice(0, 120); console.error('voice folder not usable:', e.message); }
}
async function keptRead(voice, text) {
  if (!kept.ok) return null;
  try { const b = await fs.promises.readFile(clipFile(voice, text)); if (b.length < 100) return null; kept.hits++; return b; } catch (e) { return null; }
}
async function keptWrite(voice, text, buf) {
  if (!kept.ok || kept.bytes + buf.length > VOICE_DIR_MAX) return;
  const f = clipFile(voice, text);
  try { await fs.promises.mkdir(path.dirname(f), { recursive: true }); await fs.promises.writeFile(f + '.part', buf); await fs.promises.rename(f + '.part', f); kept.files++; kept.bytes += buf.length; }
  catch (e) { kept.error = String(e.message).slice(0, 120); }
}
let clipBytes = 0, lastVoice = null;
const voiceUse = new Map();       // ip -> [[time, characters]]
let voiceDay = { day: '', chars: 0 };
const VOICE_IP_HOUR = 90000, VOICE_ALL_DAY = 600000;   // characters. 600,000 is about $10 a day at the very worst
function voiceBudget(ip, n) {
  const now = Date.now(), today = new Date().toISOString().slice(0, 10);
  if (voiceDay.day !== today) voiceDay = { day: today, chars: 0 };
  const mine = (voiceUse.get(ip) || []).filter(e => now - e[0] < 3600e3);
  if (mine.reduce((a, e) => a + e[1], 0) + n > VOICE_IP_HOUR || voiceDay.chars + n > VOICE_ALL_DAY) return false;
  mine.push([now, n]); voiceUse.set(ip, mine); voiceDay.chars += n; return true;
}
async function pollySay(text, voice) {
  const body = JSON.stringify({ Engine: 'neural', OutputFormat: 'mp3', Text: text, TextType: 'text', VoiceId: voice });
  const r = await fetch(POLLY_URL + '/v1/speech', { method: 'POST', headers: signPolly(body, new Date(), AWS_ID, AWS_SECRET, AWS_REGION, POLLY_HOST), body });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    let why = t.slice(0, 160); try { const j = JSON.parse(t); why = (r.headers.get('x-amzn-errortype') || '').split(':')[0] + ' ' + (j.message || j.Message || ''); } catch (e) {}
    throw new Error('voice service ' + r.status + ' ' + why.trim());
  }
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 100) throw new Error('voice service sent no sound');
  return buf;
}
function cleanSay(t) { return String(t || '').replace(/[^\p{L}\p{N} .,!?'’-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 160); }
async function voiceClip(text, voice, ip, warm) {
  const k = voice + '|' + text;
  if (clips.has(k)) return { buf: clips.get(k), paid: 0 };
  const onDisk = await keptRead(voice, text);
  if (onDisk) { if (clipBytes < 60 * 1024 * 1024) { clips.set(k, onDisk); clipBytes += onDisk.length; } return { buf: onDisk, paid: 0 }; }
  if (!voiceBudget(ip, text.length)) { const e = new Error('voice limit reached for now, try again in an hour'); e.code = 429; throw e; }
  const v = VOICES.find(x => x.id === voice);
  const buf = v.az ? await azureSay(text, v, warm) : await pollySay(text, voice);
  if (clipBytes < 60 * 1024 * 1024) { clips.set(k, buf); clipBytes += buf.length; }
  keptWrite(voice, text, buf);
  return { buf, paid: (v.az && !AZ_PAID) ? 0 : text.length };
}

http.createServer((req, res) => {
  if (req.headers.origin && APP_ORIGINS.includes(req.headers.origin) && String(req.url).startsWith('/api/')) {   // let the tablet app call the API
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin); res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type'); res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  }
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/api/stt/status') return json(res, 200, { enabled: !!STT_KEY, provider: STT_PROVIDER === 'deepgram' ? 'deepgram' : 'assemblyai ' + STT_MODEL });
  if (p === '/api/vision/status') return json(res, 200, { enabled: !!VISION_KEY });
  if (p === '/api/vision/last') return json(res, 200, lastVision || { note: 'no photo suggestion has run since the server last restarted' });
  if (p === '/api/vision/selftest') {          // sends a tiny built-in drawing (no user photo) so a failure can be read from outside
    if (!VISION_KEY) return json(res, 200, { ok: false, error: 'no AI key set' });
    const now = Date.now(); selftests = selftests.filter(t => now - t < 3600e3);
    if (selftests.length >= 24) return json(res, 429, { ok: false, error: 'self-test limit reached, try again in an hour' });
    selftests.push(now);
    const tm = /model=sonnet/.test(req.url || '') ? 'claude-sonnet-5-5' : VISION_MODEL;
    return sceneWords(SELFTEST_IMG, 256, 192, tm).then(words => json(res, 200, { ok: true, model: tm, expected: 'ball near x31 y52, box near x74 y52', words }), e => json(res, 200, { ok: false, model: tm, error: e.message }));
  }
  if (p === '/api/ask/status') return json(res, 200, { enabled: !!VISION_KEY });
  if (p === '/api/ask/last') return json(res, 200, lastAsk || { note: 'no question has been sent to the AI since the server last restarted' });
  if (p === '/api/ask/selftest') {             // fixed sample questions (nothing from a user) so the live answers can be read from outside
    if (!VISION_KEY) return json(res, 200, { ok: false, error: 'no AI key set' });
    const now = Date.now(); selftests = selftests.filter(t => now - t < 3600e3);
    if (selftests.length >= 24) return json(res, 429, { ok: false, error: 'self-test limit reached, try again in an hour' });
    selftests.push(now);
    const samples = ['how was school today', 'is your tummy hurting', 'which one do you like better the red one or the blue one', 'what color do you want', 'it is raining outside'];
    const u = new URL(req.url, 'http://x'), st = Math.max(1, Math.min(6, +u.searchParams.get('stage') || 2));
    return Promise.all(samples.map(q => askHelp(q, st, ['yes', 'no', 'more', 'want', 'play', 'eat', 'drink', 'help', 'hurt', 'happy', 'sad', 'tired', 'good', 'bad']).then(a => ({ q, kind: a.kind, options: a.options, cost: a.cost }), e => ({ q, error: e.message }))))
      .then(out => json(res, 200, { ok: out.every(o => !o.error), stage: st, model: VISION_MODEL, priceInPerMillion: AI_PRICE_IN, priceOutPerMillion: AI_PRICE_OUT, totalUsd: +out.reduce((a, o) => a + ((o.cost && o.cost.usd) || 0), 0).toFixed(6), results: out }));
  }
  if (p === '/api/ask') {
    if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
    if (!VISION_KEY) return json(res, 503, { error: 'no AI key set' });
    if (!sameSite(req)) return json(res, 403, { error: 'wrong site' });
    const ip4 = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    if (!askAllowed(ip4)) return json(res, 429, { error: 'too many questions this hour' });
    return readBody(req, 8192).then(b => { const q = JSON.parse(b); return askHelp(q.heard, +q.stage || 1, q.words); })
      .then(a => json(res, 200, a), e => { console.error('ask failed:', e.message); json(res, 502, { error: e.message }); });
  }
  if (p === '/api/voice/status') return json(res, 200, { enabled: VOICE_ON, region: AZ_KEY ? AZ_REGION : AWS_REGION, voices: VOICES.map(v => ({ id: v.id, label: v.label, noSave: v.noSave || undefined })), month: AZ_KEY ? azMonth : undefined, kept: { on: kept.ok, clips: kept.files, megabytes: Math.round(kept.bytes / 104857.6) / 10, servedFromDisk: kept.hits, error: kept.error || undefined }, slow: !!AZ_KEY && AZ_PACE > 0, free: !!AZ_KEY && !AZ_PAID, queue: azQueue.length, azure: AZ_KEY ? azStats : undefined });
  if (p === '/api/voice/last') return json(res, 200, lastVoice || { note: 'no child-voice request has run since the server last restarted' });
  if (p === '/api/voice/selftest') {           // says one short word so a key or region problem can be read from outside
    if (!VOICE_ON) return json(res, 200, { ok: false, error: 'no voice keys set' });
    const now = Date.now(); selftests = selftests.filter(t => now - t < 3600e3);
    if (selftests.length >= 24) return json(res, 429, { ok: false, error: 'self-test limit reached, try again in an hour' });
    selftests.push(now);
    return Promise.all(VOICES.map(v => (v.az ? azureSay('hi', v, false) : pollySay('hi', v.id)).then(b => v.id + ': ok, ' + b.length + ' bytes of sound', e => v.id + ': FAILED, ' + e.message)))
      .then(out => json(res, 200, { ok: out.every(o => / ok,/.test(o)), region: AZ_KEY ? AZ_REGION : AWS_REGION, results: out }));
  }
  if (p === '/api/voice/say') {
    if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
    if (!VOICE_ON) return json(res, 503, { error: 'no voice keys set' });
    if (!sameSite(req)) return json(res, 403, { error: 'wrong site' });
    const ip3 = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    return readBody(req, 4096).then(b => {
      const q = JSON.parse(b), text = cleanSay(q.text), voice = String(q.voice || '');
      if (!text || !VOICES.some(v => v.id === voice)) { const e = new Error('nothing to say or unknown voice'); e.code = 400; throw e; }
      return voiceClip(text, voice, ip3, !!q.warm);
    }).then(c => {
      lastVoice = { at: new Date().toISOString(), ok: true, bytes: c.buf.length, paidCharacters: c.paid };
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store', 'X-Paid-Characters': String(c.paid) }); res.end(c.buf);
    }, e => { lastVoice = { at: new Date().toISOString(), ok: false, error: e.message }; console.error('voice failed:', e.message); json(res, e.code || 502, { error: e.message }); });
  }
  if (p === '/api/scene-words') {
    if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
    if (!VISION_KEY) return json(res, 503, { error: 'no AI key set' });
    if (!sameSite(req)) return json(res, 403, { error: 'wrong site' });
    const ip2 = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    if (!visionAllowed(ip2)) return json(res, 429, { error: 'too many photo suggestions this hour, try again later' });
    return readBody(req, 4 * 1024 * 1024).then(b => { const q = JSON.parse(b); return sceneWords(q.image, Number(q.w) || 0, Number(q.h) || 0); })
      .then(words => json(res, 200, { words, cost: words.cost }), e => { console.error('scene words failed:', e.message); json(res, 502, { error: e.message }); });
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
}).listen(PORT, () => console.log('My Turn listening on ' + PORT));

if (process.env.TALKER_TEST) module.exports = { signPolly, azureSsml };
