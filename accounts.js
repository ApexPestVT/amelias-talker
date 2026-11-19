// My Turn: family accounts. Sign-in by emailed code, a saved setup (with photos) for every device a child uses, and totals for grant reports.
// Kept apart from server.js so it can be tested alone, and so a missing database or mail key switches
// accounts OFF without touching anything else the tablets need (speech, voices, pictures).
//
// Needs, all as Railway variables:
//   DATABASE_URL    a Postgres database (Railway: New > Database > PostgreSQL, then reference its DATABASE_URL here)
//   RESEND_API_KEY  key from resend.com, used only to send the login codes
//   MAIL_FROM       the sender, on a domain verified at Resend, e.g.  My Turn <login@example.org>
//   ADMIN_KEY       a long password you make up; it opens the totals page (/admin.html). Optional.
//   REVIEW_EMAIL, REVIEW_CODE   optional: one address with a fixed 6-number code and no email sent, so an app store reviewer can sign in.
const crypto = require('crypto');

const AGE_BANDS = ['under3', '3to5', '6to8', '9to12', '13to17', '18plus', 'unsaid'];
const CONDITIONS = ['autism', 'cp', 'down', 'genetic', 'apraxia', 'delay', 'injury', 'hearing', 'other', 'unsaid'];
const CODE_MINUTES = 15, CODE_TRIES = 5, SENDS_PER_HOUR = 5, SEND_GAP_MS = 45 * 1000;
const MAX_DATA = 400 * 1024;      // one device's saved setup (settings, added words, questionnaire answers, the list of photo scenes)
const MAX_CHILDREN = 12, MAX_DEVICES = 20;
const MAX_FILE = 3 * 1024 * 1024, MAX_FILES = 400, MAX_FILE_TOTAL = 40 * 1024 * 1024;   // photos, kept per device
const FILE_KEY = /^(pic|sceneimg):[A-Za-z0-9:._ \-]{1,90}$/;
const PLATFORMS = ['ipad', 'iphone', 'android', 'web'];

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS families (
     id SERIAL PRIMARY KEY, email TEXT NOT NULL UNIQUE,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_seen TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS children (
     id SERIAL PRIMARY KEY, family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
     label TEXT NOT NULL DEFAULT '', age_band TEXT NOT NULL, conditions TEXT NOT NULL DEFAULT '[]',
     consent_at TIMESTAMPTZ NOT NULL DEFAULT now(), created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  // One row per tablet or phone a child uses. Each keeps its own setup, so two devices never overwrite each other.
  `CREATE TABLE IF NOT EXISTS devices (
     id SERIAL PRIMARY KEY, family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
     child_id INTEGER NOT NULL REFERENCES children(id) ON DELETE CASCADE,
     name TEXT NOT NULL DEFAULT '', platform TEXT NOT NULL DEFAULT 'web', data TEXT, data_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_seen TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS device_files (
     device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE, key TEXT NOT NULL,
     body TEXT NOT NULL, bytes INTEGER NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (device_id, key))`,
  `CREATE TABLE IF NOT EXISTS login_codes (
     email TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
     tries INTEGER NOT NULL DEFAULT 0, sent_at TIMESTAMPTZ NOT NULL, sent_count INTEGER NOT NULL DEFAULT 1, window_at TIMESTAMPTZ NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sessions (
     token_hash TEXT PRIMARY KEY, family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_used TIMESTAMPTZ NOT NULL DEFAULT now())`
];

const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
function cleanEmail(v) {
  const e = String(v || '').trim().toLowerCase();
  return e.length <= 254 && /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[a-z]{2,}$/.test(e) ? e : '';
}
function sameKey(a, b) {
  const x = Buffer.from(sha(a)), y = Buffer.from(sha(b));
  return crypto.timingSafeEqual(x, y);
}
function fail(code, msg) { const e = new Error(msg); e.code = code; return e; }

/* opts: { pool (has .query(sql, params)), sendMail(to, subject, text) -> Promise, mailOn, adminKey, now() } */
function makeAccounts(opts) {
  const pool = opts.pool, now = opts.now || (() => Date.now());
  let ready = false, why = !pool ? 'no database' : 'starting';
  const q = (sql, params) => pool.query(sql, params || []);
  const ipHits = new Map();
  function ipOk(ip, max) {
    const t = now(), keep = (ipHits.get(ip) || []).filter(x => t - x < 3600e3);
    if (keep.length >= max) { ipHits.set(ip, keep); return false; }
    keep.push(t); ipHits.set(ip, keep);
    if (ipHits.size > 5000) ipHits.clear();
    return true;
  }
  const iso = ms => new Date(ms).toISOString();

  const init = !pool ? Promise.resolve(false) : SCHEMA.reduce((p, s) => p.then(() => q(s)), Promise.resolve())
    .then(() => { ready = true; why = ''; return true; }, e => { why = 'database error: ' + e.message; console.error('accounts are off:', why); return false; });

  function status() {
    return { enabled: ready && !!opts.mailOn, database: ready, mail: !!opts.mailOn, reason: ready ? (opts.mailOn ? '' : 'no mail key') : why,
      ageBands: AGE_BANDS, conditions: CONDITIONS };
  }

  async function start(emailRaw, ip) {
    const email = cleanEmail(emailRaw);
    if (!email) throw fail(400, 'That does not look like an email address.');
    if (!ipOk('start ' + ip, 20)) throw fail(429, 'Too many tries from here. Please wait an hour.');
    const t = now(), r = await q('SELECT sent_at, sent_count, window_at FROM login_codes WHERE email = $1', [email]);
    let count = 1, windowAt = t;
    if (r.rows.length) {
      const row = r.rows[0], sentAt = new Date(row.sent_at).getTime(), win = new Date(row.window_at).getTime();
      if (t - sentAt < SEND_GAP_MS) throw fail(429, 'A code was just sent. Check your email, or wait a minute and try again.');
      if (t - win < 3600e3) { if (row.sent_count >= SENDS_PER_HOUR) throw fail(429, 'Too many codes sent to this address. Please wait an hour.'); count = row.sent_count + 1; windowAt = win; }
    }
    const review = !!(opts.reviewEmail && /^\d{6}$/.test(String(opts.reviewCode || '')) && email === cleanEmail(opts.reviewEmail));
    const code = review ? String(opts.reviewCode) : String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    await q('DELETE FROM login_codes WHERE email = $1', [email]);
    await q('INSERT INTO login_codes (email, code_hash, expires_at, tries, sent_at, sent_count, window_at) VALUES ($1,$2,$3,0,$4,$5,$6)',
      [email, sha(email + ':' + code), iso(t + CODE_MINUTES * 60e3), iso(t), count, iso(windowAt)]);
    if (review) return { ok: true, minutes: CODE_MINUTES };
    try {
      await opts.sendMail(email, 'Your My Turn code: ' + code,
        'Your My Turn sign-in code is ' + code + '\n\nType it into the app. It works for ' + CODE_MINUTES + ' minutes.\n\n' +
        'If you did not ask for this, you can ignore this email. Nobody can sign in without the code.\n');
    } catch (e) {
      await q('DELETE FROM login_codes WHERE email = $1', [email]);
      console.error('login code email failed:', e.message);
      throw fail(502, 'The email could not be sent. Please try again in a few minutes.');
    }
    return { ok: true, minutes: CODE_MINUTES };
  }

  async function verify(emailRaw, codeRaw, ip) {
    const email = cleanEmail(emailRaw), code = String(codeRaw || '').replace(/\D/g, '');
    if (!email || code.length !== 6) throw fail(400, 'Type the 6 numbers from the email.');
    if (!ipOk('verify ' + ip, 40)) throw fail(429, 'Too many tries from here. Please wait an hour.');
    const t = now(), r = await q('SELECT code_hash, expires_at, tries FROM login_codes WHERE email = $1', [email]);
    const row = r.rows[0];
    if (!row || new Date(row.expires_at).getTime() < t) throw fail(400, 'That code has run out. Ask for a new one.');
    if (row.tries >= CODE_TRIES) { await q('DELETE FROM login_codes WHERE email = $1', [email]); throw fail(400, 'Too many wrong tries. Ask for a new code.'); }
    if (!sameKey(row.code_hash, sha(email + ':' + code))) {
      await q('UPDATE login_codes SET tries = tries + 1 WHERE email = $1', [email]);
      throw fail(400, 'That code is not right. Check the email and try again.');
    }
    await q('DELETE FROM login_codes WHERE email = $1', [email]);
    let f = await q('SELECT id FROM families WHERE email = $1', [email]);
    if (!f.rows.length) { await q('INSERT INTO families (email, created_at, last_seen) VALUES ($1,$2,$2)', [email, iso(t)]); f = await q('SELECT id FROM families WHERE email = $1', [email]); }
    const fid = f.rows[0].id, token = crypto.randomBytes(32).toString('base64url');
    await q('INSERT INTO sessions (token_hash, family_id, created_at, last_used) VALUES ($1,$2,$3,$3)', [sha(token), fid, iso(t)]);
    await q('UPDATE families SET last_seen = $2 WHERE id = $1', [fid, iso(t)]);
    return { ok: true, token, email, children: await kids(fid) };
  }

  async function who(token) {
    const tk = String(token || '');
    if (tk.length < 20 || tk.length > 200) throw fail(401, 'Please sign in again.');
    const r = await q('SELECT s.family_id AS fid, f.email AS email FROM sessions s JOIN families f ON f.id = s.family_id WHERE s.token_hash = $1', [sha(tk)]);
    if (!r.rows.length) throw fail(401, 'Please sign in again.');
    const t = iso(now());
    await q('UPDATE sessions SET last_used = $2 WHERE token_hash = $1', [sha(tk), t]);
    await q('UPDATE families SET last_seen = $2 WHERE id = $1', [r.rows[0].fid, t]);
    return { fid: r.rows[0].fid, email: r.rows[0].email };
  }
  async function kids(fid) {
    const r = await q('SELECT id, label, age_band, conditions FROM children WHERE family_id = $1 ORDER BY id', [fid]);
    const d = await q('SELECT id, child_id, name, platform, data_at FROM devices WHERE family_id = $1 ORDER BY id', [fid]);
    const f = await q('SELECT df.device_id AS did, COUNT(*) AS n FROM device_files df JOIN devices d ON d.id = df.device_id WHERE d.family_id = $1 GROUP BY df.device_id', [fid]);
    const photos = {}; f.rows.forEach(x => photos[x.did] = Number(x.n));
    return r.rows.map(c => ({ id: c.id, label: c.label, ageBand: c.age_band, conditions: safeList(c.conditions),
      devices: d.rows.filter(x => x.child_id === c.id).map(x => ({ id: x.id, name: x.name, platform: x.platform, savedAt: x.data_at ? new Date(x.data_at).toISOString() : null, photos: photos[x.id] || 0 })) }));
  }
  async function dev(token, id) {            // the device, only if it belongs to the signed-in family
    const w = await who(token), r = await q('SELECT id, child_id FROM devices WHERE id = $1 AND family_id = $2', [Number(id), w.fid]);
    if (!r.rows.length) throw fail(404, 'That device is not on this account.');
    return { fid: w.fid, id: r.rows[0].id, childId: r.rows[0].child_id };
  }
  const cleanName = v => String(v || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40);
  function safeList(s) { try { const a = JSON.parse(s); return Array.isArray(a) ? a.filter(x => CONDITIONS.includes(x)) : []; } catch (e) { return []; } }
  function childFields(b) {
    const ageBand = String(b.ageBand || ''), conditions = Array.isArray(b.conditions) ? [...new Set(b.conditions.map(String))].filter(x => CONDITIONS.includes(x)) : [];
    if (!AGE_BANDS.includes(ageBand)) throw fail(400, 'Choose an age range.');
    if (!conditions.length) throw fail(400, 'Choose at least one, or "Prefer not to say".');
    const label = String(b.label || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 30);
    return { ageBand, conditions, label };
  }

  async function me(token) { const w = await who(token); return { ok: true, email: w.email, children: await kids(w.fid) }; }

  async function childSave(token, b) {
    const w = await who(token), c = childFields(b), t = iso(now());
    if (b.id) {
      const r = await q('UPDATE children SET label = $3, age_band = $4, conditions = $5 WHERE id = $1 AND family_id = $2', [Number(b.id), w.fid, c.label, c.ageBand, JSON.stringify(c.conditions)]);
      if (!r.rowCount) throw fail(404, 'That child is not on this account.');
      return { ok: true, id: Number(b.id), children: await kids(w.fid) };
    }
    if (b.consent !== true) throw fail(400, 'Please tick the box to agree before saving.');
    const n = await q('SELECT COUNT(*) AS n FROM children WHERE family_id = $1', [w.fid]);
    if (Number(n.rows[0].n) >= MAX_CHILDREN) throw fail(400, 'This account already has the most children it can hold.');
    await q('INSERT INTO children (family_id, label, age_band, conditions, consent_at, created_at) VALUES ($1,$2,$3,$4,$5,$5)', [w.fid, c.label, c.ageBand, JSON.stringify(c.conditions), t]);
    const all = await kids(w.fid);
    return { ok: true, id: all[all.length - 1].id, children: all };
  }

  async function deviceAdd(token, b) {
    const w = await who(token), t = iso(now());
    const c = await q('SELECT id FROM children WHERE id = $1 AND family_id = $2', [Number(b.childId), w.fid]);
    if (!c.rows.length) throw fail(404, 'That child is not on this account.');
    const n = await q('SELECT COUNT(*) AS n FROM devices WHERE family_id = $1', [w.fid]);
    if (Number(n.rows[0].n) >= MAX_DEVICES) throw fail(400, 'This account already has the most devices it can hold. Remove one you no longer use.');
    const platform = PLATFORMS.includes(b.platform) ? b.platform : 'web';
    await q('INSERT INTO devices (family_id, child_id, name, platform, created_at, last_seen) VALUES ($1,$2,$3,$4,$5,$5)', [w.fid, Number(b.childId), cleanName(b.name) || 'Device', platform, t]);
    const r = await q('SELECT MAX(id) AS id FROM devices WHERE family_id = $1', [w.fid]);
    return { ok: true, deviceId: r.rows[0].id, children: await kids(w.fid) };
  }
  async function deviceRename(token, b) {
    const d = await dev(token, b.device), name = cleanName(b.name);
    if (!name) throw fail(400, 'Type a name for the device.');
    await q('UPDATE devices SET name = $2 WHERE id = $1', [d.id, name]);
    return { ok: true, children: await kids(d.fid) };
  }
  async function deviceRemove(token, b) {
    const d = await dev(token, b.device);
    await q('DELETE FROM device_files WHERE device_id = $1', [d.id]);
    await q('DELETE FROM devices WHERE id = $1', [d.id]);
    return { ok: true, children: await kids(d.fid) };
  }
  /* Saves this device's setup. `keys` is the list of photos the device has now: any other photo kept for it is dropped.
     The answer lists what the server holds (key -> size) so the device can send only what is new or changed. */
  async function dataSave(token, b) {
    const d = await dev(token, b.device), text = JSON.stringify(b.data === undefined ? null : b.data);
    if (!b.data || typeof b.data !== 'object') throw fail(400, 'Nothing to save.');
    if (text.length > MAX_DATA) throw fail(413, 'That setup is too large to save.');
    const t = iso(now());
    await q('UPDATE devices SET data = $2, data_at = $3, last_seen = $3 WHERE id = $1', [d.id, text, t]);
    const have = {}, rows = (await q('SELECT key, bytes FROM device_files WHERE device_id = $1', [d.id])).rows;
    if (Array.isArray(b.keys)) {
      const want = new Set(b.keys.map(String));
      for (const r of rows) { if (want.has(r.key)) have[r.key] = r.bytes; else await q('DELETE FROM device_files WHERE device_id = $1 AND key = $2', [d.id, r.key]); }
    } else rows.forEach(r => have[r.key] = r.bytes);
    return { ok: true, savedAt: t, have };
  }
  async function fileSave(token, b) {
    const d = await dev(token, b.device), key = String(b.key || ''), body = String(b.body || '');
    if (!FILE_KEY.test(key)) throw fail(400, 'That is not a photo this app saves.');
    if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(body)) throw fail(400, 'That is not a picture.');
    if (body.length > MAX_FILE) throw fail(413, 'That photo is too large to save.');
    const tot = await q('SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM device_files WHERE device_id = $1 AND key <> $2', [d.id, key]);
    if (Number(tot.rows[0].n) >= MAX_FILES || Number(tot.rows[0].b) + body.length > MAX_FILE_TOTAL) throw fail(413, 'This device has reached the most photos that can be saved.');
    await q('DELETE FROM device_files WHERE device_id = $1 AND key = $2', [d.id, key]);
    await q('INSERT INTO device_files (device_id, key, body, bytes, updated_at) VALUES ($1,$2,$3,$4,$5)', [d.id, key, body, body.length, iso(now())]);
    return { ok: true, bytes: body.length };
  }
  async function dataLoad(token, b) {
    const d = await dev(token, b.device);
    const r = await q('SELECT data, data_at FROM devices WHERE id = $1', [d.id]);
    let data = null; try { data = r.rows[0].data ? JSON.parse(r.rows[0].data) : null; } catch (e) {}
    const files = (await q('SELECT key, bytes FROM device_files WHERE device_id = $1 ORDER BY key', [d.id])).rows.map(x => ({ key: x.key, bytes: x.bytes }));
    return { ok: true, data, files, savedAt: r.rows[0].data_at ? new Date(r.rows[0].data_at).toISOString() : null };
  }
  async function fileLoad(token, b) {
    const d = await dev(token, b.device);
    const r = await q('SELECT body FROM device_files WHERE device_id = $1 AND key = $2', [d.id, String(b.key || '')]);
    if (!r.rows.length) throw fail(404, 'That photo is not saved.');
    return { ok: true, body: r.rows[0].body };
  }
  async function childDelete(token, b) {
    const w = await who(token);
    const c = await q('SELECT id FROM children WHERE id = $1 AND family_id = $2', [Number(b.id), w.fid]);
    if (!c.rows.length) throw fail(404, 'That child is not on this account.');
    await q('DELETE FROM device_files WHERE device_id IN (SELECT id FROM devices WHERE child_id = $1)', [c.rows[0].id]);
    await q('DELETE FROM devices WHERE child_id = $1', [c.rows[0].id]);
    await q('DELETE FROM children WHERE id = $1', [c.rows[0].id]);
    return { ok: true, children: await kids(w.fid) };
  }
  async function signOut(token) { await q('DELETE FROM sessions WHERE token_hash = $1', [sha(String(token || ''))]); return { ok: true }; }
  async function erase(token) {             // the whole account: every child, every device, every saved setup and photo, every sign-in
    const w = await who(token);
    await q('DELETE FROM device_files WHERE device_id IN (SELECT id FROM devices WHERE family_id = $1)', [w.fid]);
    await q('DELETE FROM devices WHERE family_id = $1', [w.fid]);
    await q('DELETE FROM children WHERE family_id = $1', [w.fid]);
    await q('DELETE FROM sessions WHERE family_id = $1', [w.fid]);
    await q('DELETE FROM login_codes WHERE email = $1', [w.email]);
    await q('DELETE FROM families WHERE id = $1', [w.fid]);
    return { ok: true };
  }

  /* Totals only. No emails, names or saved setups ever leave through here. */
  async function stats(key, ip) {
    if (!opts.adminKey || String(opts.adminKey).length < 12) throw fail(503, 'No admin key is set on the server.');
    if (!ipOk('admin ' + ip, 30)) throw fail(429, 'Too many tries. Please wait an hour.');
    if (!sameKey(String(key || ''), String(opts.adminKey))) throw fail(403, 'Wrong key.');
    const t = now(), month = iso(t - 30 * 86400e3);
    const fam = await q('SELECT COUNT(*) AS n FROM families'), act = await q('SELECT COUNT(*) AS n FROM families WHERE last_seen >= $1', [month]);
    const rows = (await q('SELECT age_band, conditions, created_at FROM children')).rows;
    const byAge = {}, byCond = {}; AGE_BANDS.forEach(a => byAge[a] = 0); CONDITIONS.forEach(c => byCond[c] = 0);
    let fresh = 0;
    rows.forEach(r => { if (byAge[r.age_band] !== undefined) byAge[r.age_band]++; safeList(r.conditions).forEach(c => byCond[c]++); if (new Date(r.created_at).getTime() >= t - 30 * 86400e3) fresh++; });
    const devs = (await q('SELECT platform, last_seen FROM devices')).rows, byPlatform = {}; PLATFORMS.forEach(x => byPlatform[x] = 0);
    let devActive = 0; devs.forEach(x => { if (byPlatform[x.platform] !== undefined) byPlatform[x.platform]++; if (new Date(x.last_seen).getTime() >= t - 30 * 86400e3) devActive++; });
    return { ok: true, asOf: iso(t), families: Number(fam.rows[0].n), familiesActive30Days: Number(act.rows[0].n), children: rows.length, childrenAdded30Days: fresh, byAge, byCondition: byCond,
      devices: devs.length, devicesActive30Days: devActive, byPlatform,
      note: 'A child can have more than one condition, so the condition counts can add up to more than the number of children.' };
  }

  /* Returns a promise when the path was one of ours, otherwise null. */
  function route(p, method, body, ip) {
    if (p === '/api/acct/status') return Promise.resolve(status());
    if (p.indexOf('/api/acct/') !== 0 && p !== '/api/admin/stats') return null;
    if (method !== 'POST') return Promise.reject(fail(405, 'POST only'));
    if (!ready) return Promise.reject(fail(503, 'Accounts are not set up on the server yet.'));
    const b = body && typeof body === 'object' ? body : {};
    if (p === '/api/admin/stats') return stats(b.key, ip);
    if (p === '/api/acct/start') { if (!opts.mailOn) return Promise.reject(fail(503, 'Email is not set up on the server yet.')); return start(b.email, ip); }
    if (p === '/api/acct/verify') return verify(b.email, b.code, ip);
    if (p === '/api/acct/me') return me(b.token);
    if (p === '/api/acct/child') return childSave(b.token, b);
    if (p === '/api/acct/child/delete') return childDelete(b.token, b);
    if (p === '/api/acct/device') return deviceAdd(b.token, b);
    if (p === '/api/acct/device/rename') return deviceRename(b.token, b);
    if (p === '/api/acct/device/remove') return deviceRemove(b.token, b);
    if (p === '/api/acct/save') return dataSave(b.token, b);
    if (p === '/api/acct/load') return dataLoad(b.token, b);
    if (p === '/api/acct/file') return fileSave(b.token, b);
    if (p === '/api/acct/file/get') return fileLoad(b.token, b);
    if (p === '/api/acct/signout') return signOut(b.token);
    if (p === '/api/acct/erase') return erase(b.token);
    return Promise.reject(fail(404, 'No such address.'));
  }
  return { init, status, route, MAX_BODY: Math.max(MAX_DATA, MAX_FILE) + 8192 };
}

/* Sends one plain-text email through Resend. */
function resendMailer(key, from, endpoint) {
  return async function (to, subject, text) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 15000);
    try {
      const r = await fetch(endpoint || 'https://api.resend.com/emails', { method: 'POST', signal: ctl.signal,
        headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify({ from, to: [to], subject, text }) });
      if (!r.ok) throw new Error('mail service said ' + r.status + ' ' + (await r.text()).slice(0, 200));
    } finally { clearTimeout(timer); }
  };
}

module.exports = { makeAccounts, resendMailer, cleanEmail, AGE_BANDS, CONDITIONS };
