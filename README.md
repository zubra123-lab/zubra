# Animal Scanner — Backend

Mini-server che fa da "proxy" tra l'app e il servizio AI (Google Gemini).

**Perché esiste:** così la chiave AI resta **segreta sul server** (mai dentro
l'app) e puoi offrire un numero di **scansioni gratuite al giorno** per
dispositivo. L'utente non deve inserire nessuna chiave.

```
App Flutter  ──POST /scan──▶  questo server  ──▶  Gemini
                                  │
                          (tiene la chiave +
                           conta le scansioni)
```

## 1. Ottieni una chiave Gemini (gratis)

1. Vai su https://aistudio.google.com/apikey
2. Accedi con un account Google → **Create API key**
3. Copia la chiave (inizia con `AIza...`)

Il piano gratuito di Gemini copre i modelli "flash" con quote giornaliere
generose: per un'app piccola il costo è **0 €**.

## 2. Configura

```bash
cp .env.example .env
```

Apri `.env` e incolla la chiave in `GEMINI_API_KEY`. Puoi anche cambiare
`DAILY_FREE_LIMIT` (scansioni gratis al giorno per dispositivo).

## 3. Avvia in locale

```bash
npm install
npm start
```

Il server parte su `http://localhost:8787`. Prova:

```bash
curl http://localhost:8787/health
```

### Come ci si collega l'app

L'app sceglie l'indirizzo del server in automatico:

| Dove gira l'app            | URL usato di default          |
|----------------------------|-------------------------------|
| Web (browser sullo stesso PC) | `http://localhost:8787`    |
| Emulatore Android          | `http://10.0.2.2:8787`        |
| Telefono reale / produzione | l'URL pubblico (vedi sotto)  |

Puoi cambiarlo nell'app in **Impostazioni → Indirizzo del server**.

## 4. Pubblicalo online (per usarlo da telefoni veri)

In locale funziona solo sul tuo PC. Per renderlo raggiungibile da qualsiasi
telefono, pubblica il server su un hosting gratuito, ad esempio:

- **Render.com** (free): nuovo *Web Service*, comando di avvio `npm start`,
  aggiungi le variabili d'ambiente (`GEMINI_API_KEY`, ecc.).
- **Railway.app** / **Fly.io**: simili.

Dopo il deploy ottieni un URL tipo `https://animal-scanner.onrender.com`.
Mettilo nell'app in **Impostazioni → Indirizzo del server** e imposta
`ALLOWED_ORIGIN` con il dominio della tua app web (o `*` per semplicità).

## Endpoint

| Metodo | Path      | Descrizione                                   |
|--------|-----------|-----------------------------------------------|
| GET    | `/health` | Stato del server e configurazione             |
| GET    | `/quota?deviceId=...` | Scansioni gratuite rimaste oggi   |
| POST   | `/scan`   | Riconosce l'animale (body: deviceId, imageBase64, mimeType) |

## Limiti e note

- Il conteggio per dispositivo è salvato in `data/usage.json`. Per un'app con
  tanti utenti conviene un database (es. Redis/Postgres) e un limite anche per
  IP, perché un `deviceId` può essere reimpostato reinstallando l'app.
- Solo le foto in cui viene riconosciuto un animale consumano una scansione.
