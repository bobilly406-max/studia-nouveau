const express = require("express");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");

const app = express();
app.set("trust proxy", 1); // derrière Render, pour lire la vraie adresse IP
const KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
// Second modèle Gemini si le premier est saturé (mettre vide pour désactiver)
const FALLBACK = process.env.GEMINI_FALLBACK_MODEL === undefined ? "gemini-3.7-flash" : process.env.GEMINI_FALLBACK_MODEL;
const GEMINI_BASE = process.env.GEMINI_BASE || "https://generativelanguage.googleapis.com";
// Claude en secours si Gemini ne répond pas (laisser la clé vide pour désactiver)
const CLAUDE_KEY = process.env.ANTHROPIC_API_KEY || "";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-haiku-4-5-20251001";
const CLAUDE_BASE = process.env.CLAUDE_BASE || "https://api.anthropic.com";
const MAX_PER_HOUR = 20;

// Langues prises en charge. Pour en ajouter une : une ligne ici + les textes du site.
const LANG_NAME = { fr: "FRANÇAIS", en: "ANGLAIS" };
const LANG_ERR = { fr: "français", en: "anglais" };
const MSG = {
  login: { fr: "Connecte-toi avec ton compte parent pour utiliser Studia.", en: "Sign in with your parent account to use Studia." },
  limit: {
    fr: (n, w) => `Tu as atteint la limite de ${n} analyses par heure. Réessaie dans environ ${w} minute${w > 1 ? "s" : ""}.`,
    en: (n, w) => `You reached the limit of ${n} scans per hour. Try again in about ${w} minute${w > 1 ? "s" : ""}.`,
  },
  image: { fr: "Image invalide. Utilise une photo JPG, PNG ou WebP.", en: "Invalid image. Use a JPG, PNG or WebP photo." },
  busy: { fr: "L'IA est très sollicitée en ce moment. Réessaie dans une minute ou deux.", en: "The AI is very busy right now. Try again in a minute or two." },
  unreadable: { fr: "Je n'ai pas réussi à lire cette leçon. Essaie avec une photo plus nette.", en: "I couldn't read this lesson. Try a sharper photo." },
};

app.use(express.json({ limit: "12mb" }));

