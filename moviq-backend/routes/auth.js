// routes/auth.js
//
// Registrierung, E-Mail-Bestätigung, Login, Logout, "wer bin ich
// gerade" (/me) sowie Passwort vergessen/zurücksetzen.
// Passwörter werden nie im Klartext gespeichert (scrypt-Hash, siehe
// lib/crypto.js). Sitzungstoken bekommt das Frontend nach Login (bzw.
// nach erfolgreicher E-Mail-Bestätigung) und schickt es danach bei
// jeder geschützten Anfrage im Header "Authorization: Bearer <token>"
// mit.
//
// E-Mail-Ablauf: Registrierung legt den Account erst UNBESTÄTIGT an
// (email_verified = 0) und verschickt einen Bestätigungslink. Login
// ist erst nach Klick auf diesen Link möglich. Der Klick auf den Link
// bestätigt die Adresse UND loggt direkt ein (praktisch, und technisch
// ein gültiger Nachweis, dass die Adresse dem Nutzer gehört).

const crypto = require("crypto");
const db = require("../lib/db");
const { sendJson, readJsonBody } = require("../lib/http");
const { hashPassword, verifyPassword, generateSessionToken } = require("../lib/crypto");
const { getUserIdFromRequest } = require("../lib/auth");
const { sendEmail, verificationEmailHtml, resetPasswordEmailHtml } = require("../lib/email");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const VERIFICATION_VALID_MS = 24 * 60 * 60 * 1000; // 24 Stunden
const RESET_VALID_MS = 60 * 60 * 1000;              // 1 Stunde

// Generische Antwort bei "Passwort vergessen" / "Link erneut senden":
// verrät absichtlich NICHT, ob die E-Mail-Adresse überhaupt registriert
// ist (Datenschutz/Sicherheit) - die Formulierung passt für beide Fälle.
const GENERIC_RESET_MESSAGE =
    "Falls diese E-Mail-Adresse bei uns registriert ist, haben wir gerade einen Link zum Zurücksetzen des Passworts dorthin geschickt.";

const GENERIC_RESEND_MESSAGE =
    "Falls diese E-Mail-Adresse bei uns registriert und noch nicht bestätigt ist, haben wir gerade einen neuen Bestätigungslink dorthin geschickt.";

function publicUser(row) {
    return { id: row.id, name: row.name, email: row.email };
}

function randomToken() {
    return crypto.randomBytes(32).toString("hex");
}

function futureIso(ms) {
    return new Date(Date.now() + ms).toISOString();
}

function isExpired(isoString) {
    return !isoString || new Date(isoString).getTime() < Date.now();
}

// Grundadresse der Website für Links in E-Mails. Lässt sich über die
// Umgebungsvariable APP_URL fest vorgeben (z. B. bei mehreren Domains);
// ohne das wird sie aus dem Host-Header der Anfrage abgeleitet - das
// funktioniert sowohl lokal (http://localhost:3000) als auch online
// (https://moviq-xyz.onrender.com) automatisch.
function appBaseUrl(req) {

    if (process.env.APP_URL) {
        return process.env.APP_URL.replace(/\/+$/, "");
    }

    const host = req.headers.host || "localhost:3000";
    const isLocal = /^(localhost|127\.0\.0\.1)(:|$)/.test(host);

    return (isLocal ? "http://" : "https://") + host;

}

async function sendVerificationEmail(req, user, token) {

    const link = appBaseUrl(req) + "/?verify=" + encodeURIComponent(token);

    try {
        await sendEmail(
            user.email,
            "Bestätige deine E-Mail-Adresse – MOVIQ",
            verificationEmailHtml(user.name, link)
        );
    } catch (e) {
        console.error("Bestätigungs-E-Mail konnte nicht gesendet werden:", e);
    }

}

