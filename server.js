import dotenv from 'dotenv';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Carica il .env dalla cartella del backend (non dalla cartella di avvio).
dotenv.config({ path: path.join(__dirname, '.env') });

// ---- Configurazione (da variabili d'ambiente / .env) ----
const PORT = Number(process.env.PORT) || 8787;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
// Provider AI alternativo: MiniMax (visione). Se impostato, ha priorità su Gemini.
const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY || '';
const MINIMAX_MODEL = process.env.MINIMAX_MODEL || 'MiniMax-Text-01';
const MINIMAX_BASE = process.env.MINIMAX_BASE || 'https://api.minimax.io/v1';
const AI_PROVIDER = MINIMAX_API_KEY ? 'minimax' : (GEMINI_API_KEY ? 'gemini' : 'none');
// Quante scansioni gratuite al giorno per dispositivo.
const DAILY_FREE_LIMIT = Number(process.env.DAILY_FREE_LIMIT) || 10;
// Origini ammesse per il Web (CORS). "*" = tutte (comodo in sviluppo).
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

// ---- Invio codici di verifica (opzionale) ----
// Email reali via Brevo (preferito) o Resend. Imposta BREVO_API_KEY oppure
// RESEND_API_KEY, più MAIL_FROM ("Nome <indirizzo@dominio>").
const BREVO_API_KEY = process.env.BREVO_API_KEY || '';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const MAIL_FROM = process.env.MAIL_FROM || 'Zubra <onboarding@resend.dev>';
// Estrae { name, email } da "Nome <indirizzo>" (o solo indirizzo).
function parseSender(s) {
  const m = String(s || '').match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1] || 'Zubra', email: m[2].trim() };
  return { name: 'Zubra', email: String(s || '').trim() };
}

// Password segreta PRO: chi si registra usando ESATTAMENTE questa password
// ottiene scansioni illimitate e tutte le funzioni PRO.
// Modificabile con PRO_PASSWORD nel .env.
const PRO_PASSWORD = process.env.PRO_PASSWORD || ''; // vuoto = PRO-by-password disattivato

if (!GEMINI_API_KEY) {
  console.warn(
    '[ATTENZIONE] GEMINI_API_KEY non impostata. Crea un file .env (vedi .env.example) ' +
      'con la tua chiave da https://aistudio.google.com/apikey'
  );
}

// ---- Conteggio scansioni per dispositivo (persistito su file) ----
const dataDir = path.join(__dirname, 'data');
const usageFile = path.join(dataDir, 'usage.json');
fs.mkdirSync(dataDir, { recursive: true });

// ---- Persistenza: Postgres se DATABASE_URL impostato, altrimenti file. ----
// Con un database gli account/monete/sessioni diventano PERMANENTI (non si
// azzerano ai redeploy). Senza, funziona come prima (file, effimero su Render).
const DATABASE_URL = process.env.DATABASE_URL || '';
let pgPool = null, dbReady = false;
const _saveTimers = {};
const _savePending = {};                    // ultimo valore da scrivere per chiave
function _fileFor(k) { return path.join(dataDir, k + '.json'); }
function saveKV(k, value) {
  _savePending[k] = value;                  // tiene SEMPRE l'ultimo valore (no snapshot stantii)
  if (_saveTimers[k]) return;               // debounce per chiave (max 1 scrittura/0.8s)
  _saveTimers[k] = setTimeout(async () => {
    _saveTimers[k] = null;
    const v = _savePending[k];              // scrive l'ultimo valore aggiornato
    if (dbReady) {
      try {
        await pgPool.query('INSERT INTO kv(k,v) VALUES($1,$2) ON CONFLICT(k) DO UPDATE SET v=$2', [k, JSON.stringify(v)]);
        return;
      } catch (e) { console.error('DB save ' + k + ' fallita, uso file:', e.message); }
    }
    fs.writeFile(_fileFor(k), JSON.stringify(v), () => {});
  }, 800);
}
// Salva SUBITO tutte le scritture in sospeso (chiamato alla chiusura: niente
// perdita dell'ultima modifica quando l'app viene riavviata/fermata).
async function flushPending() {
  for (const k of Object.keys(_savePending)) {
    if (_saveTimers[k]) { clearTimeout(_saveTimers[k]); _saveTimers[k] = null; }
    const v = _savePending[k]; delete _savePending[k];
    try {
      if (dbReady) await pgPool.query('INSERT INTO kv(k,v) VALUES($1,$2) ON CONFLICT(k) DO UPDATE SET v=$2', [k, JSON.stringify(v)]);
      else fs.writeFileSync(_fileFor(k), JSON.stringify(v));
    } catch (e) { console.error('flush ' + k + ' fallito:', e.message); }
  }
}
let _shuttingDown = false;
async function gracefulShutdown(sig) {
  if (_shuttingDown) return; _shuttingDown = true;
  console.log(`Ricevuto ${sig}: salvo i dati in sospeso e chiudo.`);
  try { await flushPending(); } catch {}
  try { if (pgPool) await pgPool.end(); } catch {}
  process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
async function initStore() {
  if (!DATABASE_URL) { console.log('Persistenza: FILE (nessun DATABASE_URL).'); return; }
  try {
    const pg = await import('pg');
    pgPool = new pg.default.Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 3 });
    await pgPool.query('CREATE TABLE IF NOT EXISTS kv (k text PRIMARY KEY, v jsonb)');
    const r = await pgPool.query("SELECT k, v FROM kv WHERE k IN ('users','usage','sessions')");
    const got = {};
    for (const row of r.rows) got[row.k] = row.v;
    if (got.users && typeof got.users === 'object') users = got.users;
    if (got.usage && typeof got.usage === 'object') usage = got.usage;
    if (Array.isArray(got.sessions)) { sessions.clear(); for (const [tk, c] of got.sessions) sessions.set(tk, c); }
    dbReady = true;
    console.log('Persistenza: POSTGRES attivo (account permanenti). 🎉');
  } catch (e) {
    console.error('Persistenza DB non disponibile, uso file:', e.message);
    dbReady = false;
  }
}
function persistSessions() { saveKV('sessions', [...sessions.entries()]); }

