// lib/crypto.js
//
// Passwort-Hashing (scrypt, in Node fest eingebaut) und Login-Tokens –
// bewusst ohne bcrypt/jsonwebtoken-Pakete, damit dieses Projekt ganz
// ohne "npm install" sofort lauffähig ist. scrypt ist kryptografisch
// ein völlig gültiger, moderner Algorithmus für Passwort-Hashes.

const crypto = require("crypto");

const SCRYPT_KEYLEN = 64;

function hashPassword(password) {

    const salt = crypto.randomBytes(16).toString("hex");
    const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString("hex");

    return `${salt}:${hash}`;

}

function verifyPassword(password, stored) {

    const [salt, hash] = (stored || "").split(":");

    if (!salt || !hash) return false;

    const candidate = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
    const expected = Buffer.from(hash, "hex");

    if (candidate.length !== expected.length) return false;

    return crypto.timingSafeEqual(candidate, expected);

}

// Opakes, zufälliges Sitzungstoken (kein JWT) – der Server hält die
// Zuordnung Token -> Nutzer in der Datenbank (Tabelle "sessions").
// Einfacher als JWT, ohne Bibliothek, und lässt sich serverseitig
// jederzeit widerrufen (z. B. beim Logout).
function generateSessionToken() {
    return crypto.randomBytes(32).toString("hex");
}

module.exports = { hashPassword, verifyPassword, generateSessionToken };
