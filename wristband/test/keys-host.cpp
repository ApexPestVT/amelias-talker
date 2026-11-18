// Runs the wristband's real key logic (firmware/MyTurnBand/keys.h) on a computer against timed presses.
// Input (stdin): first line "hold dbl guard waitMs holdMs talkMs haveMask endMs", then lines "key downMs upMs".
// Output: one line per phrase spoken: "timeMs key kind", then "pair <ms held together as seen by the scan>".
#include <cstdio>
#include <vector>
#include "../firmware/MyTurnBand/keys.h"
struct Press { int key; uint32_t a, b; };
static std::vector<Press> presses; static uint32_t T = 0, talkMs = 500; static unsigned haveMask = 0; static bool guardOn = true;
static MtKeyState ks; static MtKeyHost host;
static bool hHas(uint8_t slot) { return slot < MT_SLOTS && (haveMask >> slot) & 1; }
static bool hDown(uint8_t k) { for (auto &p : presses) if (p.key == k && T >= p.a && T < p.b) return true; return false; }
static uint32_t hNow() { return T; }
static void hSay(uint8_t key, uint8_t kind) { printf("%u %u %u\n", (unsigned)T, key, kind); T += talkMs; if (guardOn) mtKeysResync(ks, host); }
int main() {
  int hold, dbl, guard; unsigned waitMs, holdMs, tk, endMs;
  if (scanf("%d %d %d %u %u %u %u %u", &hold, &dbl, &guard, &waitMs, &holdMs, &tk, &haveMask, &endMs) != 8) return 2;
  talkMs = tk; guardOn = guard; Press p; while (scanf("%d %u %u", &p.key, &p.a, &p.b) == 3) presses.push_back(p);
  host = {hHas, hSay, hDown, hNow}; MtKeyCfg cfg = {hold != 0, dbl != 0, (uint16_t)waitMs, (uint16_t)holdMs};
  mtKeysReset(ks); T = 1000; for (auto &q : presses) { q.a += 1000; q.b += 1000; } endMs += 1000;
  uint32_t pairMs = 0;
  while (T < endMs) { if (mtKeysScan(ks, cfg, host)) pairMs += 4; T += 4; }
  printf("pair %u\n", (unsigned)pairMs);
  return 0;
}
