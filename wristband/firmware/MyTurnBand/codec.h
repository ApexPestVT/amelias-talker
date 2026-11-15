// My Turn wristband: sound format and checksum. Plain C++ with no board code, so the same file is tested on a computer.
// A clip file is: 'M','T','1', 0, sample rate (2 bytes, low first), number of samples (4 bytes, low first), then IMA ADPCM, 4 bits a sample, low half of each byte first.
#pragma once
#include <stdint.h>
#include <stddef.h>

#define MT_HEADER 10

static const int16_t MT_STEP[89] = {7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767};
static const int8_t MT_INDEX[16] = {-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8};

struct MtDecoder { int32_t pred; int32_t index; };

static inline void mtReset(MtDecoder &d) { d.pred = 0; d.index = 0; }

static inline int16_t mtDecodeNibble(MtDecoder &d, uint8_t n) {
  int32_t step = MT_STEP[d.index], diff = step >> 3;
  if (n & 1) diff += step >> 2;
  if (n & 2) diff += step >> 1;
  if (n & 4) diff += step;
  if (n & 8) d.pred -= diff; else d.pred += diff;
  if (d.pred > 32767) d.pred = 32767; else if (d.pred < -32768) d.pred = -32768;
  d.index += MT_INDEX[n & 15];
  if (d.index < 0) d.index = 0; else if (d.index > 88) d.index = 88;
  return (int16_t)d.pred;
}

// Reads the header. Returns false if this is not a clip the wristband understands.
static inline bool mtHeader(const uint8_t *h, size_t len, uint16_t &rate, uint32_t &samples) {
  if (len < MT_HEADER || h[0] != 'M' || h[1] != 'T' || h[2] != '1' || h[3] != 0) return false;
  rate = (uint16_t)(h[4] | (h[5] << 8));
  samples = (uint32_t)h[6] | ((uint32_t)h[7] << 8) | ((uint32_t)h[8] << 16) | ((uint32_t)h[9] << 24);
  if (rate < 8000 || rate > 24000) return false;
  return samples <= (uint32_t)(len - MT_HEADER) * 2;          // never more samples than the bytes can hold
}

// CRC-32 (the common zip one), so the tablet and the wristband agree a clip arrived whole.
static inline uint32_t mtCrc(const uint8_t *p, size_t len, uint32_t crc = 0) {
  crc = ~crc;
  for (size_t i = 0; i < len; i++) { crc ^= p[i]; for (int k = 0; k < 8; k++) crc = (crc >> 1) ^ (0xEDB88320u & (0u - (crc & 1u))); }
  return ~crc;
}

// Loudness 1 to 8 as a multiplier out of 256. 8 is the loudest the wristband allows: change MT_GAIN_TOP after the real speaker has been measured.
#define MT_GAIN_TOP 256
static inline int32_t mtGain(uint8_t vol) {
  static const uint16_t g[9] = {0, 20, 32, 48, 72, 104, 150, 205, 256};
  if (vol < 1) vol = 1;
  if (vol > 8) vol = 8;
  int32_t v = g[vol]; return v > MT_GAIN_TOP ? MT_GAIN_TOP : v;
}
static inline int16_t mtScale(int16_t s, int32_t gain) { return (int16_t)(((int32_t)s * gain) >> 8); }