/** @type {Record<string, { date: string, count: number, bonus?: number }>} */
let usage = {};
try {
  usage = JSON.parse(fs.readFileSync(usageFile, 'utf8'));
} catch {
  usage = {};
}

function today() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function persistUsageSoon() { saveKV('usage', usage); }

// Un dispositivo è PRO se appartiene a un utente loggato con flag pro.
// (deviceId degli utenti loggati = "user-<contatto>").
function isProDevice(deviceId) {
  if (typeof deviceId === 'string' && deviceId.startsWith('user-')) {
    const u = users[deviceId.slice(5)];
    return !!(u && u.pro);
  }
  return false;
}

const PRO_DAILY_LIMIT = Number(process.env.PRO_DAILY_LIMIT) || 1000; // scansioni/giorno per i PRO

/** Limite giornaliero in base al piano: 1000 per i PRO, 10 (default) per gli altri. */
function dailyLimitFor(deviceId) {
  return isProDevice(deviceId) ? PRO_DAILY_LIMIT : DAILY_FREE_LIMIT;
}

/** Scansioni gratuite ancora disponibili oggi (esclude i bonus). */
function freeLeftFor(deviceId) {
  const lim = dailyLimitFor(deviceId);
  const e = usage[deviceId];
  if (!e || e.date !== today()) return lim;
  return Math.max(0, lim - e.count);
}

/** Scansioni bonus comprate col negozio (non scadono col giorno). */
function bonusFor(deviceId) {
  const e = usage[deviceId];
  return e && e.bonus ? e.bonus : 0;
}

/** Quante scansioni restano in totale (gratuite di oggi + bonus). */
function remainingFor(deviceId) {
  return freeLeftFor(deviceId) + bonusFor(deviceId);
}

/** Aggiunge scansioni bonus al dispositivo. Ritorna il nuovo totale bonus. */
function addBonus(deviceId, amount) {
  const d = today();
  let e = usage[deviceId];
  if (!e) {
    e = { date: d, count: 0, bonus: 0 };
    usage[deviceId] = e;
  }
  e.bonus = (e.bonus || 0) + amount;
  persistUsageSoon();
  return e.bonus;
}

/** Consuma una scansione: prima le gratuite di oggi, poi i bonus. */
function consume(deviceId) {
  const lim = dailyLimitFor(deviceId); // 1000 per i PRO, 10 per gli altri
  const d = today();
  let e = usage[deviceId];
  if (!e) {
    e = { date: d, count: 0, bonus: 0 };
    usage[deviceId] = e;
  }
  // Nuovo giorno: azzera il conteggio gratuito (i bonus restano).
  if (e.date !== d) {
    e.date = d;
    e.count = 0;
  }
  if (e.count < lim) {
    e.count += 1;        // usa una scansione del limite giornaliero
    persistUsageSoon();
    return true;
  }
  if ((e.bonus || 0) > 0) {
    e.bonus -= 1;        // usa una scansione bonus
    persistUsageSoon();
    return true;
  }
  return false;
}

// ============================================================
//  AUTENTICAZIONE (username, email/numero, password + codice)
// ============================================================
const usersFile = path.join(dataDir, 'users.json');
/** @type {Record<string, any>} utenti indicizzati per "contatto" normalizzato */
let users = {};
try { users = JSON.parse(fs.readFileSync(usersFile, 'utf8')); } catch { users = {}; }
function persistUsers() { saveKV('users', users); }

// Token di sessione in memoria (si azzerano al riavvio: basta rifare il login).
/** @type {Map<string,string>} token -> contatto */
const sessions = new Map();

// Hashing password con scrypt (incluso in Node, niente dipendenze).
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  const h = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(h), b = Buffer.from(hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Riconosce e normalizza il contatto: SOLO email (telefono/SMS rimosso).
function classifyContact(raw) {
  const s = String(raw || '').trim();
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) {
    return { type: 'email', value: s.toLowerCase() };
  }
  return null;
}

function genCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}
function newToken() {
  return crypto.randomBytes(24).toString('hex');
}

// Invia il codice via email (Brevo se impostato, altrimenti Resend).
// Ritorna { delivery: 'email'|'failed' }.
async function sendVerificationCode(contact, type, code) {
  if (type !== 'email') return { delivery: 'failed' };
  const html = `<p>Ciao!</p><p>Il tuo codice di verifica è:</p>
                <p style="font-size:28px;font-weight:bold;letter-spacing:4px">${code}</p>
                <p>Scade tra 10 minuti.</p>`;
  try {
    if (BREVO_API_KEY) {
      const r = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json', 'accept': 'application/json' },
        body: JSON.stringify({
          sender: parseSender(MAIL_FROM),
          to: [{ email: contact }],
          subject: 'Il tuo codice Zubra',
          htmlContent: html,
        }),
      });
      if (r.ok) return { delivery: 'email' };
      console.error('Brevo errore', r.status, await r.text().catch(() => ''));
    }
    if (RESEND_API_KEY) {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: MAIL_FROM, to: contact, subject: 'Il tuo codice Zubra', html }),
      });
      if (r.ok) return { delivery: 'email' };
      console.error('Resend errore', r.status, await r.text().catch(() => ''));
    }
  } catch (e) {
    console.error('Invio codice fallito', e);
  }
  return { delivery: 'failed' };
}

