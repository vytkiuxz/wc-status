// WC-STATUS push service: polls the sensor server-side, and when the WC goes
// occupied -> free, sends a one-shot Web Push to everyone who asked to be
// notified. Subscriptions are cleared after firing (no notification spam).
const http = require("http");
const fs = require("fs");
const path = require("path");
const webpush = require("web-push");

const DEVICE = process.env.WC_DEVICE || "192.168.1.60";
const DATA_FILE = process.env.DATA_FILE || "/data/subscriptions.json";
const PORT = 3000;
const POLL_MS = 3000;
const TIMEOUT_MS = 2000;
const MISSES_FOR_FREE = 3;      // consecutive failed polls before "free"
const FREE_CONFIRM_MS = 5000;   // must STAY free this long before pushing —
                                // a dropped packet or two must never notify

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:admin@example.com";

let pushEnabled = false;
if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
  pushEnabled = true;
} else {
  console.warn("VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not set - push disabled");
}

// ---- subscription store (survives restarts via the /data volume) ----
let subs = [];
try { subs = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch { /* first run */ }
function save() {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(subs));
  } catch (e) {
    console.error("failed to persist subscriptions:", e.message);
  }
}

// ---- sensor poller ----
let occupied = null; // null = unknown (just started)
let misses = 0;

async function poll() {
  try {
    const res = await fetch(`http://${DEVICE}/status`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error("http " + res.status);
    await res.json();
    misses = 0;
    setOccupied(true);
  } catch {
    if (++misses >= MISSES_FOR_FREE) setOccupied(false);
  }
}

let freeConfirmTimer = null;

function setOccupied(next) {
  if (occupied === next) return;
  const was = occupied;
  occupied = next;
  console.log("state:", next ? "occupied" : "free");
  if (was === true && next === false) {
    // Don't push yet: the sensor may just have dropped a few packets (weak
    // signal). Only notify if it stays free for the whole confirm window.
    clearTimeout(freeConfirmTimer);
    freeConfirmTimer = setTimeout(() => {
      freeConfirmTimer = null;
      if (!occupied) notifyAll();
    }, FREE_CONFIRM_MS);
  } else if (next === true && freeConfirmTimer) {
    clearTimeout(freeConfirmTimer);
    freeConfirmTimer = null;
    console.log("false 'free' suppressed (sensor came back)");
  }
}

async function notifyAll() {
  if (!pushEnabled || subs.length === 0) return;
  const batch = subs;
  subs = []; // one-shot: everyone who asked gets exactly one ping
  save();
  const payload = JSON.stringify({ title: "🟢 WC is free!", body: "Go go go 🏃", badge: 0 });
  let ok = 0;
  for (const sub of batch) {
    try {
      await webpush.sendNotification(sub, payload, { TTL: 300 });
      ok++;
    } catch (e) {
      // 404/410 = subscription expired; anything else is transient
      console.warn("push failed:", e.statusCode || e.message);
    }
  }
  console.log(`pushed to ${ok}/${batch.length} subscriber(s)`);
}

setInterval(poll, POLL_MS);
poll();

// ---- http api (reached via nginx at /api/push/*) ----
const server = http.createServer((req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  };

  if (req.method === "GET" && req.url === "/api/push/key") {
    return pushEnabled ? send(200, { key: VAPID_PUBLIC }) : send(503, { error: "push disabled" });
  }

  if (req.method === "POST" && req.url === "/api/push/subscribe") {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 10_000) req.destroy();
    });
    req.on("end", () => {
      if (!pushEnabled) return send(503, { error: "push disabled" });
      try {
        const sub = JSON.parse(body);
        if (!sub || typeof sub.endpoint !== "string" || !sub.endpoint.startsWith("https://")) {
          return send(400, { error: "invalid subscription" });
        }
        if (!subs.some((s) => s.endpoint === sub.endpoint)) {
          subs.push(sub);
          save();
        }
        send(201, { armed: true });
      } catch {
        send(400, { error: "bad json" });
      }
    });
    return;
  }

  send(404, { error: "not found" });
});

server.listen(PORT, () => console.log(`push service on :${PORT}, watching sensor at ${DEVICE}`));
