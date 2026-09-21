// routes/auth.js
//
// Registrierung, Login, Logout und "wer bin ich gerade" (/me).
// Passwörter werden nie im Klartext gespeichert (scrypt-Hash, siehe
// lib/crypto.js). Nach Register/Login bekommt das Frontend ein
// Sitzungstoken zurück, das es danach bei jeder geschützten Anfrage
// im Header "Authorization: Bearer <token>" mitschickt.

const db = require("../lib/db");
const { sendJson, readJsonBody } = require("../lib/http");
const { hashPassword, verifyPassword, generateSessionToken } = require("../lib/crypto");
const { getUserIdFromRequest } = require("../lib/auth");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function publicUser(row) {
    return { id: row.id, name: row.name, email: row.email };
}

function register(router) {

    router.post("/api/auth/register", async (req, res) => {

        const body = await readJsonBody(req);
        const { name, email, password } = body;

        if (!name || !email || !password) {
            return sendJson(res, 400, { error: "Name, E-Mail und Passwort werden benötigt." });
        }

        if (!EMAIL_RE.test(email)) {
            return sendJson(res, 400, { error: "Bitte eine gültige E-Mail-Adresse angeben." });
        }

        if (password.length < 8) {
            return sendJson(res, 400, { error: "Das Passwort muss mindestens 8 Zeichen lang sein." });
        }

        const normalizedEmail = email.toLowerCase().trim();

        const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(normalizedEmail);

        if (existing) {
            return sendJson(res, 409, { error: "Für diese E-Mail-Adresse existiert bereits ein Account." });
        }

        const passwordHash = hashPassword(password);

        const info = db
            .prepare("INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)")
            .run(name.trim(), normalizedEmail, passwordHash);

        const userId = info.lastInsertRowid;
        const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);

        const token = generateSessionToken();
        db.prepare("INSERT INTO sessions (token, user_id) VALUES (?, ?)").run(token, userId);

        sendJson(res, 201, { token, user: publicUser(user) });

    });

    router.post("/api/auth/login", async (req, res) => {

        const body = await readJsonBody(req);
        const { email, password } = body;

        if (!email || !password) {
            return sendJson(res, 400, { error: "E-Mail und Passwort werden benötigt." });
        }

        const user = db
            .prepare("SELECT * FROM users WHERE email = ?")
            .get(email.toLowerCase().trim());

        if (!user || !verifyPassword(password, user.password_hash)) {
            return sendJson(res, 401, { error: "E-Mail oder Passwort ist falsch." });
        }

        const token = generateSessionToken();
        db.prepare("INSERT INTO sessions (token, user_id) VALUES (?, ?)").run(token, user.id);

        sendJson(res, 200, { token, user: publicUser(user) });

    });

    router.post("/api/auth/logout", async (req, res) => {

        const header = req.headers["authorization"] || "";
        const [, token] = header.split(" ");

        if (token) {
            db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
        }

        sendJson(res, 204);

    });

    router.get("/api/auth/me", async (req, res) => {

        const userId = getUserIdFromRequest(req);

        if (!userId) {
            return sendJson(res, 401, { error: "Nicht angemeldet." });
        }

        const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);

        if (!user) {
            return sendJson(res, 404, { error: "Nutzer nicht gefunden." });
        }

        sendJson(res, 200, { user: publicUser(user) });

    });

}

module.exports = { register };
