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

Open it straight from disk (double-click, polls the sensor directly — LAN
only) or host it with the Docker stack below, which also works over **https**:
nginx proxies `/api/status` to the sensor server-side, so the browser only
ever talks to the page's own origin (no CORS / mixed-content / local-network
blocking).

False-positive protection (weak WiFi means the sensor sometimes drops a few
polls in a row): three consecutive missed polls are needed before anything
reads "free"; nginx micro-caches sensor responses for 2 s so many viewers
don't overload the ESP8266; and the push service additionally requires the
state to *stay* free for 8 s before notifying — if the sensor comes back
mid-window, the push is cancelled and the subscription kept for the genuine
transition. A false "WC is free" push needs ~17-20 s of unbroken silence.

### Install as an app (PWA)

The page is an installable PWA (manifest + service worker + icons). From
`https://wc.sias.lt` use the browser's install option (desktop Chrome/Edge:
install icon in the address bar; Android Chrome: "Add to Home screen"; iOS
Safari: Share → "Add to Home Screen").

**Icon badge** — while the installed app is running (a window open or
minimized), the app icon shows a badge when the WC is occupied and clears it
when free:

| Platform | Badge support |
|---|---|
| Windows / macOS (Chrome or Edge, installed) | ✅ taskbar/dock badge via the App Badging API |
| iOS / iPadOS 16.4+ (added to Home Screen) | ✅ home-screen badge — tap "Notify me" once to grant notification permission, which unlocks badging |
| Android (Chrome) | ❌ no App Badging API — use the "🔔 Notify me when it's free" button instead; the notification also puts a dot on the app icon |

The "🔔 Notify me when it's free" button appears whenever the WC is occupied
(on every platform): tap it and you get a one-shot notification the moment it
frees up.

**Web Push**: the "🔔 Notify me" button prefers a real push subscription
(handled by the `wc-status-push` container), which fires **even after you
close the app or lock your phone** — one ping when the WC frees up, then the
subscription is cleared (no spam). If the push service is missing or VAPID
keys aren't configured, the button silently falls back to a local
notification that only works while the page stays open.

Push requirements: VAPID keys in the stack env (see
[.env.example](.env.example)), outbound internet from the Docker host (pushes
are delivered via Google/Apple/Mozilla push services; payloads are
end-to-end encrypted), and on iOS 16.4+ the app must be added to the Home
Screen. The live badge (occupied → dot) still only updates while the app is
running — browsers require every push to show a notification, so silently
flipping the badge on each light toggle from the server isn't allowed.

### Hosting with Docker / Portainer

[docker-compose.yml](docker-compose.yml) runs two containers:

- **wc-status-web** — nginx serving the page on port **8080**, proxying
  `/api/status` to the sensor and `/api/push/*` to the push service
- **wc-status-push** — Node service ([push/server.js](push/server.js)) that
  polls the sensor 24/7 and sends the one-shot "WC is free" Web Push;
  subscriptions persist in the `push-data` volume

Configuration comes from env vars (`WC_DEVICE`, `VAPID_PUBLIC_KEY`,
`VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` — see [.env.example](.env.example)); in
Portainer set them as stack environment variables. The Docker host must be
able to reach the sensor's IP. Putting a TLS-terminating reverse proxy in
front (e.g. for `https://wc.…`) works fine.

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
