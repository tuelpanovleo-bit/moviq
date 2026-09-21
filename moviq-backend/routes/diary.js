// routes/diary.js
//
// Tagebuch-Einträge, ab jetzt pro Nutzer in der Datenbank statt im
// Browser. Ein Eintrag pro Datum (wie im bisherigen Prototyp): wird für
// ein Datum, das schon existiert, erneut gespeichert, wird der alte
// Eintrag überschrieben.
//
// Jeder Nutzer sieht und verändert ausschließlich seine eigenen
// Einträge (requireAuth prüft das Token und liefert die user_id).

const db = require("../lib/db");
const { sendJson, readJsonBody } = require("../lib/http");
const { getUserIdFromRequest } = require("../lib/auth");

function toApiEntry(row) {
    return {
        id: String(row.id),
        date: row.entry_date,
        vas: row.vas,
        development: row.development,
        actions: row.actions
    };
}

function requireAuth(req, res) {

    const userId = getUserIdFromRequest(req);

    if (!userId) {
        sendJson(res, 401, { error: "Nicht angemeldet." });
        return null;
    }

    return userId;

}

function register(router) {

    // GET /api/diary  -> alle Einträge des angemeldeten Nutzers, neueste zuerst
    router.get("/api/diary", async (req, res) => {

        const userId = requireAuth(req, res);
        if (!userId) return;

        const rows = db
            .prepare("SELECT * FROM diary_entries WHERE user_id = ? ORDER BY entry_date DESC")
            .all(userId);

        sendJson(res, 200, { entries: rows.map(toApiEntry) });

    });

    // POST /api/diary  -> Eintrag anlegen oder (für dasselbe Datum) überschreiben
    router.post("/api/diary", async (req, res) => {

        const userId = requireAuth(req, res);
        if (!userId) return;

        const body = await readJsonBody(req);
        const { date, vas, development, actions } = body;

        if (!date || !development || vas === undefined || vas === null) {
            return sendJson(res, 400, { error: "Datum, Schmerzstärke und Entwicklung werden benötigt." });
        }

        const vasNum = Number(vas);

        if (!Number.isInteger(vasNum) || vasNum < 0 || vasNum > 10) {
            return sendJson(res, 400, { error: "Die Schmerzstärke muss eine Zahl zwischen 0 und 10 sein." });
        }

        db.prepare(`
            INSERT INTO diary_entries (user_id, entry_date, vas, development, actions)
            VALUES (:userId, :date, :vas, :development, :actions)
            ON CONFLICT (user_id, entry_date) DO UPDATE SET
                vas = excluded.vas,
                development = excluded.development,
                actions = excluded.actions
        `).run({
            userId,
            date,
            vas: vasNum,
            development: development.trim(),
            actions: (actions || "").trim()
        });

        const row = db
            .prepare("SELECT * FROM diary_entries WHERE user_id = ? AND entry_date = ?")
            .get(userId, date);

        sendJson(res, 201, { entry: toApiEntry(row) });

    });

    // DELETE /api/diary/:id  -> einzelnen Eintrag löschen (nur eigene)
    router.delete("/api/diary/:id", async (req, res, params) => {

        const userId = requireAuth(req, res);
        if (!userId) return;

        const info = db
            .prepare("DELETE FROM diary_entries WHERE id = ? AND user_id = ?")
            .run(params.id, userId);

        if (info.changes === 0) {
            return sendJson(res, 404, { error: "Eintrag nicht gefunden." });
        }

        sendJson(res, 204);

    });

}

module.exports = { register };
