// lib/static.js
//
// Liefert die Website (moviq.html) direkt über diesen Server aus, unter
// "/". Dadurch reicht EIN Deployment (z. B. auf Render) für Website +
// Backend zusammen – keine zweite Hosting-Adresse nötig, und moviq.html
// spricht automatisch die eigene Adresse an (siehe API_BASE dort).
//
// Bewusst ohne npm-Paket (kein "serve-static" o. ä.), nur node:fs.

const fs = require("fs");
const path = require("path");

const PUBLIC_DIR = path.join(__dirname, "..", "public");
const INDEX_FILE = path.join(PUBLIC_DIR, "index.html");

function serveStatic(req, res, pathname) {

    if (req.method !== "GET" && req.method !== "HEAD") return false;

    if (pathname === "/" || pathname === "/index.html" || pathname === "/moviq.html") {

        if (!fs.existsSync(INDEX_FILE)) return false;

        const html = fs.readFileSync(INDEX_FILE);

        res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Content-Length": Buffer.byteLength(html)
        });

        res.end(req.method === "HEAD" ? undefined : html);

        return true;

    }

    return false;

}

module.exports = { serveStatic };
