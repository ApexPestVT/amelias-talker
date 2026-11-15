// Checks that the tablet's encoder and the wristband's decoder agree bit for bit, and that speech-like sound survives.
const C = require('../../public/band-codec.js'), fs = require('fs'), { execFileSync } = require('child_process'), path = require('path');
const tmp = fs.mkdtempSync('/tmp/band-'); let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
execFileSync('g++', ['-std=c++17', '-Wall', '-Wextra', '-O2', '-o', tmp + '/host', path.join(__dirname, 'host.cpp')]);
function make(kind, n) { const p = new Int16Array(n); let seed = 12345;
  for (let i = 0; i < n; i++) { const t = i / 16000; seed = (seed * 1103515245 + 12345) >>> 0;
    if (kind === 'voice') p[i] = Math.round(9000 * Math.sin(2 * Math.PI * 180 * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 3 * t)) + 4000 * Math.sin(2 * Math.PI * 1200 * t) + 1500 * Math.sin(2 * Math.PI * 2900 * t));
    if (kind === 'noise') p[i] = ((seed >>> 16) & 0xffff) - 32768;
    if (kind === 'loud') p[i] = (i % 40 < 20) ? 32767 : -32768;
    if (kind === 'quiet') p[i] = 0; }
  return p; }
for (const [kind, n] of [['voice', 16000], ['noise', 4001], ['loud', 999], ['quiet', 1], ['quiet', 0]]) {
  const pcm = make(kind, n), clip = C.encode(pcm, 16000), js = C.decode(clip);
  fs.writeFileSync(tmp + '/c.adp', clip);
  const line = execFileSync(tmp + '/host', [tmp + '/c.adp', tmp + '/c.raw']).toString().trim().split(' ');
  const raw = fs.readFileSync(tmp + '/c.raw'), band = new Int16Array(raw.buffer, raw.byteOffset, raw.length / 2);
  ok(+line[0] === 16000 && +line[1] === n, kind + ' ' + n + ': wristband reads the header (rate, count)');
  ok(parseInt(line[2], 16) === C.crc32(clip), kind + ' ' + n + ': checksum matches (' + line[2] + ')');
  ok(js && js.pcm.length === n && band.length === n && js.pcm.every((v, i) => v === band[i]), kind + ' ' + n + ': wristband decodes to exactly what the tablet expects');
  if (kind === 'voice') { let e = 0, s = 0; for (let i = 0; i < n; i++) { e += (band[i] - pcm[i]) ** 2; s += pcm[i] ** 2; } const snr = 10 * Math.log10(s / e); ok(snr > 18, 'voice: decoded sound is close to the original (' + snr.toFixed(1) + ' dB)'); }
  if (kind === 'loud') ok(+line[3] === -32768 && +line[4] === 1562, 'loudness 8 passes sound unchanged, loudness 1 is about 8% (' + line[3] + ', ' + line[4] + ')');
}
ok(C.crc32(new TextEncoder().encode('123456789')) === 0xCBF43926, 'checksum is the standard CRC-32');
ok(C.decode(new Uint8Array([1, 2, 3])) === null, 'a damaged clip is refused by the tablet');
fs.writeFileSync(tmp + '/bad.adp', Buffer.from([77, 84, 49, 0, 0x80, 0x3e, 50, 0, 0, 0, 1, 2])); let bad = ''; try { execFileSync(tmp + '/host', [tmp + '/bad.adp', tmp + '/x.raw']); } catch (e) { bad = String(e.stdout); }
ok(/bad header/.test(bad), 'a clip that claims more sound than it holds is refused by the wristband');
console.log(fails ? fails + ' FAILED' : 'all passed'); process.exit(fails ? 1 : 0);
