// server.js  -  Movalia-Backend (alles in EINER Datei, keine npm-Pakete nötig)
//
// Enthält: Website ausliefern (public/index.html), Accounts mit
// E-Mail-Bestätigung per 6-stelligem Code, Login/Logout, Passwort
// vergessen/ändern, Arbeitsprofil, Tagebuch und Gesundheitsschirm.
//
// Start:  node server.js        (Node 22.5 oder neuer)
//
// Einstellungen (alle optional, bei Render unter "Environment"):
//   RESEND_API_KEY          Schlüssel von resend.com, damit E-Mails verschickt werden
//   MAIL_FROM               Absender, z. B.  Movalia <hallo@deine-domain.de>
//                           (ohne eigene Domain: onboarding@resend.dev - dann
//                           kommen Mails aber NUR bei der Adresse an, mit der
//                           du dich bei Resend angemeldet hast)
//   SHOW_CODE_IN_RESPONSE   "true" = Testmodus: der Code wird zusätzlich auf der
//                           Webseite angezeigt (nur zum Ausprobieren!)
//   PUBLIC_URL              Adresse der Seite, z. B. https://moviq-mqv9.onrender.com
//   DATA_DIR                Ordner für die Datenbank (Standard: ./data)
//   PORT                    Standard 3000

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const PUBLIC_URL = (process.env.PUBLIC_URL || "https://moviq-mqv9.onrender.com").replace(/\/$/, "");
const MAIL_FROM = process.env.MAIL_FROM || "Movalia <onboarding@resend.dev>";
const SHOW_CODE = String(process.env.SHOW_CODE_IN_RESPONSE || "").toLowerCase() === "true";

const CODE_TTL_MS = 15 * 60 * 1000;      // Code 15 Minuten gültig
const CODE_MAX_TRIES = 5;                // 5 Fehlversuche, dann neuer Code nötig
const RESEND_COOLDOWN_MS = 30 * 1000;    // frühestens alle 30 s ein neuer Code
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;

/* ---------------------------------------------------------------
   Datenbank
--------------------------------------------------------------- */

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, "movalia.db"));

