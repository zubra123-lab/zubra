/* ============ Animal Scanner — autenticazione ============ */
"use strict";

const AUTH_API = ""; // stesso server
// SESSION_KEY è già definito in app.js (caricato prima) — non ridichiararlo.

const _ = (id) => document.getElementById(id);

// ---- Sessione ----
function getSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; }
}
function setSession(token, user) {
  localStorage.setItem(SESSION_KEY, JSON.stringify({ token, user }));
}
function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

// Contatto in attesa di verifica (durante la registrazione).
let pendingContact = null;

// ---- UI ----
function authMsg(msg, kind) {
  const el = _("authMsg");
  el.textContent = msg || "";
  el.className = "auth-msg" + (kind ? " " + kind : "");
}
function showForm(which) {
  _("formLogin").hidden = which !== "login";
  _("formSignup").hidden = which !== "signup";
  _("formVerify").hidden = which !== "verify";
  _("tabLogin").classList.toggle("is-active", which === "login");
  _("tabSignup").classList.toggle("is-active", which === "signup");
  // le tab si vedono solo tra login e signup, non in verifica
  document.querySelector(".auth-tabs").style.display = which === "verify" ? "none" : "flex";
  authMsg("");
}
function showAuth() {
  _("authScreen").hidden = false;
  document.body.style.overflow = "hidden";
  showForm("login");
}
function hideAuth() {
  _("authScreen").hidden = true;
  document.body.style.overflow = "";
}

// Aggiorna l'header e fa ripartire i dati dell'app per l'utente.
function onLoggedIn(user) {
  const sub = _("brandSub");
  if (sub) sub.textContent = `${t("hi")} ${user.username} ${user.pro ? "⭐" : "🐾"}`;
  _("settingsBtn").hidden = false;
  _("proBadge").hidden = !user.pro;     // distintivo PRO
  hideAuth();
  // applica subito monete/PRO dall'utente loggato, poi aggiorna dal server
  if (typeof applyState === "function") applyState({ coins: user.coins, pro: user.pro });
  if (typeof renderCollection === "function") renderCollection();
  if (typeof refreshState === "function") refreshState();
}

function logout() {
  clearSession();
  if (typeof applyState === "function") applyState({ coins: 0, pro: false, remaining: "—" });
  _("settingsBtn").hidden = true;
  _("proBadge").hidden = true;
  closeSettings();
  const sub = _("brandSub");
  if (sub) sub.textContent = t("brand_sub");
  showAuth();
}

// ---- Impostazioni ----
function openSettings() {
  const s = getSession();
  const u = (s && s.user) || {};
  _("setUsername").textContent = u.username || "—";
  _("setContact").textContent = u.contact || "—";
  _("setPlan").textContent = u.pro ? t("plan_pro") : t("plan_free");
  _("settingsBackdrop").hidden = false;
  document.body.style.overflow = "hidden";
}
function closeSettings() {
  _("settingsBackdrop").hidden = true;
  document.body.style.overflow = "";
}