// ---------- Application installable (PWA) : manifeste, service worker, icônes ----------
app.get("/manifest.webmanifest", (req, res) => {
  res.type("application/manifest+json").send(
    JSON.stringify({
      name: "Studia Kids",
      short_name: "Studia",
      description: "Prends ta leçon en photo : fiche, résumé et quiz.",
      start_url: "/",
      scope: "/",
      display: "standalone",
      background_color: "#F3F0FF",
      theme_color: "#6C4CF1",
      lang: "fr",
      icons: [
        { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
        { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
      ],
    })
  );
});

// Réseau d'abord (les mises à jour du site apparaissent tout de suite), cache en secours hors ligne
const SW_JS = `const V = "studia-v1";
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const r = e.request;
  if (r.method !== "GET") return;
  const u = new URL(r.url);
  if (u.origin !== location.origin || u.pathname.startsWith("/api/")) return;
  e.respondWith(
    fetch(r).then((res) => { if (res.ok) { const c = res.clone(); caches.open(V).then((ca) => ca.put(r, c)); } return res; })
      .catch(() => caches.match(r).then((m) => m || caches.match("/")))
  );
});`;
app.get("/sw.js", (req, res) => res.type("application/javascript").set("Cache-Control", "no-cache").send(SW_JS));

const CRC_T = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function pngRGBA(w, h, px) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; px.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const inEll = (x, y, cx, cy, rx, ry) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
function inTri(x, y, a, b, c) {
  const s = (p, q, r) => (p[0] - r[0]) * (q[1] - r[1]) - (q[0] - r[0]) * (p[1] - r[1]);
  const p = [x, y], d1 = s(p, a, b), d2 = s(p, b, c), d3 = s(p, c, a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}
// Le renard de Studia, dessiné dans un repère 120 x 120
function foxColor(x, y) {
  const dark = [36, 31, 74], orange = [255, 138, 43];
  if (inEll(x, y, 60, 82, 7, 5) || inEll(x, y, 42, 62, 6, 6) || inEll(x, y, 78, 62, 6, 6)) return dark;
  if (inEll(x, y, 60, 68, 46, 42)) return y > 76 && inEll(x, y, 60, 100, 40, 26) ? [255, 255, 255] : orange;
  if (inTri(x, y, [14, 12], [48, 34], [22, 64]) || inTri(x, y, [106, 12], [72, 34], [98, 64])) return orange;
  return null;
}
const iconCache = {};
function renderIcon(size) {
  if (iconCache[size]) return iconCache[size];
  const px = Buffer.alloc(size * size * 4), S = 2, sc = (size * 0.6) / 120, off = (size - 120 * sc) / 2, bg = [108, 76, 241];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < S; i++) for (let j = 0; j < S; j++) {
      const c = foxColor((x + (i + 0.5) / S - off) / sc, (y + (j + 0.5) / S - off) / sc) || bg;
      r += c[0]; g += c[1]; b += c[2];
    }
    const o = (y * size + x) * 4, n = S * S;
    px[o] = r / n; px[o + 1] = g / n; px[o + 2] = b / n; px[o + 3] = 255;
  }
  return (iconCache[size] = pngRGBA(size, size, px));
}
for (const [name, size] of [["icon-192.png", 192], ["icon-512.png", 512], ["apple-touch-icon.png", 180]]) {
  app.get("/" + name, (req, res) => res.type("image/png").set("Cache-Control", "public, max-age=86400").send(renderIcon(size)));
}

app.use(express.static(path.join(__dirname, "public")));

// Réglages publics pour les comptes parents (la clé anon est faite pour être publique)
app.get("/api/config", (req, res) =>
  res.json({ url: process.env.SUPABASE_URL || "", key: process.env.SUPABASE_ANON_KEY || "" })
);

// ---------- Connexion obligatoire : on demande à Supabase si le jeton est valide ----------
const SB_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SB_KEY = process.env.SUPABASE_ANON_KEY || "";
const needLogin = Boolean(SB_URL && SB_KEY);
const tokens = new Map(); // jeton -> { id, exp } (mémoire de 60 s pour éviter trop d'appels)

async function whoIs(token) {
  const c = tokens.get(token);
  if (c && c.exp > Date.now()) return c.id;
  const r = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  const u = await r.json();
  if (!u || !u.id) return null;
  tokens.set(token, { id: u.id, exp: Date.now() + 60000 });
  if (tokens.size > 500) for (const [k, v] of tokens) if (v.exp < Date.now()) tokens.delete(k);
  return u.id;
}

// Limite : 20 analyses par heure et par parent (ou par adresse IP sans compte)
const hits = new Map();
function limited(who) {
  const now = Date.now();
  const list = (hits.get(who) || []).filter((t) => now - t < 3600000);
  if (list.length >= MAX_PER_HOUR) {
    hits.set(who, list);
    return Math.max(1, Math.ceil((list[0] + 3600000 - now) / 60000)); // minutes à attendre
  }
  list.push(now);
  hits.set(who, list);
  return 0;
}

// Réessaie si le service est surchargé (503, 529), limité (429) ou en erreur (500)
async function withRetry(call, tries = 3) {
  let r;
  for (let i = 0; i < tries; i++) {
    r = await call();
    if (![500, 503, 529, 429].includes(r.status)) return r;
    if (i < tries - 1) await new Promise((ok) => setTimeout(ok, 2000 * (i + 1)));
  }
  return r;
}

function prompt(mode, lang) {
  const kids = mode === "kids";
  const L = LANG_NAME[lang] ? lang : "fr";
  return `Tu es Studia, un assistant de révision pour élèves. Analyse la photo d'une leçon (cahier ou manuel).
Public : ${kids ? "enfant du primaire (6 à 12 ans). Phrases très courtes, mots simples, ton très encourageant." : "adolescent de 12 à 17 ans. Ton direct et clair."}
Écris le titre, le résumé, les fiches et le quiz en ${LANG_NAME[L]}. Base-toi uniquement sur ce qui est visible sur la photo. Si la photo est illisible, réponds {"erreur":"courte explication en ${LANG_ERR[L]}"}.
Réponds UNIQUEMENT avec ce JSON, sans aucun texte autour :
{"matiere":"Maths|Français|Sciences|Histoire|Anglais|Autre","titre":"titre court de la leçon","resume":"résumé en 3 à 5 phrases","fiches":[{"q":"question ou mot clé","r":"réponse courte"}],"quiz":[{"t":"qcm","q":"question","choix":["a","b","c"],"bonne":0,"explication":"une phrase"},{"t":"qcm","q":"question","choix":["a","b","c"],"bonne":1,"explication":"une phrase"},{"t":"qcm","q":"question","choix":["a","b","c"],"bonne":2,"explication":"une phrase"},{"t":"vf","q":"affirmation à juger vraie ou fausse","bonne":true,"explication":"une phrase"},{"t":"assoc","q":"consigne courte pour associer","paires":[{"a":"mot","b":"partenaire"},{"a":"mot","b":"partenaire"},{"a":"mot","b":"partenaire"}],"explication":"une phrase"}]}
Règles : 4 à 6 fiches ; exactement 5 questions dans cet ordre : 3 "qcm", 1 "vf", 1 "assoc". Pour "qcm", "bonne" est l'index (0, 1 ou 2) de la bonne réponse et il change d'une question à l'autre. "matiere" reste toujours l'une des valeurs françaises listées, même si le texte est en anglais.`;
}

// ---------- Les trois fournisseurs : Gemini (2 modèles), puis Claude ----------
async function callGemini(model, tries, m, mode, lang) {
  const r = await withRetry(() => fetch(`${GEMINI_BASE}/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": KEY },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt(mode, lang) }, { inline_data: { mime_type: m[1], data: m[2] } }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.4 },
    }),
  }), tries);
  if (!r.ok) { console.error("Gemini", model, r.status, (await r.text()).slice(0, 200)); return { ok: false, status: r.status }; }
  const data = await r.json();
  return { ok: true, text: data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "" };
}

async function callClaude(tries, m, mode, lang) {
  const r = await withRetry(() => fetch(`${CLAUDE_BASE}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": CLAUDE_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 3000,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } },
        { type: "text", text: prompt(mode, lang) },
      ] }],
    }),
  }), tries);
  if (!r.ok) { console.error("Claude", CLAUDE_MODEL, r.status, (await r.text()).slice(0, 200)); return { ok: false, status: r.status }; }
  const data = await r.json();
  return { ok: true, text: (data.content || []).map((b) => b.text || "").join("") };
}