db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        name          TEXT NOT NULL,
        email         TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        verified      INTEGER NOT NULL DEFAULT 0,
        code_hash     TEXT,
        code_expires  INTEGER,
        code_tries    INTEGER NOT NULL DEFAULT 0,
        code_sent_at  INTEGER NOT NULL DEFAULT 0,
        reset_hash    TEXT,
        reset_expires INTEGER,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS work_profiles (
        user_id      INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        field        TEXT NOT NULL,
        profession   TEXT NOT NULL,
        workload     TEXT NOT NULL,
        weekly_hours REAL NOT NULL,
        areas_json   TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS diary_entries (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        entry_date  TEXT NOT NULL,
        vas         INTEGER NOT NULL,
        development TEXT NOT NULL DEFAULT '',
        actions     TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS wheel (
        user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        values_json TEXT NOT NULL
    );
`);

/* ---------------------------------------------------------------
   Hilfsfunktionen
--------------------------------------------------------------- */

const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(password, salt, 64);
    return salt.toString("hex") + ":" + hash.toString("hex");
}

function checkPassword(password, stored) {
    const [saltHex, hashHex] = String(stored).split(":");
    if (!saltHex || !hashHex) return false;
    const expected = Buffer.from(hashHex, "hex");
    const actual = crypto.scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
    return crypto.timingSafeEqual(expected, actual);
}

function newCode() {
    return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}

function safeEqualHex(a, b) {
    const x = Buffer.from(String(a)), y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function publicUser(u) {
    return { id: u.id, name: u.name, email: u.email };
}

function isEmail(s) {
    return typeof s === "string" && s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

class HttpError extends Error {
    constructor(status, message, code) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

function send(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
    });
    res.end(body);
}

function readJson(req) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on("data", (c) => {
            size += c.length;
            if (size > 200 * 1024) {
                reject(new HttpError(413, "Anfrage zu groß."));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on("end", () => {
            if (!chunks.length) return resolve({});
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch (e) {
                reject(new HttpError(400, "Ungültige Anfrage."));
            }
        });
        req.on("error", reject);
    });
}

/* Sehr einfache Bremse gegen Durchprobieren (pro IP und Aktion). */
const hits = new Map();
function rateLimit(req, action, max, windowMs) {
    const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
    const key = action + "|" + ip;
    const now = Date.now();
    const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (list.length >= max) {
        throw new HttpError(429, "Zu viele Versuche. Bitte warte einen Moment und versuche es dann erneut.");
    }
    list.push(now);
    hits.set(key, list);
}
setInterval(() => {
    const now = Date.now();
    for (const [k, list] of hits) {
        if (!list.some((t) => now - t < 3600 * 1000)) hits.delete(k);
    }
}, 10 * 60 * 1000).unref();

/* ---------------------------------------------------------------
   E-Mail (über Resend, ohne npm-Paket)
--------------------------------------------------------------- */

async function sendMail(to, subject, text, html) {
    const key = process.env.RESEND_API_KEY;
    if (!key) {
        console.log("[MAIL - kein RESEND_API_KEY gesetzt, nichts verschickt] An: " + to + " | " + subject + "\n" + text);
        return { sent: false };
    }
    try {
        const r = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
            body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, text, html })
        });
        if (!r.ok) {
            console.log("[MAIL-FEHLER] Resend antwortete " + r.status + ": " + (await r.text()));
            return { sent: false };
        }
        return { sent: true };
    } catch (e) {
        console.log("[MAIL-FEHLER] " + e.message);
        return { sent: false };
    }
}

function mailShell(inner) {
    return '<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#25302A">' +
        '<p style="font-size:20px;font-weight:700;color:#1D4538;letter-spacing:.04em">MOVALIA</p>' +
        inner +
        '<p style="color:#6b756f;font-size:12px;margin-top:28px">Wenn du das nicht angefordert hast, kannst du diese E-Mail ignorieren.</p></div>';
}

// Erzeugt einen neuen Code, speichert nur dessen Hash und verschickt ihn.
async function issueCode(user) {
    const code = newCode();
    db.prepare("UPDATE users SET code_hash=?, code_expires=?, code_tries=0, code_sent_at=? WHERE id=?")
        .run(sha256(code + ":" + user.id), Date.now() + CODE_TTL_MS, Date.now(), user.id);

    const mail = await sendMail(
        user.email,
        "Dein Movalia-Code: " + code,
        "Hallo " + user.name + ",\n\ndein Bestätigungscode für Movalia lautet:\n\n    " + code +
        "\n\nGib ihn auf der Webseite ein. Der Code ist 15 Minuten gültig.\n",
        mailShell(
            "<p>Hallo " + escapeHtml(user.name) + ",</p>" +
            "<p>dein Bestätigungscode für Movalia lautet:</p>" +
            '<p style="font-size:34px;font-weight:700;letter-spacing:.3em;color:#1D4538;margin:18px 0">' + code + "</p>" +
            "<p>Gib ihn auf der Webseite ein. Der Code ist 15 Minuten gültig.</p>"
        )
    );

    const out = { mailSent: mail.sent };
    if (SHOW_CODE) out.devCode = code;
    return out;
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function createSession(userId) {
    const token = crypto.randomBytes(32).toString("hex");
    db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)")
        .run(sha256(token), userId, Date.now() + SESSION_TTL_MS);
    return token;
}

function authUser(req) {
    const h = req.headers["authorization"] || "";
    const m = /^Bearer ([a-f0-9]{64})$/.exec(h);
    if (!m) throw new HttpError(401, "Bitte melde dich an.", "UNAUTHORIZED");
    const row = db.prepare(
        "SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.verified=1"
    ).get(sha256(m[1]), Date.now());
    if (!row) throw new HttpError(401, "Bitte melde dich erneut an.", "UNAUTHORIZED");
    return row;
}

/* ---------------------------------------------------------------
   API-Routen
--------------------------------------------------------------- */

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

const normEmail = (e) => String(e || "").trim().toLowerCase();

route("GET", /^\/api\/health$/, async () => ({ status: 200, body: { status: "ok" } }));

// Account anlegen -> Code per E-Mail, noch KEINE Anmeldung
route("POST", /^\/api\/auth\/register$/, async (req, res, m, body) => {
    rateLimit(req, "register", 10, 3600 * 1000);
    const name = String(body.name || "").trim();
    const email = normEmail(body.email);
    const password = String(body.password || "");

    if (name.length < 1 || name.length > 80) throw new HttpError(400, "Bitte gib deinen Namen an.");
    if (!isEmail(email)) throw new HttpError(400, "Bitte gib eine gültige E-Mail-Adresse an.");
    if (password.length < 8 || password.length > 200) throw new HttpError(400, "Das Passwort braucht mindestens 8 Zeichen.");

    const existing = db.prepare("SELECT * FROM users WHERE email=?").get(email);
    if (existing && existing.verified) {
        throw new HttpError(409, "Für diese E-Mail-Adresse gibt es schon einen Account. Bitte logge dich ein.");
    }

    let user;
    if (existing) {
        db.prepare("UPDATE users SET name=?, password_hash=? WHERE id=?").run(name, hashPassword(password), existing.id);
        user = db.prepare("SELECT * FROM users WHERE id=?").get(existing.id);
    } else {
        const info = db.prepare("INSERT INTO users (name,email,password_hash) VALUES (?,?,?)")
            .run(name, email, hashPassword(password));
        user = db.prepare("SELECT * FROM users WHERE id=?").get(Number(info.lastInsertRowid));
    }

    const issued = await issueCode(user);
    return { status: 201, body: Object.assign({ needsVerification: true, email }, issued) };
});

// Code eingeben -> Account freigeschaltet + angemeldet
route("POST", /^\/api\/auth\/verify-code$/, async (req, res, m, body) => {
    rateLimit(req, "verify", 30, 3600 * 1000);
    const email = normEmail(body.email);
    const code = String(body.code || "").replace(/\s+/g, "");
    if (!/^\d{6}$/.test(code)) throw new HttpError(400, "Bitte gib den 6-stelligen Code ein.");

    const user = db.prepare("SELECT * FROM users WHERE email=?").get(email);
    const bad = new HttpError(400, "Der Code ist nicht richtig oder abgelaufen.", "BAD_CODE");
    if (!user || !user.code_hash || !user.code_expires) throw bad;
    if (Date.now() > user.code_expires) throw new HttpError(400, "Der Code ist abgelaufen. Bitte fordere einen neuen an.", "CODE_EXPIRED");
    if (user.code_tries >= CODE_MAX_TRIES) {
        throw new HttpError(429, "Zu viele falsche Eingaben. Bitte fordere einen neuen Code an.", "CODE_LOCKED");
    }

    if (!safeEqualHex(sha256(code + ":" + user.id), user.code_hash)) {
        db.prepare("UPDATE users SET code_tries=code_tries+1 WHERE id=?").run(user.id);
        const left = CODE_MAX_TRIES - user.code_tries - 1;
        throw new HttpError(400, left > 0
            ? "Der Code ist nicht richtig. Noch " + left + " Versuch" + (left === 1 ? "" : "e") + "."
            : "Der Code ist nicht richtig. Bitte fordere einen neuen Code an.", "BAD_CODE");
    }

    db.prepare("UPDATE users SET verified=1, code_hash=NULL, code_expires=NULL, code_tries=0 WHERE id=?").run(user.id);
    return { status: 200, body: { token: createSession(user.id), user: publicUser(user) } };
});

// Neuen Code anfordern
route("POST", /^\/api\/auth\/resend-code$/, async (req, res, m, body) => {
    rateLimit(req, "resend", 10, 3600 * 1000);
    const email = normEmail(body.email);
    const user = db.prepare("SELECT * FROM users WHERE email=? AND verified=0").get(email);
    const generic = { message: "Wenn die Adresse bei uns wartet, ist ein neuer Code unterwegs." };
    if (!user) return { status: 200, body: generic };

    const wait = user.code_sent_at + RESEND_COOLDOWN_MS - Date.now();
    if (wait > 0) {
        throw new HttpError(429, "Bitte warte noch " + Math.ceil(wait / 1000) + " Sekunden, bevor du einen neuen Code anforderst.", "COOLDOWN");
    }
    const issued = await issueCode(user);
    return { status: 200, body: Object.assign({ message: "Ein neuer Code wurde gesendet." }, issued) };
});

route("POST", /^\/api\/auth\/login$/, async (req, res, m, body) => {
    rateLimit(req, "login", 20, 15 * 60 * 1000);
    const email = normEmail(body.email);
    const password = String(body.password || "");
    const user = db.prepare("SELECT * FROM users WHERE email=?").get(email);

    const ok = user ? checkPassword(password, user.password_hash)
                    : (checkPassword(password, hashPassword("dummy")), false);
    if (!ok) throw new HttpError(401, "E-Mail oder Passwort stimmt nicht.");

    if (!user.verified) {
        throw new HttpError(403, "Deine E-Mail-Adresse ist noch nicht bestätigt.", "EMAIL_NOT_VERIFIED");
    }
    return { status: 200, body: { token: createSession(user.id), user: publicUser(user) } };
});

route("GET", /^\/api\/auth\/me$/, async (req) => {
    return { status: 200, body: { user: publicUser(authUser(req)) } };
});

route("POST", /^\/api\/auth\/logout$/, async (req) => {
    const m = /^Bearer ([a-f0-9]{64})$/.exec(req.headers["authorization"] || "");
    if (m) db.prepare("DELETE FROM sessions WHERE token_hash=?").run(sha256(m[1]));
    return { status: 200, body: { success: true } };
});

route("POST", /^\/api\/auth\/change-password$/, async (req, res, m, body) => {
    const user = authUser(req);
    const current = String(body.currentPassword || "");
    const next = String(body.newPassword || "");
    if (!checkPassword(current, user.password_hash)) throw new HttpError(400, "Das aktuelle Passwort stimmt nicht.");
    if (next.length < 8 || next.length > 200) throw new HttpError(400, "Das neue Passwort braucht mindestens 8 Zeichen.");
    db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(hashPassword(next), user.id);
    return { status: 200, body: { success: true } };
});

// Passwort vergessen: Link per E-Mail
route("POST", /^\/api\/auth\/request-password-reset$/, async (req, res, m, body) => {
    rateLimit(req, "reset", 5, 3600 * 1000);
    const email = normEmail(body.email);
    const generic = { message: "Wenn es zu dieser Adresse einen Account gibt, haben wir dir eine E-Mail mit einem Link geschickt." };
    const user = db.prepare("SELECT * FROM users WHERE email=? AND verified=1").get(email);
    if (!user) return { status: 200, body: generic };

    const token = crypto.randomBytes(32).toString("hex");
    db.prepare("UPDATE users SET reset_hash=?, reset_expires=? WHERE id=?").run(sha256(token), Date.now() + RESET_TTL_MS, user.id);
    const link = PUBLIC_URL + "/?reset=" + token;
    await sendMail(
        user.email,
        "Movalia: Passwort zurücksetzen",
        "Hallo " + user.name + ",\n\nüber diesen Link kannst du ein neues Passwort vergeben (1 Stunde gültig):\n" + link + "\n",
        mailShell("<p>Hallo " + escapeHtml(user.name) + ",</p><p>über diesen Link kannst du ein neues Passwort vergeben (1 Stunde gültig):</p>" +
            '<p><a href="' + link + '" style="color:#2E6A53">Neues Passwort festlegen</a></p>')
    );
    return { status: 200, body: generic };
});

route("POST", /^\/api\/auth\/reset-password$/, async (req, res, m, body) => {
    rateLimit(req, "reset2", 20, 3600 * 1000);
    const token = String(body.token || "");
    const password = String(body.password || "");
    if (password.length < 8 || password.length > 200) throw new HttpError(400, "Das Passwort braucht mindestens 8 Zeichen.");
    const user = db.prepare("SELECT * FROM users WHERE reset_hash=? AND reset_expires>?").get(sha256(token), Date.now());
    if (!user) throw new HttpError(400, "Der Link ist ungültig oder abgelaufen. Bitte fordere einen neuen an.");
    db.prepare("UPDATE users SET password_hash=?, reset_hash=NULL, reset_expires=NULL WHERE id=?").run(hashPassword(password), user.id);
    db.prepare("DELETE FROM sessions WHERE user_id=?").run(user.id);
    return { status: 200, body: { success: true } };
});

/* ---- Arbeitsprofil ---- */

route("GET", /^\/api\/profile$/, async (req) => {
    const u = authUser(req);
    const p = db.prepare("SELECT * FROM work_profiles WHERE user_id=?").get(u.id);
    return {
        status: 200,
        body: { profile: p ? {
            field: p.field, profession: p.profession, workload: p.workload,
            weeklyHours: p.weekly_hours, strainedAreas: JSON.parse(p.areas_json)
        } : null }
    };
});

route("PUT", /^\/api\/profile$/, async (req, res, m, body) => {
    const u = authUser(req);
    const field = String(body.field || "").slice(0, 120);
    const profession = String(body.profession || "").slice(0, 120);
    const workload = String(body.workload || "").slice(0, 40);
    const hours = Number(body.weeklyHours);
    const areas = Array.isArray(body.strainedAreas) ? body.strainedAreas.slice(0, 40).map((a) => String(a).slice(0, 60)) : [];
    if (!field || !profession || !workload || !isFinite(hours) || hours < 0 || hours > 168) {
        throw new HttpError(400, "Bitte fülle alle Felder aus.");
    }
    db.prepare(`INSERT INTO work_profiles (user_id,field,profession,workload,weekly_hours,areas_json)
                VALUES (?,?,?,?,?,?)
                ON CONFLICT(user_id) DO UPDATE SET field=excluded.field, profession=excluded.profession,
                workload=excluded.workload, weekly_hours=excluded.weekly_hours, areas_json=excluded.areas_json`)
        .run(u.id, field, profession, workload, hours, JSON.stringify(areas));
    return { status: 200, body: { profile: { field, profession, workload, weeklyHours: hours, strainedAreas: areas } } };
});

/* ---- Tagebuch ---- */

const diaryOut = (r) => ({ id: String(r.id), date: r.entry_date, vas: r.vas, development: r.development, actions: r.actions });

route("GET", /^\/api\/diary$/, async (req) => {
    const u = authUser(req);
    const rows = db.prepare("SELECT * FROM diary_entries WHERE user_id=? ORDER BY entry_date DESC, id DESC").all(u.id);
    return { status: 200, body: { entries: rows.map(diaryOut) } };
});

route("POST", /^\/api\/diary$/, async (req, res, m, body) => {
    const u = authUser(req);
    const date = String(body.date || "");
    const vas = Math.round(Number(body.vas));
    const development = String(body.development || "").slice(0, 5000);
    const actions = String(body.actions || "").slice(0, 5000);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !(vas >= 0 && vas <= 10) || !development.trim()) {
        throw new HttpError(400, "Bitte Datum, Schmerzwert und Verlauf ausfüllen.");
    }
    const info = db.prepare("INSERT INTO diary_entries (user_id,entry_date,vas,development,actions) VALUES (?,?,?,?,?)")
        .run(u.id, date, vas, development, actions);
    const row = db.prepare("SELECT * FROM diary_entries WHERE id=?").get(Number(info.lastInsertRowid));
    return { status: 201, body: { entry: diaryOut(row) } };
});

route("DELETE", /^\/api\/diary\/([^/]+)$/, async (req, res, m) => {
    const u = authUser(req);
    db.prepare("DELETE FROM diary_entries WHERE id=? AND user_id=?").run(Number(decodeURIComponent(m[1])) || -1, u.id);
    return { status: 200, body: { success: true } };
});

/* ---- Gesundheitsschirm ---- */

route("GET", /^\/api\/wheel$/, async (req) => {
    const u = authUser(req);
    const r = db.prepare("SELECT values_json FROM wheel WHERE user_id=?").get(u.id);
    return { status: 200, body: { values: r ? JSON.parse(r.values_json) : null } };
});

route("PUT", /^\/api\/wheel$/, async (req, res, m, body) => {
    const u = authUser(req);
    const json = JSON.stringify(body.values === undefined ? null : body.values);
    if (json.length > 100 * 1024) throw new HttpError(413, "Zu viele Daten.");
    db.prepare(`INSERT INTO wheel (user_id,values_json) VALUES (?,?)
                ON CONFLICT(user_id) DO UPDATE SET values_json=excluded.values_json`).run(u.id, json);
    return { status: 200, body: { success: true } };
});

/* ---------------------------------------------------------------
   Website ausliefern
--------------------------------------------------------------- */

const MIME = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg",
    ".svg": "image/svg+xml", ".ico": "image/x-icon", ".glb": "model/gltf-binary",
    ".json": "application/json; charset=utf-8", ".mp4": "video/mp4"
};

function serveStatic(req, res, pathname) {
    if (req.method !== "GET" && req.method !== "HEAD") return false;
    let rel;
    try { rel = decodeURIComponent(pathname); } catch (e) { return false; }
    if (rel === "/" || rel === "") rel = "/index.html";
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return false;
    let stat;
    try { stat = fs.statSync(file); } catch (e) { return false; }
    if (!stat.isFile()) return false;
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
        "Content-Type": MIME[ext] || "application/octet-stream",
        "Content-Length": stat.size,
        "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600"
    });
    if (req.method === "HEAD") return res.end(), true;
    fs.createReadStream(file).pipe(res);
    return true;
}

/* ---------------------------------------------------------------
   Server
--------------------------------------------------------------- */

const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", CORS_ORIGIN);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("X-Content-Type-Options", "nosniff");

    if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

    const pathname = req.url.split("?")[0];

    if (pathname.startsWith("/api/")) {
        try {
            const r = routes.find((x) => x.method === req.method && x.pattern.test(pathname));
            if (!r) return send(res, 404, { error: "Nicht gefunden." });
            const body = (req.method === "POST" || req.method === "PUT") ? await readJson(req) : {};
            const out = await r.handler(req, res, r.pattern.exec(pathname), body);
            return send(res, out.status, out.body);
        } catch (e) {
            if (e instanceof HttpError) {
                return send(res, e.status, e.code ? { error: e.message, code: e.code } : { error: e.message });
            }
            console.log("[FEHLER]", e);
            return send(res, 500, { error: "Interner Fehler. Bitte versuche es später erneut." });
        }
    }

    if (serveStatic(req, res, pathname)) return;
    send(res, 404, { error: "Nicht gefunden." });
});

server.listen(PORT, () => {
    console.log("Movalia-Backend läuft auf http://localhost:" + PORT +
        (process.env.RESEND_API_KEY ? "" : "  (ohne RESEND_API_KEY: Codes erscheinen nur hier im Log)"));
});
