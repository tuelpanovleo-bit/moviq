// routes/profile.js
//
// Arbeitsprofil: Bereich, Beruf, Arbeitsbelastung, Wochenstunden und
// beanspruchte Körperbereiche – einmal pro Nutzer. Wird nach der
// Registrierung abgefragt und auf der Startseite als Profil-Karte
// zusammengefasst.

const db = require("../lib/db");
const { sendJson, readJsonBody } = require("../lib/http");
const { getUserIdFromRequest } = require("../lib/auth");

const VALID_WORKLOADS = [
    "sitzend",
    "stehend_gehend",
    "koerperlich_schwer",
    "feinmotorisch",
    "wechselnd"
];

function requireAuth(req, res) {

    const userId = getUserIdFromRequest(req);

    if (!userId) {
        sendJson(res, 401, { error: "Nicht angemeldet." });
        return null;
    }

    return userId;

}

function toApiProfile(row) {

    if (!row) return null;

    let strainedAreas = [];

    try {
        strainedAreas = JSON.parse(row.strained_areas);
    } catch (e) {
        strainedAreas = [];
    }

    return {
        field: row.field,
        profession: row.profession,
        workload: row.workload,
        weeklyHours: row.weekly_hours,
        strainedAreas: strainedAreas
    };

}

function register(router) {

    // GET /api/profile  -> { profile: {...} | null }
    router.get("/api/profile", async (req, res) => {

        const userId = requireAuth(req, res);
        if (!userId) return;

        const row = db
            .prepare("SELECT * FROM work_profiles WHERE user_id = ?")
            .get(userId);

        sendJson(res, 200, { profile: toApiProfile(row) });

    });

    // PUT /api/profile  -> Arbeitsprofil anlegen/überschreiben
    router.put("/api/profile", async (req, res) => {

        const userId = requireAuth(req, res);
        if (!userId) return;

        const body = await readJsonBody(req);
        const { field, profession, workload, weeklyHours, strainedAreas } = body;

        if (!field || !profession || !workload) {
            return sendJson(res, 400, {
                error: "Bereich, Beruf und Arbeitsbelastung werden benötigt."
            });
        }

        if (!VALID_WORKLOADS.includes(workload)) {
            return sendJson(res, 400, { error: "Ungültige Arbeitsbelastung." });
        }

        const hoursNum = Number(weeklyHours);

        if (!Number.isFinite(hoursNum) || hoursNum < 1 || hoursNum > 80) {
            return sendJson(res, 400, {
                error: "Die Wochenstunden müssen zwischen 1 und 80 liegen."
            });
        }

        const areasArray = Array.isArray(strainedAreas)
            ? strainedAreas.filter(a => typeof a === "string").slice(0, 20)
            : [];

        db.prepare(`
            INSERT INTO work_profiles
                (user_id, field, profession, workload, weekly_hours, strained_areas)
            VALUES
                (:userId, :field, :profession, :workload, :weeklyHours, :strainedAreas)
            ON CONFLICT (user_id) DO UPDATE SET
                field = excluded.field,
                profession = excluded.profession,
                workload = excluded.workload,
                weekly_hours = excluded.weekly_hours,
                strained_areas = excluded.strained_areas,
                updated_at = datetime('now')
        `).run({
            userId,
            field: String(field).trim(),
            profession: String(profession).trim(),
            workload,
            weeklyHours: hoursNum,
            strainedAreas: JSON.stringify(areasArray)
        });

        const row = db
            .prepare("SELECT * FROM work_profiles WHERE user_id = ?")
            .get(userId);

        sendJson(res, 200, { profile: toApiProfile(row) });

    });

}

module.exports = { register };