// ---------- Nettoyage de la réponse de l'IA ----------
const SUBJECTS = { Maths: "Maths", Math: "Maths", Mathematics: "Maths", Français: "Français", French: "Français", Sciences: "Sciences", Science: "Sciences", Histoire: "Histoire", History: "Histoire", Anglais: "Anglais", English: "Anglais" };
const str = (x) => (x == null ? "" : String(x));
function cleanQuiz(arr) {
  const out = [];
  for (const d of arr || []) {
    if (!d || typeof d.q !== "string" || !d.q.trim()) continue;
    const t = d.t || "qcm", explication = str(d.explication);
    if (t === "qcm" && Array.isArray(d.choix) && d.choix.length >= 2) {
      const choix = d.choix.slice(0, 3).map(str), bonne = Number(d.bonne);
      if (Number.isInteger(bonne) && bonne >= 0 && bonne < choix.length) out.push({ t: "qcm", q: d.q, choix, bonne, explication });
    } else if (t === "vf") {
      const v = typeof d.bonne === "boolean" ? d.bonne : /^(true|vrai)$/i.test(str(d.bonne)) ? true : /^(false|faux)$/i.test(str(d.bonne)) ? false : null;
      if (v !== null) out.push({ t: "vf", q: d.q, bonne: v, explication });
    } else if (t === "assoc" && Array.isArray(d.paires)) {
      const paires = d.paires.filter((p) => p && p.a && p.b).slice(0, 3).map((p) => ({ a: str(p.a), b: str(p.b) }));
      if (paires.length >= 2) out.push({ t: "assoc", q: d.q, paires, explication });
    }
  }
  return out;
}
function parseLesson(text) {
  const raw = JSON.parse(text.replace(/```json|```/g, "").trim());
  if (raw.erreur) return { erreur: str(raw.erreur) };
  const fiches = (Array.isArray(raw.fiches) ? raw.fiches : []).filter((f) => f && f.q && f.r).map((f) => ({ q: str(f.q), r: str(f.r) }));
  const quiz = cleanQuiz(raw.quiz);
  if (quiz.length < 3 || !fiches.length) throw new Error("format");
  return { matiere: SUBJECTS[str(raw.matiere).trim()] || "Autre", titre: str(raw.titre) || "Leçon", resume: str(raw.resume), fiches, quiz };
}

