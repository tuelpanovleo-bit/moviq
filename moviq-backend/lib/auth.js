// lib/auth.js
//
// Prüft den "Authorization: Bearer <token>"-Header gegen die sessions-
// Tabelle. Gültig -> liefert die user_id zurück, sonst null.

const db = require("./db");

function getUserIdFromRequest(req) {

    const header = req.headers["authorization"] || "";
    const [scheme, token] = header.split(" ");

    if (scheme !== "Bearer" || !token) return null;

    const session = db
        .prepare("SELECT user_id FROM sessions WHERE token = ?")
        .get(token);

    return session ? session.user_id : null;

}

module.exports = { getUserIdFromRequest };
