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

// 3D-Anatomiemodell (public/anatomie.glb). Wird einmal gzip-komprimiert
// im Speicher gehalten und mit Cache-Header ausgeliefert.
const MODEL_FILE = path.join(__dirname, "public", "anatomie.glb");
let modelGz = null;

function serveModel(req, res) {

    fs.readFile(MODEL_FILE, (err, raw) => {

        if (err) {
            sendJson(res, 404, { error: "Modell nicht gefunden." });
            return;
        }

        const headers = {
            "Content-Type": "model/gltf-binary",
            "Cache-Control": "public, max-age=86400"
        };

        const acceptsGzip = /\bgzip\b/.test(req.headers["accept-encoding"] || "");

        if (acceptsGzip) {
            modelGz = modelGz || zlib.gzipSync(raw, { level: 9 });
            headers["Content-Encoding"] = "gzip";
            headers["Content-Length"] = modelGz.length;
            res.writeHead(200, headers);
            res.end(req.method === "HEAD" ? undefined : modelGz);
        } else {
            headers["Content-Length"] = raw.length;
            res.writeHead(200, headers);
            res.end(req.method === "HEAD" ? undefined : raw);
        }
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

    if (pathname === "/anatomie.glb" && (req.method === "GET" || req.method === "HEAD")) {
        return serveModel(req, res);
    }

    if (serveStatic(req, res, pathname)) return;

    sendJson(res, 404, { error: "Nicht gefunden." });

});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log(`MOVIQ-Backend läuft auf http://localhost:${PORT}`);
});
