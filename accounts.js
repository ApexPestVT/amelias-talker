// My Turn: family accounts. Sign-in by emailed code, one saved setup per child, and totals for grant reports.
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
const MAX_DATA = 400 * 1024;      // one child's saved setup (settings, added words, questionnaire answers; never photos)
const MAX_CHILDREN = 12;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS families (
     id SERIAL PRIMARY KEY, email TEXT NOT NULL UNIQUE,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_seen TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS children (
     id SERIAL PRIMARY KEY, family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
     label TEXT NOT NULL DEFAULT '', age_band TEXT NOT NULL, conditions TEXT NOT NULL DEFAULT '[]',
     consent_at TIMESTAMPTZ NOT NULL DEFAULT now(), data TEXT, data_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
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
    const r = await q('SELECT id, label, age_band, conditions, data_at FROM children WHERE family_id = $1 ORDER BY id', [fid]);
    return r.rows.map(c => ({ id: c.id, label: c.label, ageBand: c.age_band, conditions: safeList(c.conditions), savedAt: c.data_at ? new Date(c.data_at).toISOString() : null }));
  }
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

  async function dataSave(token, b) {
    const w = await who(token), text = JSON.stringify(b.data === undefined ? null : b.data);
    if (!b.data || typeof b.data !== 'object') throw fail(400, 'Nothing to save.');
    if (text.length > MAX_DATA) throw fail(413, 'That setup is too large to save.');
    const t = iso(now());
    const r = await q('UPDATE children SET data = $3, data_at = $4 WHERE id = $1 AND family_id = $2', [Number(b.id), w.fid, text, t]);
    if (!r.rowCount) throw fail(404, 'That child is not on this account.');
    return { ok: true, savedAt: t };
  }
  async function dataLoad(token, b) {
    const w = await who(token);
    const r = await q('SELECT data, data_at FROM children WHERE id = $1 AND family_id = $2', [Number(b.id), w.fid]);
    if (!r.rows.length) throw fail(404, 'That child is not on this account.');
    let data = null; try { data = r.rows[0].data ? JSON.parse(r.rows[0].data) : null; } catch (e) {}
    return { ok: true, data, savedAt: r.rows[0].data_at ? new Date(r.rows[0].data_at).toISOString() : null };
  }
  async function childDelete(token, b) {
    const w = await who(token);
    const r = await q('DELETE FROM children WHERE id = $1 AND family_id = $2', [Number(b.id), w.fid]);
    if (!r.rowCount) throw fail(404, 'That child is not on this account.');
    return { ok: true, children: await kids(w.fid) };
  }
  async function signOut(token) { await q('DELETE FROM sessions WHERE token_hash = $1', [sha(String(token || ''))]); return { ok: true }; }
  async function erase(token) {             // the whole account: every child, every saved setup, every sign-in
    const w = await who(token);
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
    return { ok: true, asOf: iso(t), families: Number(fam.rows[0].n), familiesActive30Days: Number(act.rows[0].n), children: rows.length, childrenAdded30Days: fresh, byAge, byCondition: byCond,
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
    if (p === '/api/acct/save') return dataSave(b.token, b);
    if (p === '/api/acct/load') return dataLoad(b.token, b);
    if (p === '/api/acct/signout') return signOut(b.token);
    if (p === '/api/acct/erase') return erase(b.token);
    return Promise.reject(fail(404, 'No such address.'));
  }
  return { init, status, route, MAX_BODY: MAX_DATA + 4096 };
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
