// Checks the wristband's key logic: tap, press and hold, double tap, for each of the three levels.
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const tmp = fs.mkdtempSync('/tmp/keys-'); let fails = 0;
execFileSync('g++', ['-std=c++17', '-Wall', '-Wextra', '-O2', '-o', tmp + '/keys', path.join(__dirname, 'keys-host.cpp')]);
const KIND = ['tap', 'hold', 'double'], ALL = 0xfff, TAPS = 0x00f, L2 = 0x0ff;
// o: {hold, dbl, guard=1, wait=400, holdMs=700, talk=500, have=ALL, end=4000}; presses: [[key, down, up], ...]
function run(o, presses) {
  const head = [o.hold ? 1 : 0, o.dbl ? 1 : 0, o.guard === 0 ? 0 : 1, o.wait || 400, o.holdMs || 700, o.talk || 500, o.have === undefined ? ALL : o.have, o.end || 4000].join(' ');
  const out = execFileSync(tmp + '/keys', { input: head + '\n' + presses.map(p => p.join(' ')).join('\n') + '\n' }).toString().trim().split('\n');
  const pair = +out.pop().split(' ')[1];
  return { said: out.filter(Boolean).map(l => { const [t, k, kind] = l.split(' ').map(Number); return { t: t - 1000, k, kind: KIND[kind] }; }), pair };
}
function check(name, o, presses, want, extra) {
  const r = run(o, presses), got = r.said.map(s => s.k + ':' + s.kind).join(' ');
  let good = got === want; let note = '';
  if (good && extra) { const m = extra(r); if (m) { good = false; note = ' (' + m + ')'; } }
  if (!good) fails++;
  console.log((good ? 'ok   ' : 'FAIL ') + name + ' -> ' + (got || 'nothing') + (good ? '' : '   wanted: ' + (want || 'nothing') + note) + (r.said.length ? '   at ' + r.said.map(s => s.t + ' ms').join(', ') : ''));
}
const L1 = { hold: 0, dbl: 0 }, lv2 = { hold: 1, dbl: 0, have: L2 }, lv3 = { hold: 1, dbl: 1 };
const within = (i, lo, hi) => r => (r.said[i].t >= lo && r.said[i].t <= hi) ? '' : 'time ' + r.said[i].t + ' not in ' + lo + '..' + hi;
// Level 1: tap only
check('Level 1: a tap talks at once', L1, [[0, 100, 180]], '0:tap', within(0, 100, 110));
check('Level 1: a long press still says the tap phrase, once', L1, [[2, 100, 2000]], '2:tap');
check('Level 1: four keys in turn', L1, [[0, 100, 150], [1, 800, 850], [2, 1500, 1550], [3, 2200, 2250]], '0:tap 1:tap 2:tap 3:tap');
check('Level 1: a bouncing switch says it once', L1, [[1, 100, 103], [1, 106, 110], [1, 112, 220]], '1:tap');
check('Level 1 settings ignore stored hold and double phrases', L1, [[0, 100, 1500], [0, 2200, 2260], [0, 2400, 2460]], '0:tap 0:tap');
// Level 2: tap + press and hold
check('Level 2: a short press says the tap phrase when let go', lv2, [[0, 100, 250]], '0:tap', within(0, 250, 262));
check('Level 2: holding says the hold phrase at 0.7 s, nothing on letting go', lv2, [[0, 100, 1600]], '0:hold', within(0, 800, 812));
check('Level 2: two quick taps are two taps (no double tap at this level)', lv2, [[3, 100, 180], [3, 900, 980]], '3:tap 3:tap');
check('Level 2: a key with no hold phrase talks at once', { hold: 1, dbl: 0, have: TAPS | 0x10 }, [[1, 100, 1500]], '1:tap', within(0, 100, 110));
check('Level 2: tap one key, hold another', lv2, [[0, 100, 200], [2, 1000, 2000]], '0:tap 2:hold');
// Level 3: tap + hold + double tap
check('Level 3: one tap waits for a second tap, then says the tap phrase', lv3, [[0, 100, 200]], '0:tap', within(0, 600, 612));
check('Level 3: two quick taps say only the double-tap phrase', lv3, [[0, 100, 200], [0, 350, 450]], '0:double', within(0, 350, 362));
check('Level 3: holding says only the hold phrase', lv3, [[0, 100, 1500]], '0:hold', within(0, 800, 812));
check('Level 3: two slow taps are two taps', lv3, [[0, 100, 200], [0, 1500, 1600]], '0:tap 0:tap');
check('Level 3: tap one key then quickly another: both said, in order', lv3, [[0, 100, 180], [1, 300, 380]], '0:tap 1:tap');
check('Level 3: tap, then double tap, then hold on one key', lv3, [[2, 100, 180], [2, 1500, 1580], [2, 1700, 1780], [2, 2600, 3600]], '2:tap 2:double 2:hold', null);
check('Level 3: second tap held down is still a double tap, and nothing more', lv3, [[0, 100, 200], [0, 350, 1800]], '0:double');
check('Level 3: a key with a double-tap phrase but no hold phrase', { hold: 1, dbl: 1, have: TAPS | 0x100 }, [[0, 100, 900], [0, 2000, 2080], [0, 2200, 2280]], '0:tap 0:double');
check('Level 3: a key with only a tap phrase talks at once', { hold: 1, dbl: 1, have: TAPS | 0x110 }, [[1, 100, 180]], '1:tap', within(0, 100, 110));
check('Level 3: long wait setting (0.6 s) catches a slower second tap', { hold: 1, dbl: 1, wait: 600 }, [[0, 100, 200], [0, 700, 780]], '0:double');
check('Level 3: short wait setting (0.3 s) treats the same taps as two taps', { hold: 1, dbl: 1, wait: 300, talk: 150 }, [[0, 100, 200], [0, 700, 780]], '0:tap 0:tap');
// Ignore extra taps while talking
check('Ignore extra taps: a tap made while it is talking is dropped', L1, [[0, 100, 150], [1, 300, 400]], '0:tap');
check('Ignore extra taps: a key pressed while talking and held on says nothing', lv2, [[0, 100, 1500], [1, 900, 2600]], '0:hold');
check('With that switch off, the next press is heard', { hold: 0, dbl: 0, guard: 0 }, [[0, 100, 150], [1, 300, 900]], '0:tap 1:tap');
// Green + red together opens Bluetooth and must not talk
check('Green and red held 3.5 s with hold phrases: silent', lv3, [[0, 100, 3600], [1, 120, 3600]], '', r => r.pair >= 3000 ? '' : 'held together only ' + r.pair + ' ms');
check('Green and red held 3.5 s at Level 2: silent', lv2, [[0, 100, 3600], [1, 110, 3600]], '', r => r.pair >= 3000 ? '' : 'held together only ' + r.pair + ' ms');
console.log(fails ? fails + ' FAILED' : 'all key tests passed'); process.exit(fails ? 1 : 0);