async function sendResetEmail(req, user, token) {

    const link = appBaseUrl(req) + "/?reset=" + encodeURIComponent(token);

    try {
        await sendEmail(
            user.email,
            "Setze dein MOVIQ-Passwort zurück",
            resetPasswordEmailHtml(user.name, link)
        );
    } catch (e) {
        console.error("Reset-E-Mail konnte nicht gesendet werden:", e);
    }

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

        // Hinweis: Die E-Mail-Bestätigungspflicht ist vorbereitet (siehe
        // /verify-email, /resend-verification unten + email_verified-Spalte),
        // aber auf Wunsch vorerst ausgeschaltet, bis der E-Mail-Versand
        // (RESEND_API_KEY) eingerichtet ist. Registrierung legt den Account
        // deshalb direkt als bestätigt an und loggt wie gewohnt sofort ein.
        // "Passwort vergessen" (weiter unten) ist davon unabhängig bereits
        // aktiv.
        const info = db
            .prepare(
                `INSERT INTO users
                    (name, email, password_hash, email_verified)
                 VALUES (?, ?, ?, 1)`
            )
            .run(name.trim(), normalizedEmail, passwordHash);

        const userId = info.lastInsertRowid;
        const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);

        const token = generateSessionToken();
        db.prepare("INSERT INTO sessions (token, user_id) VALUES (?, ?)").run(token, userId);

        sendJson(res, 201, { token, user: publicUser(user) });

    });

    router.post("/api/auth/verify-email", async (req, res) => {

        const body = await readJsonBody(req);
        const { token } = body;

        if (!token) {
            return sendJson(res, 400, { error: "Kein Bestätigungs-Token übergeben." });
        }

        const user = db
            .prepare("SELECT * FROM users WHERE verification_token = ?")
            .get(token);

        if (!user) {
            return sendJson(res, 400, {
                error: "Dieser Bestätigungslink ist ungültig oder wurde bereits verwendet."
            });
        }

        if (isExpired(user.verification_expires)) {
            return sendJson(res, 400, {
                error: "Dieser Bestätigungslink ist abgelaufen. Fordere unten einen neuen an.",
                code: "EXPIRED"
            });
        }

        db.prepare(
            `UPDATE users
             SET email_verified = 1, verification_token = NULL, verification_expires = NULL
             WHERE id = ?`
        ).run(user.id);

        const sessionToken = generateSessionToken();
        db.prepare("INSERT INTO sessions (token, user_id) VALUES (?, ?)").run(sessionToken, user.id);

        sendJson(res, 200, {
            token: sessionToken,
            user: publicUser({ ...user, email_verified: 1 })
        });

    });

    router.post("/api/auth/resend-verification", async (req, res) => {

        const body = await readJsonBody(req);
        const { email } = body;

        if (!email) {
            return sendJson(res, 400, { error: "E-Mail-Adresse wird benötigt." });
        }

        const user = db
            .prepare("SELECT * FROM users WHERE email = ?")
            .get(email.toLowerCase().trim());

        if (user && !user.email_verified) {

            const verificationToken = randomToken();
            const verificationExpires = futureIso(VERIFICATION_VALID_MS);

            db.prepare(
                "UPDATE users SET verification_token = ?, verification_expires = ? WHERE id = ?"
            ).run(verificationToken, verificationExpires, user.id);

            await sendVerificationEmail(req, user, verificationToken);

        }

        // Immer dieselbe Antwort, egal ob die E-Mail existiert/schon
        // bestätigt ist - verrät nichts über registrierte Adressen.
        sendJson(res, 200, { message: GENERIC_RESEND_MESSAGE });

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

        // E-Mail-Bestätigungspflicht ist aktuell ausgeschaltet (siehe
        // Hinweis bei /register oben) - deshalb hier bewusst KEIN Check
        // auf user.email_verified mehr.

        const token = generateSessionToken();
        db.prepare("INSERT INTO sessions (token, user_id) VALUES (?, ?)").run(token, user.id);

        sendJson(res, 200, { token, user: publicUser(user) });

    });

    router.post("/api/auth/request-password-reset", async (req, res) => {

        const body = await readJsonBody(req);
        const { email } = body;

        if (!email) {
            return sendJson(res, 400, { error: "E-Mail-Adresse wird benötigt." });
        }

        const user = db
            .prepare("SELECT * FROM users WHERE email = ?")
            .get(email.toLowerCase().trim());

        if (user) {

            const resetToken = randomToken();
            const resetExpires = futureIso(RESET_VALID_MS);

            db.prepare(
                "UPDATE users SET reset_token = ?, reset_expires = ? WHERE id = ?"
            ).run(resetToken, resetExpires, user.id);

            await sendResetEmail(req, user, resetToken);

        }

        sendJson(res, 200, { message: GENERIC_RESET_MESSAGE });

    });

    router.post("/api/auth/reset-password", async (req, res) => {

        const body = await readJsonBody(req);
        const { token, password } = body;

        if (!token || !password) {
            return sendJson(res, 400, { error: "Token und neues Passwort werden benötigt." });
        }

        if (password.length < 8) {
            return sendJson(res, 400, { error: "Das Passwort muss mindestens 8 Zeichen lang sein." });
        }

        const user = db
            .prepare("SELECT * FROM users WHERE reset_token = ?")
            .get(token);

        if (!user) {
            return sendJson(res, 400, { error: "Dieser Link ist ungültig oder wurde bereits verwendet." });
        }

        if (isExpired(user.reset_expires)) {
            return sendJson(res, 400, { error: "Dieser Link ist abgelaufen. Fordere einen neuen an." });
        }

        const passwordHash = hashPassword(password);

        db.prepare(
            `UPDATE users
             SET password_hash = ?, reset_token = NULL, reset_expires = NULL
             WHERE id = ?`
        ).run(passwordHash, user.id);

        // Sicherheitshalber alle bestehenden Sitzungen beenden, falls das
        // Passwort zurückgesetzt wurde, weil es jemand anderes kannte.
        db.prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id);

        sendJson(res, 200, { success: true });

    });

    // Passwort direkt auf der Seite ändern (eingeloggt, mit aktuellem
    // Passwort als Nachweis) - unabhängig von "Passwort vergessen" oben,
    // das über einen E-Mail-Link läuft.
    router.post("/api/auth/change-password", async (req, res) => {

        const userId = getUserIdFromRequest(req);

        if (!userId) {
            return sendJson(res, 401, { error: "Nicht angemeldet." });
        }

        const body = await readJsonBody(req);
        const { currentPassword, newPassword } = body;

        if (!currentPassword || !newPassword) {
            return sendJson(res, 400, { error: "Aktuelles und neues Passwort werden benötigt." });
        }

        if (newPassword.length < 8) {
            return sendJson(res, 400, { error: "Das neue Passwort muss mindestens 8 Zeichen lang sein." });
        }

        const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);

        if (!user || !verifyPassword(currentPassword, user.password_hash)) {
            return sendJson(res, 401, { error: "Das aktuelle Passwort ist falsch." });
        }

        const passwordHash = hashPassword(newPassword);

        db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, userId);

        // Sicherheitshalber alle ANDEREN Sitzungen beenden (z. B. falls das
        // Konto woanders offen war) - die aktuelle Sitzung bleibt bestehen,
        // damit man nicht direkt wieder ausgeloggt wird.
        const header = req.headers["authorization"] || "";
        const [, currentToken] = header.split(" ");

        db.prepare("DELETE FROM sessions WHERE user_id = ? AND token != ?").run(userId, currentToken || "");

        sendJson(res, 200, { success: true });

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
