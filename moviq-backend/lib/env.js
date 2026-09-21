// lib/env.js
//
// Winzig kleiner .env-Loader (kein "dotenv"-Paket nötig): liest eine
// .env-Datei im Projektordner ein und trägt ihre Werte in process.env
// ein, sofern dort noch kein Wert für diesen Key steht.

const fs = require("fs");
const path = require("path");

function loadEnv() {

    const envPath = path.join(__dirname, "..", ".env");

    if (!fs.existsSync(envPath)) return;

    const content = fs.readFileSync(envPath, "utf8");

    content.split("\n").forEach(line => {

        const trimmed = line.trim();

        if (!trimmed || trimmed.startsWith("#")) return;

        const eq = trimmed.indexOf("=");
        if (eq === -1) return;

        const key = trimmed.slice(0, eq).trim();
        let value = trimmed.slice(eq + 1).trim();

        // umgebende Anführungszeichen entfernen, falls vorhanden
        if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1);
        }

        if (process.env[key] === undefined) {
            process.env[key] = value;
        }

    });

}

module.exports = { loadEnv };