app.post("/api/analyze", async (req, res) => {
  if (!KEY && !CLAUDE_KEY) return res.status(500).json({ erreur: "Aucune clé d'IA n'est configurée sur le serveur." });
  const lg = LANG_NAME[(req.body || {}).lang] ? req.body.lang : "fr";
  let who = req.ip;
  if (needLogin) {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || "");
    const id = m ? await whoIs(m[1]).catch(() => null) : null;
    if (!id) return res.status(401).json({ erreur: MSG.login[lg] });
    who = "u:" + id;
  }
  const wait = limited(who);
  if (wait) {
    return res.status(429).json({ erreur: MSG.limit[lg](MAX_PER_HOUR, wait) });
  }

  const { image, mode } = req.body || {};
  const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(image || "");
  if (!m) return res.status(400).json({ erreur: MSG.image[lg] });

  // Ordre d'essai : Gemini, Gemini (modèle de secours), puis Claude
  const steps = [];
  if (KEY) {
    steps.push([MODEL, () => callGemini(MODEL, 2, m, mode, lg)]);
    if (FALLBACK && FALLBACK !== MODEL) steps.push([FALLBACK, () => callGemini(FALLBACK, 2, m, mode, lg)]);
  }
  if (CLAUDE_KEY) steps.push([CLAUDE_MODEL, () => callClaude(2, m, mode, lg)]);

  let busy = false;
  for (const [name, run] of steps) {
    try {
      const r = await run();
      if (!r.ok) { if ([429, 503, 529].includes(r.status)) busy = true; continue; }
      const out = parseLesson(r.text);
      if (out.erreur) return res.status(422).json({ erreur: out.erreur });
      console.log("analyse via", name);
      return res.json(out);
    } catch (e) {
      console.error("Réponse inutilisable de", name, e.message);
    }
  }
  if (busy) return res.status(503).json({ erreur: MSG.busy[lg] });
  res.status(502).json({ erreur: MSG.unreadable[lg] });
});

// ---------- Alertes aux parents par Telegram ----------
// Réglages sur Render : TELEGRAM_BOT_TOKEN, SUPABASE_SERVICE_KEY (secrète, jamais dans le site), CRON_SECRET.
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TG_BASE = process.env.TELEGRAM_BASE || "https://api.telegram.org";
const SB_SERVICE = process.env.SUPABASE_SERVICE_KEY || "";
const CRON_SECRET = process.env.CRON_SECRET || "";
const APP_TZ = process.env.APP_TZ || "America/Toronto";
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/+$/, "");
const tgEnabled = Boolean(TG_TOKEN && SB_URL && SB_SERVICE);
// Secret du webhook : calculé à partir du jeton du robot, donc rien de plus à régler
const TG_SECRET = TG_TOKEN ? crypto.createHash("sha256").update(TG_TOKEN + ":studia").digest("hex").slice(0, 40) : "";
let tgBot = process.env.TELEGRAM_BOT_USERNAME || "";

// Accès à la base avec la clé de service (réservé au serveur : il contourne les règles de confidentialité)
const sbHeaders = (extra = {}) => (SB_SERVICE.startsWith("sb_secret_") ? { apikey: SB_SERVICE, ...extra } : { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`, ...extra });
async function sbRest(pathq, { method = "GET", body, prefer } = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${pathq}`, {
    method,
    headers: sbHeaders({ "Content-Type": "application/json", ...(prefer ? { Prefer: prefer } : {}) }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Supabase ${r.status} ${text.slice(0, 160)}`);
  return text ? JSON.parse(text) : null;
}
async function tg(method, payload) {
  const r = await fetch(`${TG_BASE}/bot${TG_TOKEN}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload || {}) });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) { const e = new Error(`Telegram ${method}: ${j.description || r.status}`); e.code = j.error_code || r.status; throw e; }
  return j.result;
}
const eh = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const sendTg = (chatId, html) => tg("sendMessage", { chat_id: chatId, text: html, parse_mode: "HTML", disable_web_page_preview: true });

