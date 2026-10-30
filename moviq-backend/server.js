// server.js
//
// Einstiegspunkt des MOVIQ-Backends. Baut eine kleine, klar strukturierte
// REST-API: Accounts (Register/Login/Logout), Tagebuch, Gesundheitsschirm
// und Arbeitsprofil. Läuft komplett ohne "npm install" – nur mit den in
// Node eingebauten Modulen (http, node:sqlite, crypto).
//
// Start:  node server.js   (oder: npm start)

const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { loadEnv } = require("./lib/env");

loadEnv();

const { Router, sendJson } = require("./lib/http");
const { serveStatic } = require("./lib/static");

const authRoutes = require("./routes/auth");
const diaryRoutes = require("./routes/diary");
const wheelRoutes = require("./routes/wheel");
const profileRoutes = require("./routes/profile");

// 3D-Anatomie: Modell (anatomie.glb) und 3D-Bibliothek (three-bundle.js)
// liegen in public/. Beide werden einmal gzip-komprimiert im Speicher
// gehalten und mit Cache-Header ausgeliefert.
const ASSETS = {
    "/anatomie.glb": { file: "anatomie.glb", type: "model/gltf-binary" },
    "/three-bundle.js": { file: "three-bundle.js", type: "text/javascript; charset=utf-8" }
};
const assetCache = {};

function serveAsset(req, res, pathname) {

    const asset = ASSETS[pathname];

    fs.readFile(path.join(__dirname, "public", asset.file), (err, raw) => {

        if (err) {
            sendJson(res, 404, { error: "Datei nicht gefunden." });
            return;
        }

        const headers = {
            "Content-Type": asset.type,
            "Cache-Control": "public, max-age=86400"
        };

        let body = raw;

        if (/\bgzip\b/.test(req.headers["accept-encoding"] || "")) {
            assetCache[pathname] = assetCache[pathname] || zlib.gzipSync(raw, { level: 9 });
            body = assetCache[pathname];
            headers["Content-Encoding"] = "gzip";
        }

        headers["Content-Length"] = body.length;
        res.writeHead(200, headers);
        res.end(req.method === "HEAD" ? undefined : body);
    });
}

const router = new Router();

authRoutes.register(router);
diaryRoutes.register(router);
wheelRoutes.register(router);
profileRoutes.register(router);

router.get("/api/health", async (req, res) => {
    sendJson(res, 200, { status: "ok" });
});

const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

function applyCors(res) {
    res.setHeader("Access-Control-Allow-Origin", CORS_ORIGIN);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

const server = http.createServer(async (req, res) => {

    applyCors(res);

    if (req.method === "OPTIONS") {
        res.writeHead(204);
        return res.end();
    }

    const pathname = req.url.split("?")[0];

    if (pathname.startsWith("/api/")) {

        const handled = await router.handle(req, res, pathname);

        if (!handled) {
            sendJson(res, 404, { error: "Nicht gefunden." });
        }

        return;

    }

    if (ASSETS[pathname] && (req.method === "GET" || req.method === "HEAD")) {
        return serveAsset(req, res, pathname);
    }

    if (serveStatic(req, res, pathname)) return;

    sendJson(res, 404, { error: "Nicht gefunden." });

});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log(`MOVIQ-Backend läuft auf http://localhost:${PORT}`);
});
