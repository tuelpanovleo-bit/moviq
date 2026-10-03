// lib/email.js
//
// Sehr kleiner E-Mail-Versand über die Resend-API (https://resend.com) –
// bewusst ohne npm-Paket ("resend" o. Ä.): Node bringt seit Version 18
// fetch() fest eingebaut mit, das reicht für diesen einfachen REST-Aufruf.
//
// Ohne gesetzten RESEND_API_KEY (z. B. beim lokalen Testen) wird die
// Mail NICHT verschickt, sondern nur in die Konsole geschrieben – so
// lässt sich der Bestätigungs-/Reset-Link beim Entwickeln direkt aus
// dem Server-Log kopieren, ohne einen echten Versanddienst zu brauchen.
//
// Benötigte Umgebungsvariablen (bei Render unter "Environment" setzen):
//   RESEND_API_KEY   – API-Key aus dem Resend-Dashboard
//   EMAIL_FROM        – Absenderadresse, z. B. "MOVIQ <onboarding@resend.dev>"
//                        (ohne eigene verifizierte Domain funktioniert die
//                        Resend-Testadresse "onboarding@resend.dev")

const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const EMAIL_FROM = process.env.EMAIL_FROM || "MOVIQ <onboarding@resend.dev>";

async function sendEmail(to, subject, html) {

    if (!RESEND_API_KEY) {

        console.log("--- E-Mail-Vorschau (kein RESEND_API_KEY gesetzt) ---");
        console.log("An:      " + to);
        console.log("Betreff: " + subject);
        console.log(html);
        console.log("------------------------------------------------------");

        return;

    }

    let response;

    try {

        response = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
                "Authorization": "Bearer " + RESEND_API_KEY,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                from: EMAIL_FROM,
                to: [to],
                subject: subject,
                html: html
            })
        });

    } catch (networkErr) {

        console.error("E-Mail-Versand fehlgeschlagen (Netzwerk):", networkErr.message);
        return;

    }

    if (!response.ok) {
        const text = await response.text();
        console.error("E-Mail-Versand fehlgeschlagen:", response.status, text);
    }

}

function verificationEmailHtml(name, link) {
    return `
        <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
            <h2 style="color: #1D4538;">Willkommen bei MOVIQ, ${escapeHtml(name)}!</h2>
            <p>Bitte bestätige deine E-Mail-Adresse, um deinen Account zu aktivieren:</p>
            <p style="margin: 28px 0;">
                <a href="${link}" style="background: #1D4538; color: #fff; padding: 14px 24px; border-radius: 999px; text-decoration: none; font-weight: 600;">
                    E-Mail-Adresse bestätigen
                </a>
            </p>
            <p style="color: #666; font-size: 13px;">
                Der Link ist 24 Stunden gültig. Falls du dich nicht bei MOVIQ
                registriert hast, kannst du diese E-Mail einfach ignorieren.
            </p>
        </div>
    `;
}

function resetPasswordEmailHtml(name, link) {
    return `
        <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
            <h2 style="color: #1D4538;">Passwort zurücksetzen</h2>
            <p>Hallo ${escapeHtml(name)}, du hast angefragt, dein MOVIQ-Passwort zurückzusetzen.</p>
            <p style="margin: 28px 0;">
                <a href="${link}" style="background: #1D4538; color: #fff; padding: 14px 24px; border-radius: 999px; text-decoration: none; font-weight: 600;">
                    Neues Passwort vergeben
                </a>
            </p>
            <p style="color: #666; font-size: 13px;">
                Der Link ist 1 Stunde gültig. Falls du das nicht warst, kannst
                du diese E-Mail einfach ignorieren – dein Passwort bleibt
                unverändert.
            </p>
        </div>
    `;
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

module.exports = { sendEmail, verificationEmailHtml, resetPasswordEmailHtml };