function publicUser(u) {
  return { username: u.username, contact: u.contact, contactType: u.contactType, verified: !!u.verified, pro: !!u.pro, coins: u.coins || 0, avatar: u.avatar || '' };
}

// ---- Identità dalla sessione (Bearer token); MAI dal body/query del client ----
function authUser(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const contact = token && sessions.get(token);
  return contact ? users[contact] : null;
}
const uidOf = (u) => 'user-' + u.contact; // chiave quota/uso server-side

// ---- Portafoglio monete (server-side, non manipolabile dal client) ----
function getCoinsU(u) { return u.coins || 0; }
function addCoinsU(u, n) { u.coins = Math.max(0, (u.coins || 0) + Math.round(Number(n) || 0)); persistUsers(); return u.coins; }
function spendCoinsU(u, n) { if ((u.coins || 0) < n) return false; u.coins -= n; persistUsers(); return true; }

// Pacchetti negozio: prezzi DECISI dal server (il client non può barare).
const SHOP_PACKS = { p1: { scans: 1, price: 60 }, p3: { scans: 3, price: 150 }, p10: { scans: 10, price: 400 }, p25: { scans: 25, price: 850 } };

// Pubblicità premio: cooldown + limite giornaliero.
const AD_COOLDOWN_MS = 30 * 1000;
const AD_DAILY_MAX = 30;

// Rate limiter semplice in memoria.
const rlMap = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const e = rlMap.get(key);
  if (!e || now > e.resetAt) { rlMap.set(key, { count: 1, resetAt: now + windowMs }); return true; }
  if (e.count >= max) return false;
  e.count += 1; return true;
}
// Pulizia periodica delle entry scadute (evita crescita illimitata di memoria).
setInterval(() => {
  const now = Date.now();
  for (const [k, e] of rlMap) { if (now > e.resetAt) rlMap.delete(k); }
}, 10 * 60 * 1000).unref();
// Azzera il contatore di una chiave (es. dopo un accesso riuscito).
function rateLimitReset(key) { rlMap.delete(key); }
function clientIp(req) {
  // Dietro Cloudflare usiamo cf-connecting-ip (impostato da Cloudflare, NON
  // falsificabile dal client). x-forwarded-for sarebbe spoofabile → no rate-limit.
  return String(req.headers['cf-connecting-ip'] || '').trim()
    || req.socket?.remoteAddress || 'ip';
}

// Anti-scansioni concorrenti (una per utente alla volta → niente race sulla quota).
const scanning = new Set();

// Stato utente per il client (monete + quota).
function userState(u) {
  const uid = uidOf(u);
  return {
    username: u.username, pro: !!u.pro, coins: getCoinsU(u),
    remaining: remainingFor(uid), freeLeft: freeLeftFor(uid), bonus: bonusFor(uid),
    dailyFreeLimit: DAILY_FREE_LIMIT, avatar: u.avatar || '',
  };
}

// ---- App Express ----
const app = express();
app.use(express.json({ limit: '15mb' }));

// Serve la web app statica (cartella public/) sullo stesso server.
app.use(express.static(path.join(__dirname, 'public')));

// CORS (necessario quando l'app gira come sito Web).
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/health', (_req, res) => {
  const model = AI_PROVIDER === 'minimax' ? MINIMAX_MODEL : AI_PROVIDER === 'gemini' ? GEMINI_MODEL : null;
  res.json({ ok: true, provider: AI_PROVIDER, model, dailyFreeLimit: DAILY_FREE_LIMIT });
});

// Stato dell'utente (monete + quota). Richiede login.
app.get('/me/state', (req, res) => {
  const u = authUser(req);
  if (!u) return res.status(401).json({ error: 'Non autenticato.' });
  res.json(userState(u));
});

// Negozio: acquisto pacchetto scansioni. Prezzo e monete verificati dal server.
app.post('/shop/purchase', (req, res) => {
  const u = authUser(req);
  if (!u) return res.status(401).json({ error: 'Non autenticato.' });
  const pack = SHOP_PACKS[String((req.body || {}).packId || '')];
  if (!pack) return res.status(400).json({ error: 'Pacchetto non valido.' });
  if (getCoinsU(u) < pack.price) return res.status(400).json({ error: 'Monete insufficienti.' });
  spendCoinsU(u, pack.price);
  addBonus(uidOf(u), pack.scans);
  res.json({ ok: true, ...userState(u) });
});

// Pubblicità premio: +1 scansione, con cooldown e limite giornaliero.
app.post('/ads/reward', (req, res) => {
  const u = authUser(req);
  if (!u) return res.status(401).json({ error: 'Non autenticato.' });
  const now = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  if (u.adDay !== today) { u.adDay = today; u.adCount = 0; }
  if (now - (u.lastAdAt || 0) < AD_COOLDOWN_MS) {
    return res.status(429).json({ error: 'Aspetta qualche secondo prima della prossima pubblicità.' });
  }
  if ((u.adCount || 0) >= AD_DAILY_MAX) {
    return res.status(429).json({ error: 'Hai raggiunto il massimo di pubblicità di oggi.' });
  }
  u.lastAdAt = now; u.adCount = (u.adCount || 0) + 1;
  addBonus(uidOf(u), 1);
  persistUsers();
  res.json({ ok: true, ...userState(u) });
});

// ---- Rotte autenticazione ----