const rlMap = new Map();
function rateOk(key, max, ms) {
  const now = Date.now(), l = (rlMap.get(key) || []).filter((t) => now - t < ms);
  if (l.length >= max) { rlMap.set(key, l); return false; }
  l.push(now); rlMap.set(key, l); return true;
}
async function parentId(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || "");
  return m ? whoIs(m[1]).catch(() => null) : null;
}
async function myLink(id) {
  const rows = await sbRest(`tg_links?select=parent_id,chat_id,linked_at&parent_id=eq.${id}`);
  return rows && rows[0];
}
const noTg = (res) => res.status(503).json({ erreur: "Les alertes Telegram ne sont pas activées sur le serveur." });
const noLogin = (res) => res.status(401).json({ erreur: MSG.login.fr });

app.get("/api/tg/status", async (req, res) => {
  if (!tgEnabled) return res.json({ enabled: false });
  const id = await parentId(req); if (!id) return noLogin(res);
  try {
    const row = await myLink(id);
    res.json({ enabled: true, linked: Boolean(row && row.chat_id), bot: tgBot, cron: Boolean(CRON_SECRET) });
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ enabled: true, erreur: "Impossible de lire l'état de Telegram. Le SQL des alertes est-il lancé dans Supabase ?" });
  }
});

app.post("/api/tg/link", async (req, res) => {
  if (!tgEnabled) return noTg(res);
  const id = await parentId(req); if (!id) return noLogin(res);
  if (!rateOk("link:" + id, 10, 3600000)) return res.status(429).json({ erreur: "Trop d'essais. Réessaie dans un moment." });
  try {
    if (!tgBot) tgBot = (await tg("getMe")).username;
    const token = crypto.randomBytes(18).toString("base64url");
    await sbRest("tg_links?on_conflict=parent_id", { method: "POST", prefer: "resolution=merge-duplicates,return=minimal", body: { parent_id: id, token, token_at: new Date().toISOString() } });
    res.json({ url: `https://t.me/${tgBot}?start=${token}` });
  } catch (e) {
    console.error(e.message);
    res.status(502).json({ erreur: "Impossible de créer le lien Telegram. Réessaie, ou vérifie le SQL des alertes dans Supabase." });
  }
});

app.post("/api/tg/test", async (req, res) => {
  if (!tgEnabled) return noTg(res);
  const id = await parentId(req); if (!id) return noLogin(res);
  if (!rateOk("test:" + id, 10, 3600000)) return res.status(429).json({ erreur: "Trop d'essais. Réessaie dans un moment." });
  try {
    const row = await myLink(id);
    if (!row || !row.chat_id) return res.status(409).json({ erreur: "Telegram n'est pas encore connecté." });
    await sendTg(row.chat_id, "🔔 <b>Test de Studia Kids</b>\nLes alertes fonctionnent. Tu recevras un message ici quand un devoir est en retard ou qu'un examen approche.");
    res.json({ ok: true });
  } catch (e) {
    console.error(e.message);
    res.status(502).json({ erreur: "Telegram n'a pas livré le message. Reconnecte-le depuis Studia." });
  }
});

app.post("/api/tg/unlink", async (req, res) => {
  if (!tgEnabled) return noTg(res);
  const id = await parentId(req); if (!id) return noLogin(res);
  try {
    await sbRest(`tg_links?parent_id=eq.${id}`, { method: "PATCH", prefer: "return=minimal", body: { chat_id: null, token: null, sent: {} } });
    res.json({ ok: true });
  } catch (e) { console.error(e.message); res.status(500).json({ erreur: "Impossible de déconnecter Telegram." }); }
});

