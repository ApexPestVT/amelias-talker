// Runs the wristband's own decoder and checksum on a computer. Reads a clip file, prints its checksum and writes the decoded samples.
#include <cstdio>
#include <vector>
#include "../firmware/MyTurnBand/codec.h"
int main(int argc, char **argv) {
  if (argc < 3) return 2;
  FILE *f = fopen(argv[1], "rb"); if (!f) return 2;
  std::vector<uint8_t> b; int c; while ((c = fgetc(f)) != EOF) b.push_back((uint8_t)c); fclose(f);
  uint16_t rate; uint32_t n;
  if (!mtHeader(b.data(), b.size(), rate, n)) { printf("bad header\n"); return 1; }
  MtDecoder d; mtReset(d); std::vector<int16_t> out;
  for (uint32_t i = 0; i < n; i++) { uint8_t byte = b[MT_HEADER + (i >> 1)]; out.push_back(mtDecodeNibble(d, (i & 1) ? (byte >> 4) : (byte & 15))); }
  FILE *o = fopen(argv[2], "wb"); fwrite(out.data(), 2, out.size(), o); fclose(o);
  printf("%u %u %08x %d %d\n", rate, n, mtCrc(b.data(), b.size()), mtScale(-32768, mtGain(8)), mtScale(20000, mtGain(1)));
  return 0;
}
