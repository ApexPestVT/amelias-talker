// keys.h: which phrase a key press means. Plain C++ with no Arduino calls, so the same file is compiled into the
// wristband and into a test on a computer (wristband/test/keys-test.js).
//
// Three kinds of press, one phrase each per key:
//   tap                      -> slot key        (0..3)
//   press and hold           -> slot key + 4    (4..7)   when cfg.hold is on and that slot holds a phrase
//   double tap               -> slot key + 8    (8..11)  when cfg.dbl is on and that slot holds a phrase
// A key with neither extra phrase talks the moment it is pressed.
// A key with a hold phrase waits until it is let go (tap) or the hold time passes (hold).
// A key with a double-tap phrase waits cfg.waitMs for a second tap before it says the tap phrase.
#pragma once
#include <stdint.h>

#define MT_KEYS 4
#define MT_TAP 0
#define MT_HOLD 1
#define MT_DOUBLE 2
#define MT_SLOTS 12
#define MT_DEBOUNCE_MS 25

struct MtKeyCfg { bool hold, dbl; uint16_t waitMs, holdMs; };
struct MtKeyHost {
  bool (*has)(uint8_t slot);                 // is a phrase stored in this slot?
  void (*say)(uint8_t key, uint8_t kind);    // speak; returns when it has finished talking
  bool (*isDown)(uint8_t key);               // is the key pressed right now?
  uint32_t (*now)();                         // milliseconds
};
struct MtKeyState {
  bool down[MT_KEYS];
  bool done[MT_KEYS];                        // this press has been dealt with: letting go or holding longer does nothing more
  uint32_t changedAt[MT_KEYS], pressedAt[MT_KEYS];
  int8_t waitingKey;                         // a tap waiting to see whether a second tap follows
  uint32_t waitingSince;
};

static inline uint8_t mtSlot(uint8_t key, uint8_t kind) { return (uint8_t)(key + 4 * kind); }
static inline void mtKeysReset(MtKeyState &s) { for (uint8_t k = 0; k < MT_KEYS; k++) { s.down[k] = false; s.done[k] = true; s.changedAt[k] = 0; s.pressedAt[k] = 0; } s.waitingKey = -1; s.waitingSince = 0; }

// Called after talking when "ignore extra taps" is on: presses made while it was talking are dropped.
static inline void mtKeysResync(MtKeyState &s, const MtKeyHost &h) {
  uint32_t now = h.now();
  for (uint8_t k = 0; k < MT_KEYS; k++) { bool d = h.isDown(k); if (d && !s.down[k]) s.done[k] = true; s.down[k] = d; s.changedAt[k] = now; }
}

static inline void mtKeyPressed(MtKeyState &s, const MtKeyCfg &cfg, const MtKeyHost &h, uint8_t k) {
  uint32_t now = h.now(); s.done[k] = false;
  bool hasHold = cfg.hold && h.has(mtSlot(k, MT_HOLD)), hasDbl = cfg.dbl && h.has(mtSlot(k, MT_DOUBLE));
  bool second = hasDbl && s.waitingKey == (int8_t)k && now - s.waitingSince <= cfg.waitMs;
  if (s.waitingKey >= 0 && !second) {                       // another tap was still waiting: say it first, in order
    uint8_t w = (uint8_t)s.waitingKey; s.waitingKey = -1; h.say(w, MT_TAP); now = h.now();
    if (!h.isDown(k)) {                                     // this key was let go while the other phrase was being said: it was a tap
      s.down[k] = false; s.changedAt[k] = now; s.done[k] = true;
      if (hasDbl) { s.waitingKey = (int8_t)k; s.waitingSince = now; } else h.say(k, MT_TAP);
      return;
    }
    s.down[k] = true;
  }
  s.pressedAt[k] = now;
  if (second) { s.waitingKey = -1; s.done[k] = true; h.say(k, MT_DOUBLE); return; }
  if (!hasHold && !hasDbl) { s.done[k] = true; h.say(k, MT_TAP); return; }
  if (hasHold) return;                                      // decided when the key is let go, or when the hold time passes
  s.done[k] = true; s.waitingKey = (int8_t)k; s.waitingSince = now;   // double tap only: the wait runs from the press
}

static inline void mtKeyReleased(MtKeyState &s, const MtKeyCfg &cfg, const MtKeyHost &h, uint8_t k) {
  if (s.done[k]) return;
  s.done[k] = true;                                         // let go before the hold time: a tap
  if (cfg.dbl && h.has(mtSlot(k, MT_DOUBLE))) { s.waitingKey = (int8_t)k; s.waitingSince = h.now(); }
  else h.say(k, MT_TAP);
}

// Call every few milliseconds. Returns true while green and red (keys 0 and 1) are held together, which opens Bluetooth after 3 seconds.
static inline bool mtKeysScan(MtKeyState &s, const MtKeyCfg &cfg, const MtKeyHost &h) {
  for (uint8_t k = 0; k < MT_KEYS; k++) {
    uint32_t now = h.now(); bool d = h.isDown(k);
    if (d != s.down[k] && now - s.changedAt[k] >= MT_DEBOUNCE_MS) { s.down[k] = d; s.changedAt[k] = now; if (d) mtKeyPressed(s, cfg, h, k); else mtKeyReleased(s, cfg, h, k); }
  }
  bool pair = s.down[0] && s.down[1];
  if (pair) { s.done[0] = s.done[1] = true; if (s.waitingKey == 0 || s.waitingKey == 1) s.waitingKey = -1; }   // the Bluetooth hold must not also talk
  for (uint8_t k = 0; k < MT_KEYS; k++) {
    if (s.down[k] && !s.done[k] && cfg.hold && h.has(mtSlot(k, MT_HOLD)) && h.now() - s.pressedAt[k] >= cfg.holdMs) { s.done[k] = true; h.say(k, MT_HOLD); }
  }
  if (s.waitingKey >= 0 && h.now() - s.waitingSince > cfg.waitMs) { uint8_t w = (uint8_t)s.waitingKey; s.waitingKey = -1; h.say(w, MT_TAP); }   // no second tap came
  return s.down[0] && s.down[1];
}
