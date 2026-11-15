// My Turn wristband sound format, tablet side. Must match wristband/firmware/MyTurnBand/codec.h exactly (a test checks that it does).
// Clip = 'M','T','1',0, sample rate (2 bytes), sample count (4 bytes), then IMA ADPCM, 4 bits a sample, low half of each byte first.
(function(root){
  var STEP = [7,8,9,10,11,12,13,14,16,17,19,21,23,25,28,31,34,37,41,45,50,55,60,66,73,80,88,97,107,118,130,143,157,173,190,209,230,253,279,307,337,371,408,449,494,544,598,658,724,796,876,963,1060,1166,1282,1411,1552,1707,1878,2066,2272,2499,2749,3024,3327,3660,4026,4428,4871,5358,5894,6484,7132,7845,8630,9493,10442,11487,12635,13899,15289,16818,18500,20350,22385,24623,27086,29794,32767];
  var IDX = [-1,-1,-1,-1,2,4,6,8,-1,-1,-1,-1,2,4,6,8];
  function step(st, n){                                  // the decoder's step: both sides run exactly this, so they stay in step
    var s = STEP[st.index], diff = s >> 3;
    if(n & 1) diff += s >> 2;
    if(n & 2) diff += s >> 1;
    if(n & 4) diff += s;
    if(n & 8) st.pred -= diff; else st.pred += diff;
    if(st.pred > 32767) st.pred = 32767; else if(st.pred < -32768) st.pred = -32768;
    st.index += IDX[n];
    if(st.index < 0) st.index = 0; else if(st.index > 88) st.index = 88;
    return st.pred;
  }
  function encode(pcm, rate){
    var n = pcm.length, out = new Uint8Array(10 + Math.ceil(n / 2)), st = {pred:0, index:0};
    out[0] = 77; out[1] = 84; out[2] = 49; out[3] = 0; out[4] = rate & 255; out[5] = rate >> 8;
    out[6] = n & 255; out[7] = (n >>> 8) & 255; out[8] = (n >>> 16) & 255; out[9] = (n >>> 24) & 255;
    for(var i = 0; i < n; i++){
      var s = STEP[st.index], d = pcm[i] - st.pred, nib = 0;
      if(d < 0){ nib = 8; d = -d; }
      if(d >= s){ nib |= 4; d -= s; }
      if(d >= (s >> 1)){ nib |= 2; d -= s >> 1; }
      if(d >= (s >> 2)) nib |= 1;
      step(st, nib);
      if(i & 1) out[10 + (i >> 1)] |= nib << 4; else out[10 + (i >> 1)] = nib;
    }
    return out;
  }
  function decode(bytes){
    if(bytes.length < 10 || bytes[0] !== 77 || bytes[1] !== 84 || bytes[2] !== 49 || bytes[3] !== 0) return null;
    var rate = bytes[4] | (bytes[5] << 8), n = (bytes[6] | (bytes[7] << 8) | (bytes[8] << 16) | (bytes[9] << 24)) >>> 0;
    if(n > (bytes.length - 10) * 2) return null;
    var pcm = new Int16Array(n), st = {pred:0, index:0};
    for(var i = 0; i < n; i++){ var b = bytes[10 + (i >> 1)]; pcm[i] = step(st, (i & 1) ? (b >> 4) : (b & 15)); }
    return {rate:rate, pcm:pcm};
  }
  var TABLE = null;
  function crc32(bytes){
    if(!TABLE){ TABLE = new Uint32Array(256); for(var t = 0; t < 256; t++){ var c = t; for(var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); TABLE[t] = c >>> 0; } }
    var crc = 0xFFFFFFFF;
    for(var i = 0; i < bytes.length; i++) crc = TABLE[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
  var api = {encode:encode, decode:decode, crc32:crc32};
  root.BandCodec = api;
  if(typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
