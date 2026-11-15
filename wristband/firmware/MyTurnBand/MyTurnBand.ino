// My Turn wristband, version 0.1
// Board: Seeed XIAO ESP32-S3. Amplifier: SparkFun DEV-14809 (MAX98357A). Four keys to ground.
// Wiring is the table in the Build Guide. Pin numbers below are the chip's GPIO numbers; the board's own labels are in the comments.
//
// What it does
//  - A key press says that key's phrase from a clip stored on the wristband. No tablet is needed to talk.
//  - Hold GREEN and RED together for 3 seconds: two rising beeps, and Bluetooth is open for 3 minutes so the My Turn app can send phrases and settings.
//    Bluetooth is off at all other times.
//  - After 2 minutes with no key it sleeps (if "sleep" is on). Any key wakes it and is spoken.
//
// NOT YET RUN ON A REAL BOARD. Written against the published Arduino-ESP32 3.x interfaces and compiled by GitHub.

#include <Arduino.h>
#include <LittleFS.h>
#include <Preferences.h>
#include <ESP_I2S.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include "driver/rtc_io.h"
#include "esp_sleep.h"
#include "codec.h"

#define FW_MAJOR 0
#define FW_MINOR 1

// ---- pins (GPIO number, board label) ----
static const uint8_t KEY_PIN[4] = {1, 2, 4, 5};   // D0 green (tick), D1 red (X), D3 yellow (hand), D4 blue (star)
#define PIN_BCLK 7                                 // D8  -> amplifier BCLK
#define PIN_LRCLK 8                                // D9  -> amplifier LRCLK
#define PIN_DIN 9                                  // D10 -> amplifier DIN
#define PIN_AMP 6                                  // D5  -> amplifier SD (high = on)

// ---- timings ----
#define DEBOUNCE_MS 25
#define PAIR_HOLD_MS 3000
#define PAIR_OPEN_MS 180000UL
#define SLEEP_AFTER_MS 120000UL
#define HOLD_MS 700                                // press-and-hold time for the second phrase
#define MAX_CLIP 98304                             // bytes, about 12 seconds

// ---- Bluetooth names (the app uses the same) ----
#define UUID_SVC    "7d2a0001-5c1e-4f0b-9a57-3f1c2d6e8b10"
#define UUID_CTRL   "7d2a0002-5c1e-4f0b-9a57-3f1c2d6e8b10"
#define UUID_DATA   "7d2a0003-5c1e-4f0b-9a57-3f1c2d6e8b10"
#define UUID_STATUS "7d2a0004-5c1e-4f0b-9a57-3f1c2d6e8b10"
enum { CMD_BEGIN = 1, CMD_END = 2, CMD_SETTINGS = 3, CMD_PLAY = 4, CMD_DELETE = 5 };
enum { RES_OK = 0, RES_SIZE = 1, RES_CRC = 2, RES_STORE = 3, RES_FORMAT = 4 };

// ---- settings (kept when the battery is flat) ----
struct Settings { uint8_t vol; bool dbl, hold, guard, sleep; uint16_t waitMs; } cfg = {6, false, false, true, true, 400};
Preferences prefs;
I2SClass i2s;
bool i2sOn = false;

// ---- Bluetooth state. The Bluetooth task only copies bytes and raises flags; the main loop does the work. ----
BLEServer *bleServer = nullptr;
BLECharacteristic *chStatus = nullptr;
volatile bool bleOn = false, bleLinked = false;
uint32_t bleOpenedAt = 0;
uint8_t *rxBuf = nullptr;
volatile uint32_t rxLen = 0, rxWant = 0, rxCrc = 0;
volatile uint8_t rxSlot = 255;
volatile bool rxOverflow = false, doEnd = false, doSettings = false;
volatile int8_t doPlay = -1, doDelete = -1;
Settings newCfg;

// ---- keys ----
bool down[4] = {false, false, false, false};
uint32_t changedAt[4] = {0, 0, 0, 0}, pressedAt[4] = {0, 0, 0, 0};
bool heldSpoken[4] = {false, false, false, false};
int8_t waitingKey = -1;                            // a first tap waiting to see if a second one follows
uint32_t waitingSince = 0, lastActive = 0, comboSince = 0;
bool comboDone = false;