// Registrazione: crea un utente NON verificato e invia un codice.
app.post('/auth/signup', async (req, res) => {
  if (!rateLimit('signup:' + clientIp(req), 8, 10 * 60 * 1000)) {
    return res.status(429).json({ error: 'Troppi tentativi. Riprova tra qualche minuto.' });
  }
  const { username, contact, password } = req.body || {};
  const uname = String(username || '').trim();
  if (uname.length < 2 || uname.length > 20) {
    return res.status(400).json({ error: 'Username tra 2 e 20 caratteri.' });
  }
  const c = classifyContact(contact);
  if (!c) return res.status(400).json({ error: 'Inserisci un indirizzo email valido.' });
  // Username univoco (case-insensitive) tranne il proprio: evita impersonazioni in classifica.
  const dupeName = Object.values(users).some((x) => x.contact !== c.value && (x.username || '').toLowerCase() === uname.toLowerCase());
  if (dupeName) return res.status(409).json({ error: 'Username già in uso. Scegline un altro.' });
  if (String(password || '').length < 6) {
    return res.status(400).json({ error: 'La password deve avere almeno 6 caratteri.' });
  }

  const existing = users[c.value];
  if (existing && existing.verified) {
    return res.status(409).json({ error: 'Questo contatto è già registrato. Fai il login.' });
  }

  const { salt, hash } = hashPassword(String(password));
  const code = genCode();
  const isPro = !!PRO_PASSWORD && String(password) === PRO_PASSWORD;  // PRO se la password è quella segreta
  users[c.value] = {
    id: existing?.id || ('u-' + crypto.randomBytes(6).toString('hex')),
    username: uname,
    contact: c.value,
    contactType: c.type,
    salt, hash,
    verified: false,
    pro: isPro,
    code,
    codeExpires: Date.now() + 10 * 60 * 1000,
    createdAt: existing?.createdAt || new Date().toISOString(),
  };
  persistUsers();

  const { delivery } = await sendVerificationCode(c.value, c.type, code);
  if (delivery !== 'email') {
    return res.status(502).json({ error: 'Non siamo riusciti a inviare l\'email. Controlla l\'indirizzo e riprova.' });
  }
  res.json({
    ok: true,
    needVerification: true,
    contact: c.value,
    contactType: c.type,
    delivery,
  });
});

// Verifica del codice (solo durante la registrazione).
app.post('/auth/verify', (req, res) => {
  if (!rateLimit('verify:' + clientIp(req), 20, 10 * 60 * 1000)) {
    return res.status(429).json({ error: 'Troppi tentativi. Riprova tra qualche minuto.' });
  }
  const { contact, code } = req.body || {};
  const c = classifyContact(contact);
  const u = c && users[c.value];
  if (!u) return res.status(404).json({ error: 'Utente non trovato.' });
  if (u.verified) return res.status(400).json({ error: 'Account già verificato. Fai il login.' });
  if (!u.code || Date.now() > u.codeExpires) {
    return res.status(400).json({ error: 'Codice scaduto. Richiedine uno nuovo.' });
  }
  // Max 5 tentativi: dopo, il codice viene invalidato (anti brute-force).
  if ((u.codeTries || 0) >= 5) {
    delete u.code; delete u.codeExpires; u.codeTries = 0; persistUsers();
    return res.status(429).json({ error: 'Troppi tentativi. Richiedi un nuovo codice.' });
  }
  if (String(code || '').trim() !== u.code) {
    u.codeTries = (u.codeTries || 0) + 1; persistUsers();
    return res.status(400).json({ error: 'Codice non corretto.' });
  }
  u.verified = true;
  delete u.code; delete u.codeExpires; delete u.codeTries;
  persistUsers();
  const token = newToken();
  sessions.set(token, u.contact); persistSessions();
  res.json({ ok: true, token, user: publicUser(u) });
});

// Rinvia un nuovo codice (registrazione).
app.post('/auth/resend', async (req, res) => {
  const { contact } = req.body || {};
  const c = classifyContact(contact);
  const u = c && users[c.value];
  if (!u) return res.status(404).json({ error: 'Utente non trovato.' });
  if (u.verified) return res.status(400).json({ error: 'Account già verificato.' });
  // Cooldown 60s tra un invio e l'altro.
  if (!rateLimit('resend:' + c.value, 1, 60 * 1000)) {
    return res.status(429).json({ error: 'Aspetta un minuto prima di chiedere un nuovo codice.' });
  }
  u.code = genCode();
  u.codeExpires = Date.now() + 10 * 60 * 1000;
  u.codeTries = 0;
  persistUsers();
  const { delivery } = await sendVerificationCode(u.contact, u.contactType, u.code);
  if (delivery !== 'email') return res.status(502).json({ error: 'Non siamo riusciti a inviare l\'email. Riprova tra poco.' });
  res.json({ ok: true, delivery });
});

// Login: solo contatto + password (nessun codice).
app.post('/auth/login', (req, res) => {
  const rlKey = 'login:' + clientIp(req);
  if (!rateLimit(rlKey, 30, 5 * 60 * 1000)) {
    return res.status(429).json({ error: 'Troppi tentativi di accesso. Riprova tra qualche minuto.' });
  }
  const { contact, password } = req.body || {};
  const c = classifyContact(contact);
  const u = c && users[c.value];
  if (!u || !verifyPassword(String(password || ''), u.salt, u.hash)) {
    return res.status(401).json({ error: 'Contatto o password errati.' });
  }
  if (!u.verified) {
    return res.status(403).json({ error: 'Account non verificato. Completa la registrazione.', needVerification: true, contact: u.contact, contactType: u.contactType });
  }
  // Accesso riuscito: azzera il contatore anti-spam per questo IP.
  rateLimitReset(rlKey);
  const token = newToken();
  sessions.set(token, u.contact); persistSessions();
  res.json({ ok: true, token, user: publicUser(u) });
});

