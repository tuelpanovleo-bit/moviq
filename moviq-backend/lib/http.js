// lib/http.js
//
// Ein sehr kleiner Ersatz für das, was man normalerweise von Express
// bekommt (Routing, JSON-Body lesen, JSON-Antworten senden) – bewusst
// selbst geschrieben, damit das Projekt ohne "npm install" startet.
// Für ein größeres/produktives Backend ist der Umstieg auf Express
// jederzeit möglich, ohne dass sich an den Routen-Dateien viel ändert.

function sendJson(res, statusCode, body) {

    const payload = body === undefined ? "" : JSON.stringify(body);

    res.writeHead(statusCode, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(payload)
    });

    res.end(payload);

}

function readJsonBody(req) {

    return new Promise((resolve, reject) => {

        let raw = "";
        let tooLarge = false;

        req.on("data", chunk => {

            raw += chunk;

            if (raw.length > 1_000_000) {
                tooLarge = true;
                req.destroy();
            }

        });

        req.on("end", () => {

            if (tooLarge) {
                return reject(new Error("Anfrage zu groß."));
            }

            if (!raw) return resolve({});

            try {
                resolve(JSON.parse(raw));
            } catch (e) {
                reject(new Error("Ungültiges JSON im Request-Body."));
            }

        });

        req.on("error", reject);

    });

}

// Kleiner Router mit Unterstützung für Pfad-Parameter wie "/api/diary/:id".
class Router {

    constructor() {
        this.routes = [];
    }

    add(method, pattern, handler) {

        const paramNames = [];

        const regexStr = pattern
            .split("/")
            .map(part => {

                if (part.startsWith(":")) {
                    paramNames.push(part.slice(1));
                    return "([^/]+)";
                }

                return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

            })
            .join("/");

        this.routes.push({
            method,
            regex: new RegExp(`^${regexStr}/?$`),
            paramNames,
            handler
        });

    }

    get(pattern, handler) { this.add("GET", pattern, handler); }
    post(pattern, handler) { this.add("POST", pattern, handler); }
    put(pattern, handler) { this.add("PUT", pattern, handler); }
    delete(pattern, handler) { this.add("DELETE", pattern, handler); }

    // Gibt true zurück, wenn eine passende Route gefunden und behandelt wurde.
    async handle(req, res, pathname) {

        for (const route of this.routes) {

            if (route.method !== req.method) continue;

            const match = pathname.match(route.regex);

            if (!match) continue;

            const params = {};
            route.paramNames.forEach((name, i) => {
                params[name] = decodeURIComponent(match[i + 1]);
            });

            try {
                await route.handler(req, res, params);
            } catch (err) {
                console.error(err);
                sendJson(res, 500, { error: "Unerwarteter Serverfehler." });
            }

            return true;

        }

        return false;

    }

}

module.exports = { sendJson, readJsonBody, Router };