String slotPath(uint8_t slot) { return String("/s") + String(slot) + ".adp"; }
bool slotHas(uint8_t slot) { return LittleFS.exists(slotPath(slot)); }

void loadSettings() {
  prefs.begin("band", true);
  cfg.vol = prefs.getUChar("vol", 6); cfg.dbl = prefs.getBool("dbl", false); cfg.hold = prefs.getBool("hold", false);
  cfg.guard = prefs.getBool("guard", true); cfg.sleep = prefs.getBool("sleep", true); cfg.waitMs = prefs.getUShort("wait", 400);
  prefs.end();
  if (cfg.vol < 1 || cfg.vol > 8) cfg.vol = 6;
  if (cfg.waitMs < 200 || cfg.waitMs > 1000) cfg.waitMs = 400;
}
void saveSettings() {
  prefs.begin("band", false);
  prefs.putUChar("vol", cfg.vol); prefs.putBool("dbl", cfg.dbl); prefs.putBool("hold", cfg.hold);
  prefs.putBool("guard", cfg.guard); prefs.putBool("sleep", cfg.sleep); prefs.putUShort("wait", cfg.waitMs);
  prefs.end();
}

// ---------- sound ----------
void ampOn() {
  if (!i2sOn) { i2s.setPins(PIN_BCLK, PIN_LRCLK, PIN_DIN); i2sOn = i2s.begin(I2S_MODE_STD, 16000, I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO); }
  digitalWrite(PIN_AMP, HIGH); delay(12);
}
void ampOff() {
  int16_t quiet[256]; memset(quiet, 0, sizeof(quiet));
  if (i2sOn) for (int i = 0; i < 6; i++) i2s.write((uint8_t *)quiet, sizeof(quiet));   // let the last sound out before switching off, so there is no click
  delay(20); digitalWrite(PIN_AMP, LOW);
}
void sendSamples(const int16_t *mono, size_t n) {    // the same sound on left and right, whichever the amplifier listens to
  static int16_t st[512];
  while (n) { size_t k = n > 256 ? 256 : n; for (size_t i = 0; i < k; i++) { st[2 * i] = mono[i]; st[2 * i + 1] = mono[i]; } if (i2sOn) i2s.write((uint8_t *)st, k * 4); mono += k; n -= k; }
}
void tone2(uint16_t hz, uint16_t ms) {
  int32_t gain = mtGain(cfg.vol) / 3; int16_t buf[256]; uint32_t total = 16UL * ms, done = 0; uint32_t half = 8000UL / hz; if (!half) half = 1;
  while (done < total) { size_t k = 0; for (; k < 256 && done < total; k++, done++) buf[k] = mtScale(((done / half) & 1) ? 9000 : -9000, gain); sendSamples(buf, k); }
}
void beep(uint8_t kind) {                            // 0 = nothing stored on this key, 1 = Bluetooth open, 2 = Bluetooth closed, 3 = clip saved
  ampOn();
  if (kind == 0) tone2(330, 120);
  if (kind == 1) { tone2(520, 110); tone2(780, 160); }
  if (kind == 2) { tone2(780, 110); tone2(520, 160); }
  if (kind == 3) tone2(880, 70);
  ampOff();
}
bool anyNewPress() { for (int k = 0; k < 4; k++) if (!down[k] && digitalRead(KEY_PIN[k]) == LOW) return true; return false; }