// Telegram appelle cette adresse quand le parent touche « Démarrer » dans la conversation avec le robot
app.post("/api/tg/webhook", async (req, res) => {
  if (!tgEnabled || req.headers["x-telegram-bot-api-secret-token"] !== TG_SECRET) return res.status(403).end();
  res.json({ ok: true });
  try { await onTgUpdate(req.body || {}); } catch (e) { console.error("Webhook Telegram :", e.message); }
});
async function onTgUpdate(u) {
  const m = u.message;
  if (!m || !m.chat || m.chat.type !== "private") return;
  const chat = m.chat.id, text = String(m.text || "").trim();
  const start = /^\/start(?:@\w+)?(?:\s+(\S+))?$/.exec(text);
  if (start) {
    const token = start[1];
    if (!token) return void (await sendTg(chat, "👋 Pour connecter ton compte, ouvre l'espace parent de Studia Kids et touche « Connecter Telegram »."));
    const rows = await sbRest(`tg_links?select=parent_id,token_at&token=eq.${encodeURIComponent(token)}`);
    const row = rows && rows[0];
    if (!row || Date.now() - Date.parse(row.token_at) > 30 * 60000) {
      return void (await sendTg(chat, "⌛ Ce lien a expiré. Retourne dans l'espace parent de Studia Kids et touche de nouveau « Connecter Telegram »."));
    }
    await sbRest(`tg_links?parent_id=eq.${row.parent_id}`, { method: "PATCH", prefer: "return=minimal", body: { chat_id: chat, linked_at: new Date().toISOString(), token: null, sent: {} } });
    return void (await sendTg(chat, "✅ <b>Connecté !</b>\nTu recevras ici les alertes de Studia Kids : devoirs en retard et examens qui approchent.\nEnvoie /stop pour les arrêter."));
  }
  if (/^\/stop\b/.test(text)) {
    await sbRest(`tg_links?chat_id=eq.${chat}`, { method: "PATCH", prefer: "return=minimal", body: { chat_id: null } });
    return void (await sendTg(chat, "🔕 Alertes arrêtées. Tu peux les rebrancher depuis l'espace parent de Studia Kids."));
  }
  await sendTg(chat, "Je suis le robot d'alertes de Studia Kids. Les réglages se font dans l'espace parent de l'application. Envoie /stop pour arrêter les alertes.");
}

// ---------- Les alertes : appelées chaque soir par un déclencheur planifié ----------
const ymdInTz = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: APP_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const dayNum = (s) => Math.round(Date.parse(String(s).slice(0, 10) + "T00:00:00Z") / 864e5);
const frIn = (n) => (n === 0 ? "aujourd'hui" : n === 1 ? "demain" : `dans ${n} jours`);

async function buildAlerts(link, today) {
  const pid = link.parent_id, sent = { ...(link.sent || {}) }, marks = {};
  const [profiles, tasks] = await Promise.all([
    sbRest(`profiles?select=id,name,av&parent_id=eq.${pid}`),
    sbRest(`tasks?select=id,profile_id,kind,title,subject,due&parent_id=eq.${pid}&done_at=is.null`),
  ]);
  const kids = new Map((profiles || []).map((p) => [p.id, p]));
  const lines = new Map(); // enfant -> lignes du message
  const exams = [];
  for (const x of tasks || []) {
    const kid = kids.get(x.profile_id); if (!kid) continue;
    const n = dayNum(x.due) - dayNum(today);
    if (x.kind === "devoir" && n < 0) {
      const late = -n, k1 = `late:${x.id}:1`, k3 = `late:${x.id}:3`;
      const fire = late >= 3 && !sent[k3] ? [k1, k3] : late >= 1 && !sent[k1] && late < 3 ? [k1] : null;
      if (!fire) continue;
      fire.forEach((k) => { marks[k] = today; });
      lines.set(kid.id, [...(lines.get(kid.id) || []), `⚠️ Devoir en retard : <b>${eh(x.title)}</b> (${eh(x.subject)}) — en retard de ${late} jour${late > 1 ? "s" : ""}`]);
    } else if (x.kind === "examen" && n >= 0) {
      const bands = [0, 1, 3, 7], T = bands.find((b) => b >= n);
      if (T === undefined || sent[`exam:${x.id}:${T}`]) continue;
      bands.filter((b) => b >= T).forEach((b) => { marks[`exam:${x.id}:${b}`] = today; });
      exams.push({ kid, x, n });
    }
  }
  if (exams.length) { // ce que l'enfant a déjà révisé dans ces matières
    const subs = [...new Set(exams.map((e) => e.x.subject))].map((s) => `"${s}"`).join(",");
    const ses = (await sbRest(`sessions?select=profile_id,matiere,score,res&parent_id=eq.${pid}&matiere=in.(${encodeURIComponent(subs)})`)) || [];
    for (const { kid, x, n } of exams) {
      const mine = ses.filter((s) => s.profile_id === kid.id && s.matiere === x.subject), done = mine.filter((s) => s.score != null && s.res && s.res.quiz);
      const avg = done.length ? Math.round((done.reduce((a, s) => a + s.score / s.res.quiz.length, 0) / done.length) * 100) : null;
      const prep = mine.length ? `${mine.length} leçon${mine.length > 1 ? "s" : ""}${avg == null ? "" : ` · quiz moyen ${avg} %`}` : "aucune leçon de cette matière pour l'instant";
      lines.set(kid.id, [...(lines.get(kid.id) || []), `🎯 Examen de ${eh(x.subject)} ${frIn(n)} : <b>${eh(x.title)}</b> — ${prep}`]);
    }
  }
  if (!lines.size) return { text: null, marks };
  const blocks = [...lines].map(([id, l]) => `<b>${eh(kids.get(id).av || "🦊")} ${eh(kids.get(id).name)}</b>\n${l.join("\n")}`);
  const late = blocks.some((b) => b.includes("Devoir en retard"));
  const text = `🔔 <b>Studia Kids</b>\n\n${blocks.join("\n\n")}${late ? "\n\n<i>« En retard » veut dire que le devoir n'est pas marqué comme fait dans Studia.</i>" : ""}${PUBLIC_URL ? `\n${PUBLIC_URL}` : ""}`;
  return { text, marks, sent };
}