// ---- Chiamate API ----
async function api(path, body, method = "POST", token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = "Bearer " + token;
  const r = await fetch(AUTH_API + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

function deliveryText(delivery, devCode) {
  if (delivery === "email") return t("dl_email");
  if (delivery === "sms") return t("dl_sms");
  if (devCode) return t("dl_code") + " 👉 " + devCode;
  return t("dl_generic");
}

// ---- Azioni ----
async function doLogin(e) {
  e.preventDefault();
  const contact = _("loginContact").value.trim();
  const password = _("loginPassword").value;
  if (!contact || !password) return authMsg("Inserisci contatto e password.", "error");
  authMsg("Accesso in corso…");
  const { ok, data } = await api("/auth/login", { contact, password });
  if (!ok) {
    if (data.needVerification) {  // account creato ma non verificato
      pendingContact = data.contact;
      startVerify(data.contactType, "Devi prima verificare l'account.");
      return;
    }
    return authMsg(data.error || "Accesso non riuscito.", "error");
  }
  setSession(data.token, data.user);
  onLoggedIn(data.user);
}

async function doSignup(e) {
  e.preventDefault();
  const username = _("suUsername").value.trim();
  const contact = _("suContact").value.trim();
  const password = _("suPassword").value;
  if (!username || !contact || !password) return authMsg("Compila tutti i campi.", "error");
  authMsg("Creazione account…");
  const { ok, data } = await api("/auth/signup", { username, contact, password });
  if (!ok) return authMsg(data.error || "Registrazione non riuscita.", "error");
  pendingContact = data.contact;
  startVerify(data.contactType, deliveryText(data.delivery, data.devCode));
}

function startVerify(contactType, infoMsg) {
  showForm("verify");
  _("verifyInfo").textContent = infoMsg || "";
  _("verifyCode").value = "";
  _("verifyCode").focus();
}

async function doVerify(e) {
  e.preventDefault();
  const code = _("verifyCode").value.trim();
  if (!pendingContact) return authMsg("Sessione di verifica scaduta. Ricomincia.", "error");
  if (code.length < 4) return authMsg("Inserisci il codice ricevuto.", "error");
  authMsg("Verifica in corso…");
  const { ok, data } = await api("/auth/verify", { contact: pendingContact, code });
  if (!ok) return authMsg(data.error || "Codice non valido.", "error");
  setSession(data.token, data.user);
  pendingContact = null;
  onLoggedIn(data.user);
}

async function doResend() {
  if (!pendingContact) return;
  authMsg("Rinvio codice…");
  const { ok, data } = await api("/auth/resend", { contact: pendingContact });
  if (!ok) return authMsg(data.error || "Rinvio non riuscito.", "error");
  authMsg(deliveryText(data.delivery, data.devCode), "ok");
}

// Aggiorna i testi dinamici quando cambia la lingua (chiamata da applyLang).
function refreshDynamicTexts() {
  const s = getSession();
  const sub = _("brandSub");
  if (sub) {
    sub.textContent = (s && s.user)
      ? `${t("hi")} ${s.user.username} ${s.user.pro ? "⭐" : "🐾"}`
      : t("brand_sub");
  }
  const scanBtn = document.getElementById("btnScan");
  if (scanBtn) scanBtn.textContent = t("scan_btn");
  const plan = _("setPlan");
  if (plan && s && s.user) plan.textContent = s.user.pro ? t("plan_pro") : t("plan_free");
  if (typeof renderShop === "function" && !document.getElementById("shopBackdrop").hidden) renderShop();
  if (typeof renderCollection === "function") renderCollection();
}

// ---- Avvio ----
async function authInit() {
  _("tabLogin").addEventListener("click", () => showForm("login"));
  _("tabSignup").addEventListener("click", () => showForm("signup"));
  _("formLogin").addEventListener("submit", doLogin);
  _("formSignup").addEventListener("submit", doSignup);
  _("formVerify").addEventListener("submit", doVerify);
  _("resendBtn").addEventListener("click", doResend);
  _("backToSignup").addEventListener("click", () => showForm("signup"));

  // Impostazioni
  _("settingsBtn").addEventListener("click", openSettings);
  _("settingsClose").addEventListener("click", closeSettings);
  _("settingsBackdrop").addEventListener("click", (e) => { if (e.target === _("settingsBackdrop")) closeSettings(); });
  _("setLogout").addEventListener("click", () => { if (confirm(t("confirm_logout"))) logout(); });
  _("setClearColl").addEventListener("click", () => {
    if (!confirm(t("confirm_clear"))) return;
    localStorage.removeItem(typeof collKey === "function" ? collKey() : "animal_scanner_collection_v2");
    if (typeof renderCollection === "function") renderCollection();
    closeSettings();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSettings(); });

  // Sessione salvata? Verifichiamola col server.
  const s = getSession();
  if (s && s.token) {
    const { ok, data } = await api("/auth/me", null, "GET", s.token);
    if (ok) {
      setSession(s.token, data.user);
      onLoggedIn(data.user);
      return;
    }
    clearSession(); // token scaduto (es. server riavviato)
  }
  showAuth();
}

document.addEventListener("DOMContentLoaded", authInit);
