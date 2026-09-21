// lib/db.js
//
// Datenbank-Zugriff über das in Node eingebaute node:sqlite-Modul —
// bewusst kein "better-sqlite3" o.ä. von npm, damit das Projekt ohne
// externe Abhängigkeiten läuft (nur "node server.js" nötig). Die Datei
// liegt unter data/moviq.db und wird beim ersten Start automatisch
// inkl. Tabellen angelegt.
//
// Hinweis: node:sqlite ist in Node 22 noch "experimental" (stabile
// Kernfunktionen, aber die API kann sich in künftigen Node-Versionen
// noch ändern). Für den Prototyp-Start völlig ausreichend. Beim
// Umstieg auf eine "echte" Server-Datenbank (z. B. Postgres) später
// bleibt die Struktur der Queries hier die Vorlage.

const path = require("path");
const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");

const DATA_DIR = path.join(__dirname, "..", "data");

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new DatabaseSync(path.join(DATA_DIR, "moviq.db"));

db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        name          TEXT NOT NULL,
        email         TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
        token       TEXT PRIMARY KEY,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS diary_entries (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        entry_date      TEXT NOT NULL,      -- ISO-Datum, z. B. "2026-09-21"
        vas             INTEGER NOT NULL,   -- Schmerzstärke 0-10
        development     TEXT NOT NULL DEFAULT '',
        actions         TEXT NOT NULL DEFAULT '',  -- "Was wurde getan" im Frontend
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (user_id, entry_date)
    );

    CREATE TABLE IF NOT EXISTS wheel_values (
        user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        category        TEXT NOT NULL,
        question_index  INTEGER NOT NULL,
        value           INTEGER NOT NULL,
        updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (user_id, category, question_index)
    );

    CREATE TABLE IF NOT EXISTS work_profiles (
        user_id         INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        field           TEXT NOT NULL,             -- Bereich, z. B. "Gesundheit & Pflege"
        profession      TEXT NOT NULL,              -- Beruf (aus Liste oder frei eingegeben)
        workload        TEXT NOT NULL,               -- sitzend | stehend_gehend | koerperlich_schwer | feinmotorisch | wechselnd
        weekly_hours    INTEGER NOT NULL,
        strained_areas  TEXT NOT NULL DEFAULT '[]',   -- JSON-Array betroffener Körperbereiche
        updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
`);

module.exports = db;
