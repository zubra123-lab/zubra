/* ============ Animal Scanner — web app ============ */
"use strict";

// Stesso server (Express serve sia la web app che le API). Puoi cambiarlo
// se il backend è altrove, es. "https://tuo-server.onrender.com".
const API_BASE = "";

const RARITIES = ["Comune", "Non Comune", "Rara", "Epica", "Mitica", "Leggendaria", "Mega"];
const RARITY_VAR = {
  "Comune": "--r-comune",
  "Non Comune": "--r-noncomune",
  "Rara": "--r-rara",
  "Epica": "--r-epica",
  "Mitica": "--r-mitica",
  "Leggendaria": "--r-leggendaria",
  "Mega": "--r-mega",
};
const DANGER_COLOR = {
  "Innocuo": "#41b65a",
  "Poco pericoloso": "#d8c84a",
  "Pericoloso": "#e08a2b",
  "Molto pericoloso": "#e5564b",
};

const STORE_KEY = "animal_scanner_collection_v2";
const SESSION_KEY = "animal_scanner_session";

// ---- Sessione / autenticazione API ----
function session() { try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; } }
function authToken() { const s = session(); return s && s.token; }
function authHeaders(json) {
  const h = {};
  if (json) h["Content-Type"] = "application/json";
  const tok = authToken(); if (tok) h["Authorization"] = "Bearer " + tok;
  return h;
}

// Stato lato server (monete + scansioni): la fonte di verità è il server.
let serverState = { coins: 0, remaining: "—", pro: false };
function applyState(d) {
  if (!d) return;
  if (typeof d.coins === "number") serverState.coins = d.coins;
  if (typeof d.pro === "boolean") serverState.pro = d.pro;
  if (d.remaining !== undefined && d.remaining !== null) serverState.remaining = d.remaining;
  renderCoins();
  setQuotaDisplay();
}

// Pacchetti acquistabili nel negozio: scansioni extra in cambio di monete.
const PACKS = [
  { id: "p1", scans: 1, price: 60, emoji: "📷", tag: "" },
  { id: "p3", scans: 3, price: 150, emoji: "📸", tag: "" },
  { id: "p10", scans: 10, price: 400, emoji: "🎟️", tag: "Conviene" },
  { id: "p25", scans: 25, price: 850, emoji: "💎", tag: "Top" },
];

// ---- Util ----
const $ = (id) => document.getElementById(id);
const rcOf = (rarita) => `var(${RARITY_VAR[rarita] || "--r-comune"})`;
const starsOf = (rarita) => "★".repeat(Math.max(1, RARITIES.indexOf(rarita) + 1));
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Chiave collezione per-utente: account diversi non condividono la collezione.
function collKey() {
  const s = session();
  return STORE_KEY + ":" + ((s && s.user && s.user.contact) || "anon");
}

