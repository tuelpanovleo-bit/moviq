# MOVIQ-Backend (Grundgerüst)

Dieses kleine Backend ersetzt Schritt für Schritt das, was die MOVIQ-Website
bisher nur im Browser (`localStorage`) gespeichert hat: echte Accounts mit
Passwort, ein echtes Tagebuch und echte Gesundheitsschirm-Werte pro Nutzer –
alles in einer richtigen Datenbank auf einem Server, nicht mehr nur lokal im
Browser des jeweiligen Geräts.

## Wichtig: läuft ohne "npm install"

Damit das Projekt überall sofort startet, wurden bewusst **keine externen
npm-Pakete** verwendet (kein Express, kein bcrypt, kein JWT) – nur eingebaute
Node.js-Module:

- `http` für den Webserver
- `node:sqlite` für die Datenbank (Node 22+, aktuell "experimental", aber
  stabil nutzbar)
- `crypto` für sicheres Passwort-Hashing (scrypt) und Sitzungstoken

Voraussetzung ist daher nur **Node.js ab Version 22.5**. Kein `npm install`
nötig.

## Starten

```bash
node server.js
```

Der Server läuft danach unter `http://localhost:3000`. Beim ersten Start
wird automatisch eine SQLite-Datenbank unter `data/moviq.db` inkl. aller
Tabellen angelegt.

Optional: `.env.example` zu `.env` kopieren, um Port oder CORS-Herkunft
anzupassen. Ohne `.env` gelten sinnvolle Standardwerte (Port 3000, CORS für
alle Herkünfte offen – praktisch für lokale Tests mit der `moviq.html`).

## Zusammen mit der Website (moviq.html) nutzen

Die `moviq.html` spricht dieses Backend inzwischen direkt an: Login,
Registrierung, Tagebuch und Gesundheitsschirm laufen über die API statt
über `localStorage` (nur das Sitzungstoken selbst liegt noch im Browser).

Damit das funktioniert:

1. Diesen Server starten: `node server.js` (Port 3000).
2. `moviq.html` ganz normal im Browser öffnen (z. B. per Doppelklick).
3. Fertig – Registrierung/Login/Tagebuch/Gesundheitsschirm laufen jetzt
   gegen `http://localhost:3000`.

Die Zieladresse steht ganz oben im `<script>`-Teil von `moviq.html` in der
Konstante `API_BASE`. Läuft der Server später nicht mehr lokal, sondern
z. B. auf Railway/Render unter einer echten Domain, muss `API_BASE` dort
entsprechend angepasst werden (z. B. `https://moviq-backend.onrender.com/api`).
Ist der Server gerade nicht erreichbar, zeigt die Website eine
verständliche Fehlermeldung statt einfach nichts zu tun.

## Die API

Alle Antworten sind JSON. Geschützte Routen erwarten den Header
`Authorization: Bearer <token>` (Token kommt von Register/Login).

| Methode | Pfad                | Auth nötig | Zweck |
|---|---|---|---|
| GET    | `/api/health`        | nein | Kurzer Check, ob der Server läuft |
| POST   | `/api/auth/register`  | nein | Account anlegen → `{token, user}` |
| POST   | `/api/auth/login`     | nein | Anmelden → `{token, user}` |
| POST   | `/api/auth/logout`    | ja   | Aktuelles Token ungültig machen |
| GET    | `/api/auth/me`        | ja   | Eigene Nutzerdaten abfragen |
| GET    | `/api/diary`          | ja   | Eigene Tagebuch-Einträge abrufen |
| POST   | `/api/diary`          | ja   | Eintrag anlegen/überschreiben (pro Datum) |
| DELETE | `/api/diary/:id`      | ja   | Eintrag löschen |
| GET    | `/api/wheel`          | ja   | Eigene Gesundheitsschirm-Werte abrufen |
| PUT    | `/api/wheel`          | ja   | Gesundheitsschirm-Werte speichern |
| GET    | `/api/profile`        | ja   | Eigenes Arbeitsprofil abrufen (oder `null`) |
| PUT    | `/api/profile`        | ja   | Arbeitsprofil anlegen/überschreiben |

Beispiel Registrierung:

```bash
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"name":"Leo","email":"leo@example.com","password":"mindestens8zeichen"}'
```

Antwort: `{"token":"...", "user":{"id":1,"name":"Leo","email":"leo@example.com"}}`

Dieses Token danach bei jeder weiteren Anfrage mitschicken:

```bash
curl http://localhost:3000/api/diary \
  -H "Authorization: Bearer <token-von-oben>"
```

## Aufbau des Projekts

```
moviq-backend/
├── server.js          Einstiegspunkt: HTTP-Server, CORS, Routing
├── lib/
│   ├── db.js           Datenbank-Verbindung + Tabellen (node:sqlite)
│   ├── crypto.js        Passwort-Hashing + Sitzungstoken (crypto)
│   ├── auth.js           Prüft Bearer-Token gegen die Datenbank
│   ├── http.js            Mini-Router + JSON-Hilfsfunktionen
│   └── env.js               Liest optional eine .env-Datei ein
├── routes/
│   ├── auth.js         Register/Login/Logout/me
│   ├── diary.js        Tagebuch (CRUD)
│   ├── wheel.js         Gesundheitsschirm-Werte
│   └── profile.js        Arbeitsprofil (Bereich, Beruf, Belastung, Stunden)
├── data/
│   └── moviq.db        Die SQLite-Datenbank (entsteht automatisch)
└── .env.example
```

## Nächste Schritte

1. **Frontend ist bereits angebunden** ✓ – `moviq.html` nutzt für
   Login/Registrierung, Tagebuch und Gesundheitsschirm dieses Backend statt
   `localStorage` (Details oben unter "Zusammen mit der Website nutzen").
2. **Hosting:** Für einen echten Betrieb (nicht nur lokal) bietet sich ein
   einfacher, günstiger Anbieter an, z. B. **Railway** oder **Render** –
   beide unterstützen Node.js-Projekte direkt aus einem Git-Repository,
   inklusive HTTPS. Die `data/`-Persistenz (SQLite-Datei) sollte dabei auf
   ein "persistentes Volume" gelegt werden, das viele Anbieter kostenlos im
   Starter-Tarif anbieten; alternativ später auf eine gehostete
   Postgres-Datenbank umsteigen, sobald mehr Last erwartet wird.
3. **KI-Anbindung für die Beschwerdeanalyse:** Sobald ein Backend steht,
   kann hier eine eigene Route (z. B. `POST /api/analysis`) ergänzt werden,
   die einen KI-Anbieter serverseitig aufruft – der API-Key bleibt dabei
   sicher auf dem Server statt im Browser sichtbar zu sein.
4. **Produktions-Härtung** (wenn es ernst wird): Rate-Limiting gegen
   Brute-Force-Logins, striktere CORS-Origin (statt `*`), Backups der
   `data/moviq.db`, ggf. Umstieg auf eine Bibliothek wie Express, sobald das
   Projekt größer wird und Komfortfunktionen mehr zählen als
   Null-Abhängigkeiten.

## Warum SQLite statt gleich "einer richtigen" Datenbank?

Für einen Prototyp/MVP ist SQLite genau richtig: keine separate
Datenbank-Installation, ein einziges Datenfile, das sich leicht sichern
lässt, und für die zu erwartende Last (ein Team, wenige hundert Nutzer)
völlig ausreichend schnell. Der Umstieg auf Postgres o. ä. ist später ein
kleiner, klar abgegrenzter Schritt (die SQL-Abfragen hier sind bewusst
einfach gehalten) – kein Grund, ihn jetzt schon vorwegzunehmen.
