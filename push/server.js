// WC-STATUS push service: polls the sensor server-side, tracks occupancy
// state + transition times, keeps a journal, and when the WC goes
// occupied -> free, sends a one-shot Web Push to everyone who asked to be
// notified. Subscriptions are cleared after firing (no notification spam).
const http = require("http");
const fs = require("fs");
const path = require("path");
const webpush = require("web-push");

const DEVICE = process.env.WC_DEVICE || "192.168.1.60";
const DATA_FILE = process.env.DATA_FILE || "/data/subscriptions.json";
const JOURNAL_FILE = process.env.JOURNAL_FILE || "/data/journal.json";
const PORT = 3000;
const POLL_MS = 3000;
const TIMEOUT_MS = 2000;
const MISSES_FOR_FREE = 3;      // consecutive failed polls before "free"
const FREE_CONFIRM_MS = 3000;   // must STAY free this long before pushing —
                                // a dropped packet or two must never notify
const JOURNAL_MAX = 4000;       // transitions kept on disk (~2 weeks of a busy office)

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
let VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:admin@example.com";
// web-push requires a URL; a bare email address is the common mistake.
if (!/^(mailto:|https?:)/.test(VAPID_SUBJECT)) VAPID_SUBJECT = "mailto:" + VAPID_SUBJECT;

// Bad push config must never take down the state/journal endpoints —
// degrade to push-disabled instead of crash-looping.
let pushEnabled = false;
if (VAPID_PUBLIC && VAPID_PRIVATE) {
  try {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
    pushEnabled = true;
  } catch (e) {
    console.error("invalid VAPID config - push disabled:", e.message);
  }
} else {
  console.warn("VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not set - push disabled");
}

// ---- persistence (survives restarts via the /data volume) ----
let subs = [];
try { subs = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch { /* first run */ }
let journal = []; // [{ts, event: "occupied"|"free"}]
try { journal = JSON.parse(fs.readFileSync(JOURNAL_FILE, "utf8")); } catch { /* first run */ }

function persist(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data));
  } catch (e) {
    console.error(`failed to persist ${file}:`, e.message);
  }
}
const save = () => persist(DATA_FILE, subs);
const saveJournal = () => persist(JOURNAL_FILE, journal);

// ---- sensor poller ----
let occupied = null;     // null = unknown (just started)
let stateSince = null;   // epoch ms when the current state actually began
let misses = 0;
let lastOkTs = null;     // last successful sensor response
let lastStatus = null;   // last sensor JSON ({uptime_ms, rssi, ...})

async function poll() {
  try {
    const res = await fetch(`http://${DEVICE}/status`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error("http " + res.status);
    lastStatus = await res.json();
    lastOkTs = Date.now();
    misses = 0;
    setOccupied(true);
  } catch {
    if (++misses >= MISSES_FOR_FREE) setOccupied(false);
  }
}

// Record a transition. Skips duplicates (e.g. service restart mid-occupancy
// re-detects "occupied") by adopting the existing entry's timestamp instead.
function journalize(event, ts) {
  const last = journal[journal.length - 1];
  if (last && last.event === event) {
    stateSince = last.ts;
    return;
  }
  if (last && ts <= last.ts) ts = last.ts + 1000; // keep timestamps monotonic
  stateSince = ts;
  journal.push({ ts, event });
  if (journal.length > JOURNAL_MAX) journal = journal.slice(-JOURNAL_MAX);
  saveJournal();
}

let freeConfirmTimer = null;

function setOccupied(next) {
  if (occupied === next) return;
  const was = occupied;
  occupied = next;
  console.log("state:", next ? "occupied" : "free");

  if (next === true) {
    if (freeConfirmTimer) {
      // The "free" was sensor packet loss, not a real transition: cancel the
      // pending push and erase the spurious journal entry.
      clearTimeout(freeConfirmTimer);
      freeConfirmTimer = null;
      const last = journal[journal.length - 1];
      if (last && last.event === "free") { journal.pop(); saveJournal(); }
      const prev = journal[journal.length - 1];
      stateSince = prev ? prev.ts : Date.now();
      console.log("false 'free' suppressed (sensor came back)");
      return;
    }
    // Device uptime = time since the light switched on: the true start.
    const bootTs = lastStatus ? Date.now() - lastStatus.uptime_ms : Date.now();
    journalize("occupied", bootTs);
  } else {
    // The light went off just after the last answer we got.
    journalize("free", lastOkTs || Date.now());
    if (was === true) {
      freeConfirmTimer = setTimeout(() => {
        freeConfirmTimer = null;
        if (!occupied) notifyAll();
      }, FREE_CONFIRM_MS);
    }
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

// ---- http api (reached via nginx at /api/*) ----
const server = http.createServer((req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  };

  if (req.method === "GET" && req.url === "/api/state") {
    return send(200, {
      occupied,
      since: stateSince,
      now: Date.now(), // lets clients correct for clock skew
      rssi: occupied && lastStatus ? lastStatus.rssi : null,
    });
  }

  if (req.method === "GET" && req.url === "/api/journal") {
    return send(200, { events: journal.slice(-1000), now: Date.now() });
  }

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
