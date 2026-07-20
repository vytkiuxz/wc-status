// WC occupancy sensor for ESP8266.
//
// The board is powered from the WC light circuit, so:
//   - board has power  -> light is on  -> WC is occupied
//   - board is off     -> light is off -> WC is free
//
// Every occupancy event is therefore a cold boot, and the whole design
// optimizes boot-to-WiFi time:
//   1. Static IP           -> skips DHCP negotiation
//   2. Cached channel+BSSID (stored in flash after first connect)
//                          -> skips the WiFi scan on every later boot
//   3. No modem sleep      -> API responds instantly
//
// The poller treats "GET /status answers" as occupied and "connection
// timeout" as free.

#include <ESP8266WiFi.h>
#include <ESP8266WebServer.h>
#include <EEPROM.h>
#include "config.h"

#ifdef DEBUG_SERIAL
  #define LOG(...) Serial.printf(__VA_ARGS__)
#else
  #define LOG(...)
#endif

// Cached AP parameters, persisted in flash so they survive power-off.
struct WifiCache {
  uint32_t magic;
  uint8_t channel;
  uint8_t bssid[6];
};
static const uint32_t CACHE_MAGIC = 0x57C0FFEE;

ESP8266WebServer server(80);
static unsigned long bootToWifiMs = 0;

static void handleStatus() {
  char buf[128];
  snprintf(buf, sizeof(buf),
           "{\"occupied\":true,\"uptime_ms\":%lu,\"boot_to_wifi_ms\":%lu,\"rssi\":%d}",
           millis(), bootToWifiMs, WiFi.RSSI());
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Cache-Control", "no-store");
  server.send(200, "application/json", buf);
}

void setup() {
#ifdef DEBUG_SERIAL
  Serial.begin(115200);
#endif

  // Don't let the SDK write WiFi config to flash on every begin() — we manage
  // our own cache, and flash writes slow things down and wear the chip.
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.setSleepMode(WIFI_NONE_SLEEP);
  WiFi.config(STATIC_IP, GATEWAY, SUBNET, DNS_SERVER);

  EEPROM.begin(sizeof(WifiCache));
  WifiCache cache;
  EEPROM.get(0, cache);

  bool fastPath = (cache.magic == CACHE_MAGIC);
  if (fastPath) {
    LOG("Fast connect: ch %u\n", cache.channel);
    WiFi.begin(WIFI_SSID, WIFI_PASS, cache.channel, cache.bssid, true);
  } else {
    LOG("First boot: full scan connect\n");
    WiFi.begin(WIFI_SSID, WIFI_PASS);
  }

  const unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED) {
    // Cached channel/BSSID may be stale (router changed channel or was
    // replaced) — give up on it quickly and do a normal scan connect.
    if (fastPath && millis() - start > FAST_CONNECT_TIMEOUT_MS) {
      LOG("Fast connect failed, falling back to scan\n");
      fastPath = false;
      WiFi.disconnect();
      WiFi.begin(WIFI_SSID, WIFI_PASS);
    }
    if (millis() - start > TOTAL_CONNECT_TIMEOUT_MS) {
      ESP.restart();
    }
    delay(10);
  }
  bootToWifiMs = millis();
  LOG("Connected in %lu ms, IP %s\n", bootToWifiMs, WiFi.localIP().toString().c_str());

  // Refresh the cache so the next cold boot takes the fast path.
  WifiCache fresh;
  fresh.magic = CACHE_MAGIC;
  fresh.channel = WiFi.channel();
  memcpy(fresh.bssid, WiFi.BSSID(), sizeof(fresh.bssid));
  if (memcmp(&fresh, &cache, sizeof(fresh)) != 0) {
    EEPROM.put(0, fresh);
    EEPROM.commit();
    LOG("WiFi cache updated\n");
  }

  server.on("/", handleStatus);
  server.on("/status", handleStatus);
  server.onNotFound([]() {
    server.send(404, "application/json", "{\"error\":\"not found\"}");
  });
  server.begin();
}

void loop() {
  server.handleClient();
}