// Ridimensiona un'immagine via canvas. Ritorna { dataUrl, base64, mimeType }.
function processImage(file, maxDim) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Lettura file fallita"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Immagine non valida"));
      img.onload = () => {
        let { width, height } = img;
        const scale = Math.min(1, maxDim / Math.max(width, height));
        width = Math.round(width * scale);
        height = Math.round(height * scale);
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
        resolve({
          dataUrl,
          base64: dataUrl.split(",")[1],
          mimeType: "image/jpeg",
        });
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// ---- Stato corrente della scansione ----
let pending = null; // { base64, mimeType, thumbDataUrl }

// ---- Monete (dal server) ----
function getCoins() { return serverState.coins || 0; }
function renderCoins() {
  const v = getCoins();
  const a = $("coinsNum"); if (a) a.textContent = v.toLocaleString("it-IT");
  const b = $("shopCoins"); if (b) b.textContent = v.toLocaleString("it-IT");
}

// ---- Quota ----
function isPro() { return !!serverState.pro || (() => { const s = session(); return !!(s && s.user && s.user.pro); })(); }
function setQuotaDisplay(remaining) {
  const r = (remaining !== undefined && remaining !== null) ? remaining : serverState.remaining;
  const val = isPro() ? "∞" : r;
  if (val === undefined || val === null) return;
  const q = $("quotaNum"); if (q) q.textContent = val;
  const s = $("shopScans"); if (s) s.textContent = val;
}
// Aggiorna monete + scansioni dal server (richiede login).
async function refreshState() {
  if (!authToken()) return;
  try {
    const r = await fetch(`${API_BASE}/me/state`, { headers: authHeaders(false) });
    if (!r.ok) return;
    applyState(await r.json());
  } catch { /* offline: lascia i valori attuali */ }
}

// ---- Selezione immagine ----
async function onFile(file) {
  if (!file) return;
  setStatus("Preparazione immagine…");
  try {
    // immagine per l'AI (più grande) e miniatura per la collezione (più piccola)
    const [full, thumb] = await Promise.all([
      processImage(file, 1024),
      processImage(file, 420),
    ]);
    pending = { base64: full.base64, mimeType: full.mimeType, thumbDataUrl: thumb.dataUrl };
    const prev = $("preview");
    prev.src = full.dataUrl;
    prev.hidden = false;
    $("dzInner").style.opacity = "0";
    $("dropzone").classList.add("has-image");
    $("btnScan").disabled = false;
    setStatus("Pronto. Premi «Scansiona».", "ok");
  } catch (e) {
    setStatus(e.message || "Errore con l'immagine", "error");
  }
}

// ---- Scansione ----
let scanAbort = null, scanTimer = null, scanStart = 0, busyScanning = false;

async function scan() {
  if (busyScanning || !pending) return;
  if (!authToken()) { setStatus("Devi accedere prima di scansionare.", "error"); return; }
  busyScanning = true;
  setBusy(true);
  scanStart = Date.now();
  setStatus(t("scan_progress", 0));
  clearInterval(scanTimer);
  scanTimer = setInterval(() => {
    if (busyScanning) setStatus(t("scan_progress", Math.floor((Date.now() - scanStart) / 1000)));
  }, 1000);
  scanAbort = new AbortController();
  try {
    const r = await fetch(`${API_BASE}/scan`, {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify({ imageBase64: pending.base64, mimeType: pending.mimeType }),
      signal: scanAbort.signal,
    });
    const d = await r.json().catch(() => ({}));
    applyState(d);

    if (!r.ok) { setStatus(d.error || `Errore (${r.status})`, "error"); return; }

    const result = d.result || {};
    if (!result.e_animale) { setStatus(t("no_animal"), "error"); return; }

    // Anti-imbroglio: foto sospetta (presa da internet) → non salvata, niente monete.
    if (result.foto_sospetta) {
      const why = result.motivo_sospetto ? " (" + result.motivo_sospetto + ")" : "";
      setStatus(t("photo_suspect") + why, "error");
      return;
    }

    const entry = {
      id: "e-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      result,
      image: pending.thumbDataUrl,
      scannedAt: new Date().toISOString(),
    };
    saveEntry(entry);
    renderCollection();
    openSheet(entry, true);
    resetScanner();
    setStatus("");
  } catch (e) {
    if (e && e.name === "AbortError") setStatus(t("scan_cancelled"));
    else setStatus("Connessione al server fallita. Riprova.", "error");
  } finally {
    busyScanning = false;
    clearInterval(scanTimer);
    setBusy(false);
  }
}
function cancelScan() {
  if (scanAbort) { try { scanAbort.abort(); } catch { /* ignore */ } }
}

function setBusy(b) {
  $("scanline").hidden = !b;
  if (b) {
    $("btnScan").disabled = false;            // resta cliccabile per annullare
    $("btnScan").textContent = t("scan_cancel");
    $("btnScan").classList.add("is-cancel");
  } else {
    $("btnScan").disabled = !pending;
    $("btnScan").textContent = t("scan_btn");
    $("btnScan").classList.remove("is-cancel");
  }
}
function setStatus(msg, kind) {
  const el = $("status");
  el.textContent = msg || "";
  el.className = "status" + (kind ? " " + kind : "");
}
function resetScanner() {
  pending = null;
  $("preview").hidden = true;
  $("preview").src = "";
  $("dzInner").style.opacity = "1";
  $("dropzone").classList.remove("has-image");
  $("btnScan").disabled = true;
}

// ---- Collezione (localStorage) ----
function loadCollection() {
  try { return JSON.parse(localStorage.getItem(collKey())) || []; }
  catch { return []; }
}
function saveCollection(list) {
  try { localStorage.setItem(collKey(), JSON.stringify(list)); }
  catch (e) { console.warn("Storage pieno", e); }
}
function saveEntry(entry) {
  const list = loadCollection();
  list.unshift(entry);
  saveCollection(list);
}
function deleteEntry(id) {
  saveCollection(loadCollection().filter((e) => e.id !== id));
  renderCollection();
}

function renderCollection() {
  const list = loadCollection();
  const grid = $("collGrid");
  $("collCount").textContent = list.length;
  $("collEmpty").style.display = list.length ? "none" : "block";
  grid.innerHTML = "";
  list.forEach((entry, i) => {
    const r = entry.result;
    const el = document.createElement("div");
    el.className = "cardlet";
    el.style.setProperty("--rc", rcOf(r.rarita));
    el.style.animationDelay = Math.min(i * 0.04, 0.4) + "s";
    el.innerHTML = `
      <img src="${esc(entry.image)}" alt="${esc(r.nome_comune)}" loading="lazy" />
      <div class="cl-glow"></div>
      <div class="cl-body">
        <div class="cl-name">${esc(r.nome_comune)}</div>
        <div class="cl-rar">${esc(r.rarita)}</div>
      </div>`;
    el.addEventListener("click", () => openSheet(entry, false));
    grid.appendChild(el);
  });
}

// ---- Scheda animale ----
function infoCard(icon, label, text, cls) {
  if (!text) return "";
  return `
    <div class="info-card ${cls || ""}">
      <div class="i-head"><span class="i-ico">${icon}</span><span class="i-lbl">${label}</span></div>
      <div class="i-txt">${esc(text)}</div>
    </div>`;
}

function openSheet(entry, isNew) {
  const r = entry.result;
  const rc = rcOf(r.rarita);
  const dangerCol = DANGER_COLOR[r.pericolosita] || "var(--ink-soft)";

  const stats = [
    `<div class="stat"><div class="s-lbl">◭ ${t("r_category")}</div><div class="s-val">${esc(cap(r.categoria))}</div></div>`,
    r.razza ? `<div class="stat"><div class="s-lbl">⬡ ${t("r_breed")}</div><div class="s-val">${esc(r.razza)}</div></div>` : "",
    `<div class="stat coins"><div class="s-lbl">◉ ${t("r_coins")}</div><div class="s-val">${Number(r.valore_monete || 0).toLocaleString("it-IT")} 🪙</div></div>`,
    r.prezzo_reale ? `<div class="stat"><div class="s-lbl">€ ${t("r_price")}</div><div class="s-val">${esc(r.prezzo_reale)}</div></div>` : "",
  ].join("");

  const sheet = $("sheet");
  sheet.style.setProperty("--rc", rc);
  $("sheetScroll").innerHTML = `
    <div class="hero">
      <img src="${esc(entry.image)}" alt="${esc(r.nome_comune)}" />
      <div class="hero-glow"></div>
      <div class="hero-cap">
        <div class="hero-name">${esc(r.nome_comune)}</div>
        ${r.nome_scientifico ? `<div class="hero-sci">${esc(r.nome_scientifico)}</div>` : ""}
      </div>
    </div>

    <div class="rar-row">
      <span class="rar-badge">${esc(r.rarita)} <span class="rar-stars">${starsOf(r.rarita)}</span></span>
      ${isNew ? `<span class="conf" style="color:var(--accent-2);border-color:rgba(111,212,154,.4)">${t("r_captured")}</span>` : ""}
      <span class="conf">${t("r_confidence")} ${Number(r.confidenza || 0)}%</span>
    </div>

    <div class="stats">${stats}</div>

    ${r.descrizione ? `<div class="info">${infoCard("📖", t("r_desc"), r.descrizione)}</div>` : ""}

    <div class="info">
      ${r.pericolosita ? `
        <div class="info-card ${r.pericolosita === "Innocuo" ? "good" : "bad"}">
          <div class="i-head"><span class="i-ico">⚠</span><span class="i-lbl">${t("r_danger")}</span></div>
          <div class="i-txt">
            <span class="danger-chip" style="color:${dangerCol}"><span class="dot" style="color:${dangerCol}"></span>${esc(r.pericolosita)}</span>
            ${r.pericolo_dettaglio ? `<div style="margin-top:6px;color:var(--ink-soft)">${esc(r.pericolo_dettaglio)}</div>` : ""}
          </div>
        </div>` : ""}
      ${infoCard("🪤", t("r_takeable"), r.prendibile, prendibileClass(r.prendibile))}
      ${infoCard("💰", t("r_sellable"), r.vendibile, vendibileClass(r.vendibile))}
      ${infoCard("🍽", t("r_eats"), r.cosa_mangia)}
      ${infoCard("🔭", t("r_find"), r.come_trovarlo)}
      ${infoCard("🌿", t("r_habitat"), r.habitat)}
    </div>

    ${r.curiosita ? `
      <div class="curio">
        <div class="i-head"><span class="i-ico">💡</span><span class="i-lbl">${t("r_didyouknow")}</span></div>
        <div class="i-txt">${esc(r.curiosita)}</div>
      </div>` : ""}

    <div class="sheet-foot">
      <button class="btn btn-danger" id="btnDelete" type="button">${t("r_delete")}</button>
      <button class="btn btn-primary" id="btnCloseSheet" type="button">${isNew ? t("r_add") : t("r_close")}</button>
    </div>
  `;

  $("btnDelete").addEventListener("click", () => {
    if (confirm(`Eliminare "${r.nome_comune}" dalla collezione?`)) {
      deleteEntry(entry.id);
      closeSheet();
    }
  });
  $("btnCloseSheet").addEventListener("click", closeSheet);

  $("sheetBackdrop").hidden = false;
  document.body.style.overflow = "hidden";
}
function closeSheet() {
  $("sheetBackdrop").hidden = true;
  document.body.style.overflow = "";
}

// euristiche per colorare "prendibile"/"vendibile"
function prendibileClass(t) {
  const s = (t || "").toLowerCase();
  if (/^s[iì]\b|domestic|consentit|legal/.test(s)) return "good";
  if (/\bno\b|vietat|protett|illegal|sconsigli/.test(s)) return "bad";
  return "";
}
function vendibileClass(t) {
  const s = (t || "").toLowerCase();
  if (/^s[iì]\b|consentit|autorizzat|legal/.test(s)) return "good";
  if (/\bno\b|vietat|protett|illegal|cites/.test(s)) return "bad";
  return "";
}

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// ---- Collezione (modale) ----
function openCollection() {
  renderCollection();
  $("collBackdrop").hidden = false;
  document.body.style.overflow = "hidden";
}
function closeCollection() {
  $("collBackdrop").hidden = true;
  document.body.style.overflow = "";
}

// ---- Classifica mondiale ----
function closeLeaderboard() {
  $("lbBackdrop").hidden = true;
  document.body.style.overflow = "";
}
async function openLeaderboard() {
  $("lbList").innerHTML = `<p class="shop-msg">…</p>`;
  $("lbMe").textContent = "";
  $("lbBackdrop").hidden = false;
  document.body.style.overflow = "hidden";
  try {
    const r = await fetch(`${API_BASE}/leaderboard`, { headers: authHeaders(false) });
    const d = await r.json().catch(() => ({}));
    const top = (d && d.top) || [];
    if (!top.length) { $("lbList").innerHTML = `<p class="coll-empty">${t("lb_empty")}</p>`; return; }
    const medal = (i) => (i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `#${i + 1}`);
    const me = d.me && d.me.username;
    $("lbList").innerHTML = top.map((u, i) => `
      <div class="lb-row${me && u.username === me ? " is-me" : ""}">
        <span class="lb-rank">${medal(i)}</span>
        <span class="lb-name">${esc(u.username)}${u.pro ? " ⭐" : ""}</span>
        <span class="lb-coins">🪙 ${Number(u.coins || 0).toLocaleString("it-IT")}</span>
      </div>`).join("");
    if (d.me && d.me.rank) $("lbMe").textContent = t("lb_you", d.me.rank, d.me.total);
  } catch {
    $("lbList").innerHTML = `<p class="shop-msg error">Server non raggiungibile.</p>`;
  }
}

// ---- Pubblicità premio (guarda un annuncio -> 1 scansione gratis) ----
const FAKE_ADS = [
  { emoji: "🦁", title: "SUPER ZOO", line: "Vieni a vedere gli animali più rari del mondo!" },
  { emoji: "🍔", title: "Mega Burger", line: "Il panino più grande della galassia. Provalo!" },
  { emoji: "🚀", title: "SpaceToys", line: "I giocattoli spaziali che tutti vogliono!" },
  { emoji: "🍫", title: "ChocoBoom", line: "Cioccolato che esplode di gusto!" },
  { emoji: "🎮", title: "PixelQuest", line: "Il gioco n°1 — scaricalo gratis ora!" },
  { emoji: "🐶", title: "WoofSnack", line: "Crocchette felici per cani felici!" },
];
let adTimer = null;
function adMsg(msg, kind) {
  const el = $("adMsg");
  if (!el) return;
  el.textContent = msg || "";
  el.className = "shop-msg" + (kind ? " " + kind : "");
}
function openAd() {
  const ad = FAKE_ADS[Math.floor(Math.random() * FAKE_ADS.length)];
  $("adBox").innerHTML =
    `<div class="ad-emoji">${ad.emoji}</div>
     <div class="ad-title2">${ad.title}</div>
     <div class="ad-line">${ad.line}</div>`;
  adMsg("");
  const claim = $("adClaim");
  let s = 5;
  claim.disabled = true;
  claim.textContent = t("ad_wait", s);
  clearInterval(adTimer);
  adTimer = setInterval(() => {
    s -= 1;
    if (s > 0) {
      claim.textContent = t("ad_wait", s);
    } else {
      clearInterval(adTimer);
      claim.disabled = false;
      claim.textContent = t("ad_claim");
    }
  }, 1000);
  $("adBackdrop").hidden = false;
  document.body.style.overflow = "hidden";
}
function closeAd() {
  clearInterval(adTimer);
  $("adBackdrop").hidden = true;
  document.body.style.overflow = "";
}
async function claimAd() {
  const claim = $("adClaim");
  claim.disabled = true;
  adMsg("…");
  try {
    const r = await fetch(`${API_BASE}/ads/reward`, {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify({}),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) { adMsg(d.error || "Errore. Riprova.", "error"); claim.disabled = false; return; }
    applyState(d);
    adMsg(t("ad_done"), "ok");
    setTimeout(closeAd, 1200);
  } catch {
    adMsg("Server non raggiungibile.", "error");
    claim.disabled = false;
  }
}

// ---- Negozio ----
function openShop() {
  renderShop();
  shopMsg("");
  refreshState();
  $("shopBackdrop").hidden = false;
  document.body.style.overflow = "hidden";
}
function closeShop() {
  $("shopBackdrop").hidden = true;
  document.body.style.overflow = "";
}
function shopMsg(msg, kind) {
  const el = $("shopMsg");
  if (!el) return;
  el.textContent = msg || "";
  el.className = "shop-msg" + (kind ? " " + kind : "");
}
function renderShop() {
  renderCoins();
  const coins = getCoins();
  const grid = $("shopGrid");
  grid.innerHTML = "";
  PACKS.forEach((p) => {
    const can = coins >= p.price;
    const el = document.createElement("div");
    el.className = "pack" + (p.tag ? " best" : "");
    el.innerHTML = `
      <div class="pack-emoji">${p.emoji}</div>
      <div class="pack-info">
        <div class="pack-scans">${p.scans} <small>${t("scans_word")}</small>${p.tag ? ` <span class="pack-tag">${esc(p.tag)}</span>` : ""}</div>
        <div class="pack-price">🪙 ${p.price.toLocaleString("it-IT")} ${t("coins_word")}</div>
      </div>
      <button class="pack-buy" type="button" ${can ? "" : "disabled"}>${can ? t("buy") : "🔒"}</button>`;
    el.querySelector(".pack-buy").addEventListener("click", () => buyPack(p));
    grid.appendChild(el);
  });
}
async function buyPack(pack) {
  if (getCoins() < pack.price) { shopMsg(t("not_enough"), "error"); return; }
  document.querySelectorAll(".pack-buy").forEach((b) => (b.disabled = true));
  shopMsg("…");
  try {
    const r = await fetch(`${API_BASE}/shop/purchase`, {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify({ packId: pack.id }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) {
      shopMsg(d.error || "Acquisto non riuscito. Riprova.", "error");
      renderShop();
      return;
    }
    applyState(d);                       // monete e scansioni aggiornate dal server
    shopMsg(t("buy_done", pack.scans), "ok");
    renderShop();
  } catch {
    shopMsg("Server non raggiungibile. Riprova.", "error");
    renderShop();
  }
}

// ---- Eventi ----
function init() {
  const dz = $("dropzone");
  const input = $("fileInput");

  input.addEventListener("change", (e) => onFile(e.target.files[0]));
  $("btnGallery").addEventListener("click", (e) => { e.preventDefault(); input.removeAttribute("capture"); input.click(); });
  $("btnScan").addEventListener("click", () => (busyScanning ? cancelScan() : scan()));

  // drag & drop (desktop)
  ["dragenter", "dragover"].forEach((ev) =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("dragover"); }));
  ["dragleave", "drop"].forEach((ev) =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("dragover"); }));
  dz.addEventListener("drop", (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (f) onFile(f);
  });
  // ripristina capture quando si riapre dalla dropzone (foto)
  dz.addEventListener("click", () => input.setAttribute("capture", "environment"));

  $("sheetClose").addEventListener("click", closeSheet);
  $("sheetBackdrop").addEventListener("click", (e) => { if (e.target === $("sheetBackdrop")) closeSheet(); });

  // Pubblicità premio
  $("adBtn").addEventListener("click", openAd);
  $("adClose").addEventListener("click", closeAd);
  $("adClaim").addEventListener("click", claimAd);
  $("adBackdrop").addEventListener("click", (e) => { if (e.target === $("adBackdrop")) closeAd(); });

  // Classifica
  $("lbBtn").addEventListener("click", openLeaderboard);
  $("lbClose").addEventListener("click", closeLeaderboard);
  $("lbBackdrop").addEventListener("click", (e) => { if (e.target === $("lbBackdrop")) closeLeaderboard(); });

  // Negozio
  $("shopBtn").addEventListener("click", openShop);
  $("shopClose").addEventListener("click", closeShop);
  $("shopBackdrop").addEventListener("click", (e) => { if (e.target === $("shopBackdrop")) closeShop(); });

  // Collezione
  $("collBtn").addEventListener("click", openCollection);
  $("collCloseBtn").addEventListener("click", closeCollection);
  $("collBackdrop").addEventListener("click", (e) => { if (e.target === $("collBackdrop")) closeCollection(); });

  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeSheet(); closeShop(); closeCollection(); closeAd(); closeLeaderboard(); } });

  renderCoins();
  renderCollection();
  refreshState();
}

document.addEventListener("DOMContentLoaded", init);