// Password dimenticata: invia un codice di reset (se l'account esiste).
app.post('/auth/forgot', async (req, res) => {
  if (!rateLimit('forgot:' + clientIp(req), 8, 10 * 60 * 1000)) {
    return res.status(429).json({ error: 'Troppi tentativi. Riprova tra qualche minuto.' });
  }
  const c = classifyContact((req.body || {}).contact);
  const u = c && users[c.value];
  // Risposta uniforme per non rivelare se l'account esiste.
  if (!u || !u.verified) {
    return res.json({ ok: true, delivery: 'email' });
  }
  if (!rateLimit('forgotsend:' + c.value, 1, 60 * 1000)) {
    return res.status(429).json({ error: 'Aspetta un minuto prima di chiedere un nuovo codice.' });
  }
  u.resetCode = genCode();
  u.resetExpires = Date.now() + 15 * 60 * 1000;
  u.resetTries = 0;
  persistUsers();
  const { delivery } = await sendVerificationCode(u.contact, u.contactType, u.resetCode);
  res.json({ ok: true, contact: u.contact, delivery });
});

// Reset password: codice + nuova password.
app.post('/auth/reset', (req, res) => {
  if (!rateLimit('reset:' + clientIp(req), 20, 10 * 60 * 1000)) {
    return res.status(429).json({ error: 'Troppi tentativi. Riprova tra qualche minuto.' });
  }
  const { contact, code, newPassword } = req.body || {};
  const c = classifyContact(contact);
  const u = c && users[c.value];
  if (!u || !u.resetCode) return res.status(400).json({ error: 'Richiesta non valida. Richiedi un nuovo codice.' });
  if (Date.now() > u.resetExpires) {
    delete u.resetCode; delete u.resetExpires; persistUsers();
    return res.status(400).json({ error: 'Codice scaduto. Richiedine uno nuovo.' });
  }
  if ((u.resetTries || 0) >= 5) {
    delete u.resetCode; delete u.resetExpires; persistUsers();
    return res.status(429).json({ error: 'Troppi tentativi. Richiedi un nuovo codice.' });
  }
  if (String(code || '').trim() !== u.resetCode) {
    u.resetTries = (u.resetTries || 0) + 1; persistUsers();
    return res.status(400).json({ error: 'Codice non corretto.' });
  }
  if (String(newPassword || '').length < 6) {
    return res.status(400).json({ error: 'La nuova password deve avere almeno 6 caratteri.' });
  }
  const { salt, hash } = hashPassword(String(newPassword));
  u.salt = salt; u.hash = hash;
  // La nuova password può anche attivare/disattivare il PRO.
  u.pro = !!PRO_PASSWORD && String(newPassword) === PRO_PASSWORD;
  delete u.resetCode; delete u.resetExpires; delete u.resetTries;
  // Sicurezza: invalida TUTTE le sessioni esistenti di questo account
  // (se un token era stato rubato, dopo il reset non vale più).
  for (const [tk, ct] of sessions) { if (ct === u.contact) sessions.delete(tk); }
  persistUsers();
  // Reset riuscito: azzera l'anti-spam del login per questo IP.
  rateLimitReset('login:' + clientIp(req));
  const token = newToken();
  sessions.set(token, u.contact); persistSessions();
  res.json({ ok: true, token, user: publicUser(u) });
});

// Classifica mondiale delle monete (top 20). Esclude i nascosti dall'admin.
app.get('/leaderboard', (req, res) => {
  const visible = Object.values(users).filter((u) => u.verified && !u.lbHidden);
  const top = visible
    .map((u) => ({ username: u.username, coins: u.coins || 0, pro: !!u.pro, avatar: u.avatar || '' }))
    .sort((a, b) => b.coins - a.coins)
    .slice(0, 20);
  // Posizione dell'utente che chiede (se loggato).
  let me = null;
  const who = authUser(req);
  if (who) {
    const all = visible.slice().sort((a, b) => (b.coins || 0) - (a.coins || 0));
    const rank = all.findIndex((u) => u.contact === who.contact);
    me = { username: who.username, coins: who.coins || 0, rank: rank >= 0 ? rank + 1 : null, total: all.length, admin: isAdminPwdSet() };
  }
  res.json({ top, me });
});

// Solo il creatore (chi conosce la password segreta PRO) può rimuovere
// qualcuno dalla classifica. NON serve essere loggati come quell'utente.
app.post('/admin/lb-remove', (req, res) => {
  // Anti brute-force della password segreta: max 10 tentativi / 10 min per IP.
  if (!rateLimit('admin:' + clientIp(req), 10, 10 * 60 * 1000)) {
    return res.status(429).json({ error: 'Troppi tentativi. Riprova tra qualche minuto.' });
  }
  const { username, password } = req.body || {};
  if (!PRO_PASSWORD || String(password || '') !== PRO_PASSWORD) {
    return res.status(403).json({ error: 'Password segreta errata.' });
  }
  const target = Object.values(users).find((u) => u.username === String(username || ''));
  if (!target) return res.status(404).json({ error: 'Utente non trovato.' });
  target.lbHidden = true;
  persistUsers();
  res.json({ ok: true });
});
function isAdminPwdSet() { return !!PRO_PASSWORD; }

