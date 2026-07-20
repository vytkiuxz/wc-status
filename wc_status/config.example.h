// Copy this file to config.h and fill in the real values.
// config.h is gitignored so credentials never end up in the repo.
#pragma once

#include <IPAddress.h>

// ---- WiFi credentials ----
#define WIFI_SSID "YOUR_WIFI_SSID"
#define WIFI_PASS "YOUR_WIFI_PASSWORD"

// ---- Static IP (must be outside your router's DHCP pool, or reserved for
//      this device) — skipping DHCP saves 0.5-2 s on every boot ----
const IPAddress STATIC_IP(10, 65, 35, 60);
const IPAddress GATEWAY(10, 65, 35, 254);
const IPAddress SUBNET(255, 255, 255, 0);
const IPAddress DNS_SERVER(10, 65, 35, 254);

// How long to trust the cached channel/BSSID before falling back to a full
// scan (covers the case where the router changed channel or was replaced).
#define FAST_CONNECT_TIMEOUT_MS 4000

// If WiFi still isn't up after this long, reboot and try again.
#define TOTAL_CONNECT_TIMEOUT_MS 30000

// Uncomment to get boot timing logs at 115200 baud (adds a few ms to boot).
// #define DEBUG_SERIAL
