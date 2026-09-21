// routes/wheel.js
//
// Gesundheitsschirm-Werte (pro Kategorie eine Liste von Unterfragen-
// Werten 1-5), im gleichen Format wie bisher im localStorage:
// { "Schlaf": [3,4,2,5,3], "Ernährung": [...], ... }
//
// Jeder Nutzer sieht/ändert nur seine eigenen Werte.

const db = require("../lib/db");
const { sendJson, readJsonBody } = require("../lib/http");
const { getUserIdFromRequest } = require("../lib/auth");

function requireAuth(req, res) {

    const userId = getUserIdFromRequest(req);

    if (!userId) {
        sendJson(res, 401, { error: "Nicht angemeldet." });
        return null;
    }

    return userId;

}

function register(router) {

    // GET /api/wheel  -> { values: { <Kategorie>: [1..5, ...], ... } }
    router.get("/api/wheel", async (req, res) => {

        const userId = requireAuth(req, res);
        if (!userId) return;

        const rows = db
            .prepare("SELECT category, question_index, value FROM wheel_values WHERE user_id = ?")
            .all(userId);

        const values = {};

        rows.forEach(row => {
            if (!values[row.category]) values[row.category] = [];
            values[row.category][row.question_index] = row.value;
        });

        sendJson(res, 200, { values });

    });

    // PUT /api/wheel  -> Body: { values: { <Kategorie>: [1..5, ...], ... } }
    router.put("/api/wheel", async (req, res) => {

        const userId = requireAuth(req, res);
        if (!userId) return;

        const body = await readJsonBody(req);
        const { values } = body;

        if (!values || typeof values !== "object") {
            return sendJson(res, 400, { error: "Feld 'values' (Objekt) wird benötigt." });
        }

        const upsert = db.prepare(`
            INSERT INTO wheel_values (user_id, category, question_index, value)
            VALUES (:userId, :category, :questionIndex, :value)
            ON CONFLICT (user_id, category, question_index) DO UPDATE SET
                value = excluded.value,
                updated_at = datetime('now')
        `);

        const entries = [];

        for (const category of Object.keys(values)) {

            const list = values[category];

            if (!Array.isArray(list)) continue;

            list.forEach((value, questionIndex) => {

                const num = Number(value);

                if (!Number.isInteger(num) || num < 1 || num > 5) return;

                entries.push({ userId, category, questionIndex, value: num });

            });

        }

        db.exec("BEGIN");

        try {
            entries.forEach(entry => upsert.run(entry));
            db.exec("COMMIT");
        } catch (err) {
            db.exec("ROLLBACK");
            throw err;
        }

        sendJson(res, 204);

    });

}

module.exports = { register };