// Imposta la foto profilo (immagine di un animale catturato). Richiede login.
app.post('/me/avatar', (req, res) => {
  const u = authUser(req);
  if (!u) return res.status(401).json({ error: 'Non autenticato.' });
  const img = String((req.body || {}).image || '');
  if (img === '') { u.avatar = ''; persistUsers(); return res.json({ ok: true, avatar: '' }); } // rimuove
  if (img.length > 100 * 1024) return res.status(400).json({ error: 'Immagine troppo grande.' });
  const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(img);
  if (!m) return res.status(400).json({ error: 'Immagine non valida.' });
  // Verifica i MAGIC BYTES reali (non solo il prefisso data-url): niente payload finti.
  let head; try { head = Buffer.from(m[2].slice(0, 24), 'base64'); } catch { head = Buffer.alloc(0); }
  const isJpeg = head[0] === 0xFF && head[1] === 0xD8 && head[2] === 0xFF;
  const isPng = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4E && head[3] === 0x47;
  const isWebp = head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 && head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50;
  if (!isJpeg && !isPng && !isWebp) return res.status(400).json({ error: 'Immagine non valida.' });
  u.avatar = img;
  persistUsers();
  res.json({ ok: true, avatar: u.avatar });
});

// Premio per una partita vinta all'Arena (con cap giornaliero anti-abuso).
app.post('/game/reward', (req, res) => {
  const u = authUser(req);
  if (!u) return res.status(401).json({ error: 'Non autenticato.' });
  const today = new Date().toISOString().slice(0, 10);
  if (u.gameDay !== today) { u.gameDay = today; u.gameWins = 0; }
  if ((u.gameWins || 0) >= 15) {
    return res.status(429).json({ error: 'Hai raggiunto il massimo di premi partita di oggi.', ...userState(u) });
  }
  u.gameWins = (u.gameWins || 0) + 1;
  addCoinsU(u, 40); // +40 monete a vittoria
  res.json({ ok: true, ...userState(u) });
});

// Chi sono (ripristina la sessione dal token salvato nell'app).
app.get('/auth/me', (req, res) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const contact = sessions.get(token);
  const u = contact && users[contact];
  if (!u) return res.status(401).json({ error: 'Sessione non valida.' });
  res.json({ ok: true, user: publicUser(u) });
});

// ---- Prompt e schema per Gemini ----
const SYSTEM_PROMPT = `Sei il motore di riconoscimento di "Zubra", un'app in stile Pokédex per animali reali.
Analizza la foto e identifica l'animale inquadrato. Rispondi sempre in italiano.

Regole:
- nome_comune: il nome comune italiano dell'animale (es. "Volpe rossa").
- nome_scientifico: il nome scientifico latino (es. "Vulpes vulpes").
- razza: solo per animali domestici con razza riconoscibile (cani, gatti, cavalli, conigli...). Se la razza non è determinabile o non ha senso, stringa vuota.
- categoria: una tra mammifero, uccello, rettile, anfibio, pesce, insetto, aracnide, altro.
- rarita: rarità in stile gioco, in base a quanto è raro incontrare dal vivo questo animale, considerando lo stato di conservazione:
  * Comune: animali quotidiani (piccione, gatto, cane meticcio, mosca)
  * Non Comune: si vedono ogni tanto (riccio, ghiandaia, lucertola)
  * Rara: avvistamento notevole (volpe in città, falco pellegrino, cervo)
  * Epica: avvistamento eccezionale (lupo, aquila reale, lontra)
  * Mitica: specie molto rare o protette difficili da vedere (orso, lince, gipeto)
  * Leggendaria: specie a grave rischio o quasi impossibili da vedere (lince iberica, leopardo delle nevi, tigre dell'Amur)
  * Mega: creature eccezionali, giganti o iconiche al limite del mitologico (balena blu, squalo bianco, elefante, condor gigante)
- valore_monete: valore collezionabile in monete di gioco, coerente con la rarità: Comune 10-50, Non Comune 51-200, Rara 201-1000, Epica 1001-5000, Mitica 5001-20000, Leggendaria 20001-80000, Mega 80001-250000.
- prezzo_reale: se esiste un mercato legale (cuccioli di razza, pesci d'acquario), una stima in euro come testo, es. "800-1500 €". Per animali selvatici o specie protette scrivi "Non in vendita". Se non ha senso, stringa vuota.
- descrizione: una piccola descrizione dell'animale (2-3 frasi: aspetto, comportamento, dimensioni tipiche).
- pericolosita: una tra "Innocuo", "Poco pericoloso", "Pericoloso", "Molto pericoloso", in base al rischio reale per una persona (morsi, veleno, aggressività, malattie).
- pericolo_dettaglio: breve spiegazione del perché (1 frase). Se innocuo, spiega che è innocuo.
- prendibile: si può catturare/tenere legalmente? Risposta breve e chiara, es. "Sì, è un animale domestico", "No, è specie protetta: vietato catturarla", "Sconsigliato: serve permesso". Considera la legge italiana/UE sulla fauna protetta.
- vendibile: si può vendere legalmente? Risposta breve, es. "Sì, allevatori autorizzati", "No, il commercio è vietato (CITES/specie protetta)".
- cosa_mangia: di cosa si nutre (dieta), in modo conciso. Indica se è erbivoro/carnivoro/onnivoro e gli alimenti tipici.
- come_trovarlo: dove e come avvistarlo in natura (zone, stagione, ora del giorno, abitudini utili per trovarlo).
- habitat: com'è l'habitat ideale; se si può tenere, come ricreare un ambiente adatto (spazio, temperatura, vegetazione, acqua). Se è selvatico e non si tiene, descrivi l'ambiente naturale.
- curiosita: una curiosità breve e divertente (1-2 frasi).
- confidenza: quanto sei sicuro dell'identificazione, da 0 a 100.
- foto_sospetta: true se la foto NON sembra scattata dal vivo dall'utente con una fotocamera, ma presa da internet o falsa: screenshot, presenza di watermark/logo/testo sovrimpresso, immagine stock o promozionale, disegno/illustrazione/render 3D, foto di uno schermo o di un'altra foto, qualità/compressione tipica del web, inquadratura "da catalogo". false se sembra una foto reale e spontanea.
- motivo_sospetto: se foto_sospetta=true, spiega in pochissime parole perché (es. "sembra uno screenshot con watermark"); altrimenti stringa vuota.
- Se nella foto NON c'è un animale: e_animale=false, tutti i campi testo vuoti, valore_monete=0, confidenza=0.
- Se ci sono più animali, identifica quello più in evidenza.`;