// Plays one stored clip. Returns false if there is none (or it is damaged).
bool playSlot(uint8_t slot) {
  File f = LittleFS.open(slotPath(slot), "r");
  if (!f) return false;
  uint8_t head[MT_HEADER]; uint16_t rate; uint32_t samples;
  if (f.read(head, MT_HEADER) != MT_HEADER || !mtHeader(head, f.size(), rate, samples)) { f.close(); return false; }
  MtDecoder d; mtReset(d); int32_t gain = mtGain(cfg.vol);
  static uint8_t in[128]; static int16_t out[256];
  ampOn();
  uint32_t left = samples; bool stopped = false;
  while (left && !stopped) {
    int got = f.read(in, sizeof(in)); if (got <= 0) break;
    size_t n = 0;
    for (int i = 0; i < got && left; i++) {
      out[n++] = mtScale(mtDecodeNibble(d, in[i] & 15), gain); left--;
      if (left) { out[n++] = mtScale(mtDecodeNibble(d, in[i] >> 4), gain); left--; }
    }
    sendSamples(out, n);
    if (!cfg.guard && anyNewPress()) stopped = true;   // with "ignore extra taps" off, a new press cuts in
  }
  f.close(); ampOff();
  return true;
}
void speak(uint8_t key, bool second) {
  uint8_t slot = key + (second ? 4 : 0);
  if (second && !slotHas(slot)) slot = key;
  if (!playSlot(slot)) beep(0);
  lastActive = millis();
  if (cfg.guard) { uint32_t now = millis(); for (uint8_t k = 0; k < 4; k++) { bool d = digitalRead(KEY_PIN[k]) == LOW; if (d && !down[k]) heldSpoken[k] = true; down[k] = d; changedAt[k] = now; } }   // presses made while it was talking are dropped
}

