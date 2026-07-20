# WC-STATUS

ESP8266 firmware that reports whether the WC is occupied. The board is powered
from the WC light circuit, so the logic is dead simple:

- **Board reachable** → light is on → **occupied**
- **Board unreachable** (request times out) → light is off → **free**

## How it boots fast

Every time someone turns the light on, the board cold-boots, so boot-to-WiFi
time is the whole game:

| Trick | Saves |
|---|---|
| Static IP (no DHCP) | ~0.5–2 s |
| Cached AP channel + BSSID in flash (no WiFi scan) | ~1–2 s |
| No modem sleep | instant API responses |

First boot does a full scan (~4–7 s total) and caches the router's channel and
BSSID in flash. Every boot after that connects directly (typically **~1–2 s**
from power-on to API up). If the router later changes channel, the fast path
times out after 4 s and it falls back to a scan, then re-caches.

## Setup

1. Edit [wc_status/config.h](wc_status/config.h):
   - WiFi SSID + password
   - Static IP — pick one outside your router's DHCP pool (or add a DHCP
     reservation for the board's MAC), and match the gateway/subnet to your
     network.
2. Flash, either way:
   - **PlatformIO**: set your board in [platformio.ini](platformio.ini)
     (`nodemcuv2`, `d1_mini`, …), then `pio run -t upload`
   - **Arduino IDE**: install ESP8266 board support (Boards Manager URL
     `https://arduino.esp8266.com/stable/package_esp8266com_index.json`),
     open `wc_status/wc_status.ino`, select your board, upload.
3. Power the board from the light circuit via a small 5 V USB power supply
   wired in parallel with the lamp.

## API

```
GET http://192.168.1.60/status
```

```json
{"occupied": true, "uptime_ms": 84213, "boot_to_wifi_ms": 1420, "rssi": -58}
```

`/` returns the same. CORS is open (`Access-Control-Allow-Origin: *`) so a
browser dashboard can poll it directly.

## Status page

[web/index.html](web/index.html) is a self-contained page that polls the sensor
every 3 s and shows a big friendly status: red 🚽 "Occupied" with a running
timer (from the sensor's uptime), green 🚪 "Free!" with confetti on the
occupied→free transition, plus a sensor-online indicator and the tab
title/emoji updating so you can pin the tab and see the status at a glance.

Open it straight from disk (double-click) or host it on any **plain-http**
server on the office network. Don't serve it over https — browsers block a
https page from calling the sensor's http endpoint (mixed content). Two
consecutive missed polls count as "free", so a single dropped packet doesn't
flicker the status.

### Hosting with Docker / Portainer

[docker-compose.yml](docker-compose.yml) builds a tiny nginx image
([web/Dockerfile](web/Dockerfile)) that serves the page on port **8080**
(plain http, which is required — see above).

Portainer needs the build context (`web/index.html`), not just the compose
file, so deploy one of these ways:

- **Repository (recommended)**: push this project to your git server, then in
  Portainer: *Stacks → Add stack → Repository*, paste the repo URL, set
  *Compose path* to `docker-compose.yml`, deploy. Re-deploying the stack picks
  up page updates.
- **On the Docker host**: copy the project folder to the server and run
  `docker compose up -d --build` there (Portainer will show it as a running
  container either way).

Plain *Web editor / Upload* won't work as-is because it only ships the compose
file without `web/`.

### Polling from your side

Use a short timeout and map it to "free":

```bash
curl -s --connect-timeout 2 http://192.168.1.60/status || echo '{"occupied": false}'
```

Note: the first ~2 s after the light turns on the board is still booting, so a
poll in that window reads "free". With a 5–10 s poll interval this is
invisible in practice.