// Schema in formato Gemini (Type in MAIUSCOLO).
const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    e_animale: { type: 'BOOLEAN' },
    nome_comune: { type: 'STRING' },
    nome_scientifico: { type: 'STRING' },
    razza: { type: 'STRING' },
    categoria: {
      type: 'STRING',
      enum: ['mammifero', 'uccello', 'rettile', 'anfibio', 'pesce', 'insetto', 'aracnide', 'altro'],
    },
    rarita: {
      type: 'STRING',
      enum: ['Comune', 'Non Comune', 'Rara', 'Epica', 'Mitica', 'Leggendaria', 'Mega'],
    },
    valore_monete: { type: 'INTEGER' },
    prezzo_reale: { type: 'STRING' },
    descrizione: { type: 'STRING' },
    pericolosita: {
      type: 'STRING',
      enum: ['Innocuo', 'Poco pericoloso', 'Pericoloso', 'Molto pericoloso'],
    },
    pericolo_dettaglio: { type: 'STRING' },
    prendibile: { type: 'STRING' },
    vendibile: { type: 'STRING' },
    cosa_mangia: { type: 'STRING' },
    come_trovarlo: { type: 'STRING' },
    habitat: { type: 'STRING' },
    curiosita: { type: 'STRING' },
    confidenza: { type: 'INTEGER' },
    foto_sospetta: { type: 'BOOLEAN' },
    motivo_sospetto: { type: 'STRING' },
  },
  required: [
    'e_animale', 'nome_comune', 'nome_scientifico', 'razza', 'categoria',
    'rarita', 'valore_monete', 'prezzo_reale', 'descrizione', 'pericolosita',
    'pericolo_dettaglio', 'prendibile', 'vendibile', 'cosa_mangia',
    'come_trovarlo', 'habitat', 'curiosita', 'confidenza',
    'foto_sospetta', 'motivo_sospetto',
  ],
};

// Istruzione JSON per provider senza schema nativo (MiniMax).
const JSON_INSTRUCTION = `Rispondi ESCLUSIVAMENTE con un oggetto JSON valido (nessun testo prima o dopo, niente markdown) con ESATTAMENTE queste chiavi:
{"e_animale":bool,"nome_comune":str,"nome_scientifico":str,"razza":str,"categoria":"mammifero|uccello|rettile|anfibio|pesce|insetto|aracnide|altro","rarita":"Comune|Non Comune|Rara|Epica|Mitica|Leggendaria|Mega","valore_monete":int,"prezzo_reale":str,"descrizione":str,"pericolosita":"Innocuo|Poco pericoloso|Pericoloso|Molto pericoloso","pericolo_dettaglio":str,"prendibile":str,"vendibile":str,"cosa_mangia":str,"come_trovarlo":str,"habitat":str,"curiosita":str,"confidenza":int,"foto_sospetta":bool,"motivo_sospetto":str}`;

// Estrae un oggetto JSON dal testo del modello (robusto a testo extra/markdown).
function parseAnimalJson(text) {
  try { return JSON.parse(text); } catch {}
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try { return JSON.parse(text.slice(a, b + 1)); } catch {}
  }
  const e = new Error('JSON non valido dalla AI');
  e.userMessage = 'Risposta AI non valida. Riprova.';
  throw e;
}

// --- Provider: Google Gemini ---
async function recognizeWithGemini(imageBase64, mimeType) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{
      role: 'user',
      parts: [
        { inlineData: { mimeType: mimeType || 'image/jpeg', data: imageBase64 } },
        { text: "Identifica l'animale in questa foto." },
      ],
    }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: RESPONSE_SCHEMA, temperature: 0.4 },
  };
  // Gemini (specie il flash gratis) a volte risponde 503 "overloaded" o 429:
  // sono transitori → riproviamo fino a 3 volte con breve attesa crescente.
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let r;
    try {
      r = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(45000),
      });
    } catch {
      lastErr = Object.assign(new Error('net'), { userMessage: 'AI non raggiungibile. Riprova tra poco.' });
      if (attempt < 3) { await sleep(700 * attempt); continue; }
      throw lastErr;
    }
    // 503 sovraccarico / 429 rate-limit / 500 → transitori: riprova
    if (r.status === 503 || r.status === 429 || r.status === 500) {
      console.error(`Gemini ${r.status} (tentativo ${attempt}/3) — riprovo`);
      lastErr = Object.assign(new Error('gemini'), { userMessage: 'Servizio AI sovraccarico. Riprova tra qualche secondo.' });
      if (attempt < 3) { await sleep(900 * attempt); continue; }
      throw lastErr;
    }
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      console.error('Errore Gemini', r.status, detail.slice(0, 300));
      throw Object.assign(new Error('gemini'), { userMessage: 'Errore del servizio AI. Riprova.' });
    }
    const data = await r.json().catch(() => null);
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      lastErr = Object.assign(new Error('empty'), { userMessage: 'Risposta AI vuota. Riprova.' });
      if (attempt < 3) { await sleep(700 * attempt); continue; }
      throw lastErr;
    }
    return parseAnimalJson(text);
  }
  throw lastErr || Object.assign(new Error('gemini'), { userMessage: 'Errore del servizio AI. Riprova.' });
}