// ---------- Bluetooth ----------
void notify(uint8_t what, uint8_t slot, uint8_t result) {
  if (!chStatus) return;
  uint8_t have = 0; for (uint8_t s = 0; s < 8; s++) if (slotHas(s)) have |= (1 << s);
  uint8_t v[10] = {what, slot, result, FW_MAJOR, FW_MINOR, have, cfg.vol,
                   (uint8_t)((cfg.dbl ? 1 : 0) | (cfg.hold ? 2 : 0) | (cfg.guard ? 4 : 0) | (cfg.sleep ? 8 : 0)), (uint8_t)(cfg.waitMs & 255), (uint8_t)(cfg.waitMs >> 8)};
  chStatus->setValue(v, sizeof(v));
  if (bleLinked) chStatus->notify();
}
class LinkEvents : public BLEServerCallbacks {
  void onConnect(BLEServer *) override { bleLinked = true; }
  void onDisconnect(BLEServer *) override { bleLinked = false; rxSlot = 255; }
};
class CtrlEvents : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *c) override {
    uint8_t *p = c->getData(); size_t n = c->getLength(); if (!p || !n) return;
    if (p[0] == CMD_BEGIN && n >= 10 && p[1] < 8) {
      rxWant = (uint32_t)p[2] | ((uint32_t)p[3] << 8) | ((uint32_t)p[4] << 16) | ((uint32_t)p[5] << 24);
      rxCrc = (uint32_t)p[6] | ((uint32_t)p[7] << 8) | ((uint32_t)p[8] << 16) | ((uint32_t)p[9] << 24);
      rxLen = 0; rxOverflow = false; rxSlot = p[1];
    } else if (p[0] == CMD_END) { doEnd = true; }
    else if (p[0] == CMD_SETTINGS && n >= 5) {
      newCfg.vol = p[1]; newCfg.dbl = p[2] & 1; newCfg.hold = p[2] & 2; newCfg.guard = p[2] & 4; newCfg.sleep = p[2] & 8; newCfg.waitMs = (uint16_t)(p[3] | (p[4] << 8)); doSettings = true;
    } else if (p[0] == CMD_PLAY && n >= 2 && p[1] < 8) { doPlay = p[1]; }
    else if (p[0] == CMD_DELETE && n >= 2 && p[1] < 8) { doDelete = p[1]; }
  }
};
class DataEvents : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *c) override {
    uint8_t *p = c->getData(); size_t n = c->getLength();
    if (!p || !n || rxSlot > 7 || !rxBuf) return;
    if (rxLen + n > MAX_CLIP || rxLen + n > rxWant) { rxOverflow = true; return; }
    memcpy(rxBuf + rxLen, p, n); rxLen += n;
  }
};
void bleStart() {
  if (bleOn) { bleOpenedAt = millis(); return; }
  if (!rxBuf) rxBuf = (uint8_t *)(psramFound() ? ps_malloc(MAX_CLIP) : malloc(MAX_CLIP));
  BLEDevice::init("My Turn band");
  BLEDevice::setMTU(247);
  bleServer = BLEDevice::createServer(); bleServer->setCallbacks(new LinkEvents());
  BLEService *svc = bleServer->createService(UUID_SVC);
  BLECharacteristic *ctrl = svc->createCharacteristic(UUID_CTRL, BLECharacteristic::PROPERTY_WRITE);
  ctrl->setCallbacks(new CtrlEvents());
  BLECharacteristic *data = svc->createCharacteristic(UUID_DATA, BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);
  data->setCallbacks(new DataEvents());
  chStatus = svc->createCharacteristic(UUID_STATUS, BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
  chStatus->addDescriptor(new BLE2902());
  svc->start();
  notify(0, 255, RES_OK);
  BLEAdvertising *adv = BLEDevice::getAdvertising(); adv->addServiceUUID(UUID_SVC); adv->setScanResponse(true);
  BLEDevice::startAdvertising();
  bleOn = true; bleOpenedAt = millis();
  beep(1);
}
void bleStop() {
  if (!bleOn) return;
  BLEDevice::deinit(true); bleOn = false; bleLinked = false; chStatus = nullptr; bleServer = nullptr; rxSlot = 255;
  beep(2);
}
void bleWork() {
  if (!bleOn) return;
  if (doEnd) {
    doEnd = false; uint8_t slot = rxSlot, res = RES_OK; rxSlot = 255;
    uint16_t rate; uint32_t samples;
    if (slot > 7 || rxOverflow || rxLen != rxWant || rxLen < MT_HEADER) res = RES_SIZE;
    else if (mtCrc(rxBuf, rxLen) != rxCrc) res = RES_CRC;
    else if (!mtHeader(rxBuf, rxLen, rate, samples)) res = RES_FORMAT;
    else {
      File f = LittleFS.open("/new.tmp", "w");
      if (!f || f.write(rxBuf, rxLen) != rxLen) res = RES_STORE;
      if (f) f.close();
      if (res == RES_OK) { LittleFS.remove(slotPath(slot)); if (!LittleFS.rename("/new.tmp", slotPath(slot))) res = RES_STORE; }
    }
    notify(CMD_END, slot, res);
    if (res == RES_OK) beep(3);
    bleOpenedAt = millis();
  }
  if (doSettings) {
    doSettings = false;
    if (newCfg.vol >= 1 && newCfg.vol <= 8 && newCfg.waitMs >= 200 && newCfg.waitMs <= 1000) { cfg = newCfg; saveSettings(); notify(CMD_SETTINGS, 255, RES_OK); }
    else notify(CMD_SETTINGS, 255, RES_FORMAT);
    bleOpenedAt = millis();
  }
  if (doDelete >= 0) { uint8_t s = doDelete; doDelete = -1; LittleFS.remove(slotPath(s)); notify(CMD_DELETE, s, RES_OK); bleOpenedAt = millis(); }
  if (doPlay >= 0) { uint8_t s = doPlay; doPlay = -1; if (!playSlot(s)) beep(0); bleOpenedAt = millis(); lastActive = millis(); }
  if (!bleLinked && millis() - bleOpenedAt > PAIR_OPEN_MS) bleStop();
}

// ---------- sleep ----------
void goToSleep() {
  if (i2sOn) { i2s.end(); i2sOn = false; }
  digitalWrite(PIN_AMP, LOW);
  rtc_gpio_init((gpio_num_t)PIN_AMP); rtc_gpio_set_direction((gpio_num_t)PIN_AMP, RTC_GPIO_MODE_OUTPUT_ONLY); rtc_gpio_set_level((gpio_num_t)PIN_AMP, 0); rtc_gpio_hold_en((gpio_num_t)PIN_AMP);   // amplifier stays off while asleep
  uint64_t mask = 0;
  for (int k = 0; k < 4; k++) { mask |= 1ULL << KEY_PIN[k]; rtc_gpio_init((gpio_num_t)KEY_PIN[k]); rtc_gpio_set_direction((gpio_num_t)KEY_PIN[k], RTC_GPIO_MODE_INPUT_ONLY); rtc_gpio_pullup_en((gpio_num_t)KEY_PIN[k]); rtc_gpio_pulldown_dis((gpio_num_t)KEY_PIN[k]); }
  esp_sleep_pd_config(ESP_PD_DOMAIN_RTC_PERIPH, ESP_PD_OPTION_ON);                     // keeps the keys' pull-ups alive
  esp_sleep_enable_ext1_wakeup(mask, ESP_EXT1_WAKEUP_ANY_LOW);
  esp_deep_sleep_start();
}

// ---------- keys ----------
void keyPressed(uint8_t k, uint32_t now) {
  lastActive = now; pressedAt[k] = now; heldSpoken[k] = false;
  bool hasSecond = cfg.dbl && slotHas(k + 4);
  if (!hasSecond) { waitingKey = -1; speak(k, false); return; }
  if (cfg.hold) return;                                    // decided on release, or when the hold time passes
  if (waitingKey == (int8_t)k && now - waitingSince <= cfg.waitMs) { waitingKey = -1; speak(k, true); return; }   // second tap in time
  if (waitingKey >= 0) { uint8_t w = waitingKey; waitingKey = -1; speak(w, false); }                               // a different key: say the one that was waiting first
  waitingKey = k; waitingSince = now;
}
void keyReleased(uint8_t k, uint32_t now) {
  if (cfg.dbl && cfg.hold && slotHas(k + 4) && !heldSpoken[k]) speak(k, false);   // let go before the hold time: first phrase
}
void scanKeys() {
  uint32_t now = millis();
  for (uint8_t k = 0; k < 4; k++) {
    bool d = digitalRead(KEY_PIN[k]) == LOW;
    if (d != down[k] && now - changedAt[k] >= DEBOUNCE_MS) { down[k] = d; changedAt[k] = now; if (d) keyPressed(k, now); else keyReleased(k, now); }
    if (down[k] && cfg.dbl && cfg.hold && !heldSpoken[k] && slotHas(k + 4) && now - pressedAt[k] >= HOLD_MS) { heldSpoken[k] = true; speak(k, true); }
  }
  if (waitingKey >= 0 && millis() - waitingSince > cfg.waitMs) { uint8_t w = waitingKey; waitingKey = -1; speak(w, false); }   // no second tap came
  // green + red held together opens Bluetooth
  if (down[0] && down[1]) {
    if (!comboSince) comboSince = millis();
    if (!comboDone && millis() - comboSince >= PAIR_HOLD_MS) { comboDone = true; bleStart(); }
  } else { comboSince = 0; comboDone = false; }
}

void setup() {
  rtc_gpio_hold_dis((gpio_num_t)PIN_AMP); rtc_gpio_deinit((gpio_num_t)PIN_AMP);
  pinMode(PIN_AMP, OUTPUT); digitalWrite(PIN_AMP, LOW);
  for (int k = 0; k < 4; k++) { rtc_gpio_deinit((gpio_num_t)KEY_PIN[k]); pinMode(KEY_PIN[k], INPUT_PULLUP); }
  LittleFS.begin(true);
  loadSettings();
  lastActive = millis();
  if (esp_sleep_get_wakeup_cause() == ESP_SLEEP_WAKEUP_EXT1) {      // woken by a key: say it straight away
    uint64_t which = esp_sleep_get_ext1_wakeup_status();
    for (uint8_t k = 0; k < 4; k++) if (which & (1ULL << KEY_PIN[k])) { down[k] = true; changedAt[k] = millis(); keyPressed(k, millis()); break; }
  }
}

void loop() {
  scanKeys();
  bleWork();
  if (cfg.sleep && !bleOn && waitingKey < 0 && millis() - lastActive > SLEEP_AFTER_MS) {
    bool anyDown = false; for (int k = 0; k < 4; k++) if (down[k]) anyDown = true;
    if (!anyDown) goToSleep();
  }
  delay(4);
}
