# Pubblicare Zubra online su Render (gratis)

## Cosa ti serve
- Un account **GitHub** (gratis) per mettere il codice online
- Un account **Render** (gratis) — puoi entrare con GitHub

---

## Passo 1 — Metti il codice su GitHub
1. Vai su https://github.com → **New repository**
2. Nome: `zubra` · lascia **Public** (o Private) · crea
3. Carica i file della cartella `animal_scanner_backend` (NON `node_modules`, NON `.env`, NON `data/`):
   - `server.js`, `package.json`, `package-lock.json`, `render.yaml`, `.gitignore`, `.env.example`
   - la cartella `public/` (con dentro `index.html`, `style.css`, `app.js`, `auth.js`, `i18n.js`)
   - (puoi trascinarli con "Add file → Upload files")

## Passo 2 — Crea il servizio su Render
1. Vai su https://render.com → entra con GitHub
2. **New +** → **Web Service** → scegli il repo `zubra`
3. Render legge `render.yaml` da solo. Se chiede a mano:
   - Runtime: **Node**
   - Build Command: `npm install`
   - Start Command: `node server.js`
   - Plan: **Free**

## Passo 3 — Imposta le variabili segrete (Environment)
Nella sezione **Environment** del servizio aggiungi (gli stessi valori del tuo `.env`):
| Key | Value |
|-----|-------|
| `RESEND_API_KEY` | la tua chiave `re_...` |
| `MAIL_FROM` | `Zubra <onboarding@resend.dev>` |
| `PRO_PASSWORD` | la tua password PRO |
| `MINIMAX_API_KEY` | la tua chiave `sk-cp-...` |
| `MINIMAX_MODEL` | `MiniMax-M3` |

## Passo 4 — Deploy
Premi **Create Web Service**. Dopo qualche minuto avrai un indirizzo tipo:
`https://zubra.onrender.com` → la tua app è online! 🎉

## Passo 5 (facoltativo) — Collega zubra.it
Nel servizio Render: **Settings → Custom Domains → Add** `zubra.it`,
poi metti il record DNS che Render ti indica nel pannello di zubra.it.

---

## ⚠️ Da sapere sul piano gratuito
- **Va in pausa** dopo ~15 min di inattività: la prima visita dopo la pausa ci mette ~30-60s a "svegliarsi".
- **Il disco non è permanente**: a ogni nuovo deploy/riavvio il file `data/users.json` si azzera → gli account andranno ricreati. Per renderli permanenti servirà in futuro un vero database (es. una connessione Postgres gratuita di Render).