// --- Provider: MiniMax (visione) ---
async function recognizeWithMiniMax(imageBase64, mimeType) {
  const body = {
    model: MINIMAX_MODEL,
    // M3 è un modello "che ragiona": serve spazio sia per il ragionamento sia
    // per l'output JSON, altrimenti il contenuto finale esce vuoto.
    max_tokens: 6000,
    temperature: 0.3,
    messages: [
      { role: 'system', name: 'AnimalScanner', content: SYSTEM_PROMPT + '\n\n' + JSON_INSTRUCTION },
      { role: 'user', name: 'utente', content: [
        { type: 'text', text: "Identifica l'animale in questa foto e rispondi SOLO con il JSON richiesto." },
        { type: 'image_url', image_url: { url: `data:${mimeType || 'image/jpeg'};base64,${imageBase64}` } },
      ]},
    ],
  };
  let r;
  try {
    r = await fetch(`${MINIMAX_BASE}/text/chatcompletion_v2`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${MINIMAX_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    });
  } catch {
    const e = new Error('net'); e.userMessage = 'AI non raggiungibile. Riprova tra poco.'; throw e;
  }
  const data = await r.json().catch(() => null);
  const sc = data?.base_resp?.status_code;
  if (sc && sc !== 0) {
    const msg = data.base_resp.status_msg || 'errore';
    console.error('Errore MiniMax', sc, msg);
    const e = new Error('minimax');
    e.userMessage = `MiniMax: ${msg}` + (sc === 2061 ? ' (attiva un modello nel tuo piano MiniMax)' : '');
    throw e;
  }
  const text = data?.choices?.[0]?.message?.content;
  if (!text) { const e = new Error('empty'); e.userMessage = 'Risposta AI vuota. Riprova.'; throw e; }
  return parseAnimalJson(typeof text === 'string' ? text : JSON.stringify(text));
}

// ---- Endpoint principale: riconoscimento (richiede login) ----
app.post('/scan', async (req, res) => {
  const u = authUser(req);
  if (!u) return res.status(401).json({ error: 'Non autenticato.' });

  const { imageBase64, mimeType } = req.body || {};
  if (!imageBase64 || typeof imageBase64 !== 'string' || imageBase64.length < 100
      || !/^[A-Za-z0-9+/=\s]+$/.test(imageBase64)) {
    return res.status(400).json({ error: 'Immagine mancante o non valida.' });
  }
  // mimeType validato con whitelist (finisce in una data-URL → niente iniezioni).
  const safeMime = (typeof mimeType === 'string' && /^image\/(jpeg|png|webp)$/.test(mimeType))
    ? mimeType : 'image/jpeg';
  if (AI_PROVIDER === 'none') {
    return res.status(500).json({ error: 'Server non configurato (manca la chiave AI).' });
  }

  const uid = uidOf(u);

  // Limite (gratuite di oggi + bonus). I PRO sono illimitati.
  if (remainingFor(uid) <= 0) {
    return res.status(429).json({
      error: `Hai finito le scansioni. Guarda una pubblicità 📺 o usa il negozio 🏪!`,
      ...userState(u),
    });
  }
  // Una sola scansione per volta per utente (evita doppi addebiti / race).
  if (scanning.has(uid)) {
    return res.status(429).json({ error: 'Hai già una scansione in corso, attendi.' });
  }
  scanning.add(uid);
  try {
    let result;
    try {
      result = AI_PROVIDER === 'minimax'
        ? await recognizeWithMiniMax(imageBase64, safeMime)
        : await recognizeWithGemini(imageBase64, safeMime);
    } catch (e) {
      return res.status(502).json({ error: e?.userMessage || 'Errore del servizio AI. Riprova.' });
    }

    // Ogni scansione andata a buon fine (AI ha risposto) consuma 1 quota:
    // così non si può sprecare all'infinito la quota AI con foto a caso.
    consume(uid);
    // Le monete invece solo se è un animale VERO e la foto non è sospetta.
    if (result.e_animale && !result.foto_sospetta) {
      // monete dall'AI: clamp 0..250000 (anti-gonfiaggio), poi x2 per i PRO.
      const base = Math.max(0, Math.min(250000, Math.round(Number(result.valore_monete) || 0)));
      addCoinsU(u, base * (u.pro ? 2 : 1));
    }
    return res.json({ result, ...userState(u) });
  } catch (err) {
    console.error('Errore /scan', err);
    return res.status(500).json({ error: 'Errore interno del server.' });
  } finally {
    scanning.delete(uid);
  }
});

// Gestore errori finale: risponde SEMPRE in JSON pulito (niente stack/HTML di
// Express esposto). Cattura anche il JSON malformato del body parser.
app.use((err, req, res, _next) => {
  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
    return res.status(400).json({ error: 'Richiesta non valida (JSON malformato).' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Richiesta troppo grande.' });
  }
  console.error('Errore non gestito:', err && err.message);
  return res.status(500).json({ error: 'Errore interno del server.' });
});

// Avvia lo storage (DB se disponibile) e POI il server.
initStore().finally(() => {
  // Ascolta SOLO su localhost: il traffico arriva via Caddy (reverse proxy).
  // Così la porta dell'app non è esposta sull'interfaccia pubblica.
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`Zubra backend in ascolto su http://localhost:${PORT}`);
    const modelLabel = AI_PROVIDER === 'minimax' ? `MiniMax (${MINIMAX_MODEL})` : AI_PROVIDER === 'gemini' ? GEMINI_MODEL : 'NESSUNO (configura una chiave AI)';
    console.log(`Provider AI: ${AI_PROVIDER} · Modello: ${modelLabel} · Limite gratuito/giorno: ${DAILY_FREE_LIMIT}`);
  });
});