async function runAlerts(dry) {
  const today = ymdInTz(), out = { today, parents: 0, messages: 0, details: [] };
  const links = (await sbRest("tg_links?select=parent_id,chat_id,sent&chat_id=not.is.null")) || [];
  for (const link of links) {
    out.parents++;
    try {
      const r = await buildAlerts(link, today);
      if (!r.text) continue;
      if (dry) { out.messages++; out.details.push({ parent: String(link.parent_id).slice(0, 8), text: r.text }); continue; }
      try { await sendTg(link.chat_id, r.text); }
      catch (e) {
        if (e.code === 403) { await sbRest(`tg_links?parent_id=eq.${link.parent_id}`, { method: "PATCH", prefer: "return=minimal", body: { chat_id: null } }); console.error("Telegram bloqué par le parent : lien supprimé"); continue; }
        throw e;
      }
      const keep = Date.now() - 90 * 864e5, sent = Object.fromEntries(Object.entries(r.sent).filter(([, d]) => Date.parse(d) > keep));
      await sbRest(`tg_links?parent_id=eq.${link.parent_id}`, { method: "PATCH", prefer: "return=minimal", body: { sent: { ...sent, ...r.marks } } });
      out.messages++;
    } catch (e) { console.error("Alerte pour un parent :", e.message); }
  }
  return out;
}

app.get("/api/cron/alerts", async (req, res) => {
  if (!tgEnabled || !CRON_SECRET) return res.status(503).json({ erreur: "Alertes non configurées sur le serveur." });
  const q = new URL(req.url, "http://x").searchParams;
  const a = Buffer.from(String(req.headers["x-cron-key"] || q.get("key") || "")), b = Buffer.from(CRON_SECRET);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(403).json({ erreur: "Clé invalide." });
  try { res.json(await runAlerts(q.get("dry") === "1")); }
  catch (e) { console.error(e.message); res.status(500).json({ erreur: "Les alertes n'ont pas pu être calculées. Le SQL des alertes est-il lancé ?" }); }
});

// Au démarrage : on dit à Telegram où envoyer les messages reçus par le robot
if (tgEnabled && PUBLIC_URL) {
  tg("setWebhook", { url: `${PUBLIC_URL}/api/tg/webhook`, secret_token: TG_SECRET, allowed_updates: ["message"] })
    .then(() => console.log("Webhook Telegram enregistré"))
    .catch((e) => console.error(e.message));
}
if (tgEnabled && !tgBot) tg("getMe").then((b) => { tgBot = b.username; }).catch((e) => console.error(e.message));

app.listen(process.env.PORT || 3000, () => console.log("Studia prêt"));
