const express = require("express");
const path = require("path");
const fs = require("fs");
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
  unreadableCal: { fr: "Je n'ai pas réussi à lire ce calendrier. Essaie avec une photo plus nette, bien éclairée, en cadrant toute la page.", en: "I couldn't read this calendar. Try a sharper, well-lit photo that shows the whole page." },
};

app.use(express.json({ limit: "12mb" }));

// ---------- Application installable (PWA) : manifeste, service worker, icônes ----------
const VERSIONS = {
  kids: { name: "Studia Kids", short: "Studia Kids", desc: "Prends ta leçon en photo : fiche, résumé et quiz pour les enfants.", bg: "#F6F4FF", theme: "#6C4CF1", icon: "icon" },
  studia: { name: "Studia", short: "Studia", desc: "Prends une leçon en photo : résumé, fiches, quiz et agenda.", bg: "#F6F4FF", theme: "#2F5BD6", icon: "studia-icon" },
};
function manifestFor(k) {
  const v = VERSIONS[k];
  return JSON.stringify({
    name: v.name, short_name: v.short, description: v.desc,
    id: `/${k}/app`, start_url: `/${k}/app`, scope: `/${k}/`, display: "standalone", lang: "fr",
    background_color: v.bg, theme_color: v.theme,
    icons: [
      { src: `/${v.icon}-192.png`, sizes: "192x192", type: "image/png", purpose: "any maskable" },
      { src: `/${v.icon}-512.png`, sizes: "512x512", type: "image/png", purpose: "any maskable" },
    ],
  });
}
for (const k of Object.keys(VERSIONS)) {
  app.get(`/${k}/manifest.webmanifest`, (req, res) => res.type("application/manifest+json").send(manifestFor(k)));
}
app.get("/manifest.webmanifest", (req, res) => res.type("application/manifest+json").send(manifestFor("kids"))); // anciens liens

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
      .catch(() => caches.match(r).then((m) => m || caches.match(u.pathname.startsWith("/studia") ? "/studia/app" : "/kids/app")))
  );
});
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { b: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.t || "Studia", {
    body: d.b || "", icon: d.i || "/icon-192.png", badge: d.i || "/icon-192.png", tag: d.g || "studia", renotify: true, lang: d.l || "fr", data: { u: d.u || "/" },
  }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.u) || "/", self.location.origin);
  const prefix = url.pathname.startsWith("/studia") ? "/studia" : "/kids";
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cs) => {
    const c = cs.find((x) => new URL(x.url).pathname.startsWith(prefix));
    if (c) return c.navigate(url.href).then((w) => (w || c).focus()).catch(() => c.focus());
    return self.clients.openWindow(url.href);
  }));
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
const inPoly = (x, y, p) => { let c = false; for (let i = 0, j = p.length - 1; i < p.length; j = i++) { if ((p[i][1] > y) !== (p[j][1] > y) && x < ((p[j][0] - p[i][0]) * (y - p[i][1])) / (p[j][1] - p[i][1]) + p[i][0]) c = !c; } return c; };
// La toque de Studia, dans un repère 120 x 120
function capColor(x, y) {
  if (inEll(x, y, 108, 90, 6, 6) || (x > 105.5 && x < 110.5 && y > 52 && y < 90)) return [255, 176, 32];
  if (inPoly(x, y, [[60, 22], [116, 50], [60, 78], [4, 50]])) return [92, 160, 255];
  if (inPoly(x, y, [[26, 62], [60, 78], [94, 62], [94, 88], [60, 104], [26, 88]])) return [140, 104, 255];
  return null;
}
const iconCache = {};
function renderIcon(size, kind) {
  const key = kind + size;
  if (iconCache[key]) return iconCache[key];
  const px = Buffer.alloc(size * size * 4), S = 2, sc = (size * 0.6) / 120, off = (size - 120 * sc) / 2, bg = kind === "studia" ? [36, 31, 74] : [108, 76, 241], draw = kind === "studia" ? capColor : foxColor;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < S; i++) for (let j = 0; j < S; j++) {
      const c = draw((x + (i + 0.5) / S - off) / sc, (y + (j + 0.5) / S - off) / sc) || bg;
      r += c[0]; g += c[1]; b += c[2];
    }
    const o = (y * size + x) * 4, n = S * S;
    px[o] = r / n; px[o + 1] = g / n; px[o + 2] = b / n; px[o + 3] = 255;
  }
  return (iconCache[key] = pngRGBA(size, size, px));
}
for (const [name, size, kind] of [["icon-192.png", 192, "kids"], ["icon-512.png", 512, "kids"], ["apple-touch-icon.png", 180, "kids"], ["studia-icon-192.png", 192, "studia"], ["studia-icon-512.png", 512, "studia"], ["studia-apple-touch-icon.png", 180, "studia"]]) {
  app.get("/" + name, (req, res) => res.type("image/png").set("Cache-Control", "public, max-age=86400").send(renderIcon(size, kind)));
}

// Une seule adresse, deux versions : « / » = choix, « /kids » et « /studia » = présentations,
// « /kids/app » et « /studia/app » = les applications, « /confidentialite » et « /conditions » = pages légales (communes)
const APP_HTML = fs.readFileSync(path.join(__dirname, "public", "app.html"), "utf8");
const APP_PAGES = {
  kids: APP_HTML,
  studia: APP_HTML.replace("<title>Studia Kids — Apprends. Explore. Brille à ta façon.</title>", "<title>Studia — Étudie à ton rythme</title>").replace('href="/apple-touch-icon.png"', 'href="/studia-apple-touch-icon.png"').replace('<meta name="theme-color" content="#6C4CF1">', '<meta name="theme-color" content="#2F5BD6">'),
};
for (const k of Object.keys(APP_PAGES)) {
  APP_PAGES[k] = APP_PAGES[k].replace('href="/manifest.webmanifest"', `href="/${k}/manifest.webmanifest"`);
  app.get(`/${k}/app`, (req, res) => res.type("html").set("Cache-Control", "no-cache").send(APP_PAGES[k]));
}
// Ancienne adresse de l'application : on garde les liens et les installations existants
app.get("/app", (req, res) => res.redirect(301, "/kids/app" + (req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "")));
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

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

function prompt(mode, lang, n = 10) {
  const kids = mode === "kids";
  const na = Math.max(1, Math.round(n / 5)), nv = na, nq = n - na - nv; // 5 -> 3+1+1 ; 10 -> 6+2+2 ; 15 -> 9+3+3
  const L = LANG_NAME[lang] ? lang : "fr";
  return `Tu es Studia, un assistant de révision pour élèves. Analyse la photo d'une leçon (cahier ou manuel).
Public : ${kids ? "enfant du primaire (6 à 12 ans). Phrases très courtes, mots simples, ton très encourageant." : "personne de tout âge (élève, étudiant ou adulte en formation). Ton direct, clair et neutre."}
Écris le titre, le résumé, les fiches et le quiz en ${LANG_NAME[L]}. Base-toi uniquement sur ce qui est visible sur la photo. Si la photo est illisible, réponds {"erreur":"courte explication en ${LANG_ERR[L]}"}.
Réponds UNIQUEMENT avec ce JSON, sans aucun texte autour :
{"matiere":"Maths|Français|Sciences|Histoire|Anglais|Autre","titre":"titre court de la leçon","resume":"résumé en 3 à 5 phrases","fiches":[{"q":"question ou mot clé","r":"réponse courte"}],"quiz":[{"t":"qcm","q":"question","choix":["a","b","c"],"bonne":0,"explication":"une phrase"},{"t":"vf","q":"affirmation à juger vraie ou fausse","bonne":true,"explication":"une phrase"},{"t":"assoc","q":"consigne courte pour associer","paires":[{"a":"mot","b":"partenaire"},{"a":"mot","b":"partenaire"},{"a":"mot","b":"partenaire"}],"explication":"une phrase"}]}
Règles : ${n - 1} à ${n + 1} fiches ; exactement ${n} questions dans cet ordre : ${nq} "qcm", ${nv} "vf", ${na} "assoc" (chaque type est répété autant de fois que demandé, sans jamais répéter la même question). Si la leçon est trop courte pour autant de fiches ou de questions, fais-en moins, mais au moins 5 questions. Pour "qcm", "bonne" est l'index (0, 1 ou 2) de la bonne réponse et il change d'une question à l'autre. "matiere" reste toujours l'une des valeurs françaises listées, même si le texte est en anglais.`;
}

// ---------- Les trois fournisseurs : Gemini (2 modèles), puis Claude ----------
const GEMINI_TIMEOUT = Number(process.env.GEMINI_TIMEOUT_MS) || 70000, AI_BUDGET = Number(process.env.AI_BUDGET_MS) || 85000;
// Une IA qui ne répond pas à temps devient une erreur « occupée » (504), pas une connexion coupée
const timed = (p) => p.catch((e) => ({ ok: false, status: 504, text: async () => String(e && e.name), json: async () => ({}) }));
async function callGemini(model, tries, m, promptText, temp = 0.4, cfg = {}, timeoutMs = GEMINI_TIMEOUT) {
  const go = (extra) => withRetry(() => timed(fetch(`${GEMINI_BASE}/v1beta/models/${model}:generateContent`, {
    signal: AbortSignal.timeout(timeoutMs),
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": KEY },
    body: JSON.stringify({
      contents: [{ parts: [{ text: promptText }, { inline_data: { mime_type: m[1], data: m[2] } }] }],
      generationConfig: { responseMimeType: "application/json", temperature: temp, ...extra },
    }),
  })), tries);
  let r = await go(cfg);
  if (!r.ok && r.status === 400 && Object.keys(cfg).length) {
    console.warn("Gemini", model, "a refusé les options", Object.keys(cfg).join(", "), "→ nouvel essai sans elles");
    r = await go({});
  }
  if (!r.ok) { console.error("Gemini", model, r.status, (await r.text()).slice(0, 200)); return { ok: false, status: r.status }; }
  const data = await r.json();
  return { ok: true, text: data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "" };
}

async function callClaude(tries, m, promptText, maxTokens = 3000, timeoutMs = GEMINI_TIMEOUT) {
  const r = await withRetry(() => timed(fetch(`${CLAUDE_BASE}/v1/messages`, {
    signal: AbortSignal.timeout(timeoutMs),
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": CLAUDE_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } },
        { type: "text", text: promptText },
      ] }],
    }),
  })), tries);
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
function parseLesson(text, n = 10) {
  const raw = JSON.parse(text.replace(/```json|```/g, "").trim());
  if (raw.erreur) return { erreur: str(raw.erreur) };
  const fiches = (Array.isArray(raw.fiches) ? raw.fiches : []).filter((f) => f && f.q && f.r).map((f) => ({ q: str(f.q), r: str(f.r) })).slice(0, n + 1);
  const quiz = cleanQuiz(raw.quiz).slice(0, n);
  if (quiz.length < 3 || !fiches.length) throw new Error("format");
  return { matiere: SUBJECTS[str(raw.matiere).trim()] || "Autre", titre: str(raw.titre) || "Leçon", resume: str(raw.resume), fiches, quiz };
}

// ---------- Lecture d'un calendrier scolaire manuscrit ----------
// Modèle Gemini réservé à la lecture des calendriers (facultatif) : GEMINI_AGENDA_MODEL sur Render
const AGENDA_MODEL = process.env.GEMINI_AGENDA_MODEL || "";
const JOURS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
const isoOk = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d + "T00:00:00Z")) && new Date(d + "T00:00:00Z").toISOString().slice(0, 10) === d;
const shiftDay = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
function agendaPrompt(lang, today) {
  const L = LANG_NAME[lang] ? lang : "fr";
  const jour = JOURS[new Date(today + "T12:00:00Z").getUTCDay()];
  return `Tu es Studia. Tu lis la photo d'un calendrier ou d'un agenda scolaire, souvent écrit à la main, rapporté de l'école (une semaine, parfois un mois).
Aujourd'hui, nous sommes le ${today} (${jour}). Les dates "due" s'écrivent AAAA-MM-JJ.
Procède dans cet ordre :
1. Repère la structure : une colonne ou une ligne par jour ? les noms des jours (lundi, mardi…) ? des dates imprimées ou écrites ? le mois et l'année ?
2. "periode" : la première date visible sur le calendrier (par exemple le lundi d'une semaine) : son jour de la semaine ("jour"), son numéro ("jj"), son mois en chiffres ("mm") et son année ("aaaa"), seulement s'ils sont écrits, sinon null.
3. Pour chaque devoir ou examen écrit, donne une entrée. Recopie ce qui est écrit, n'invente rien.
- "kind" : "examen" pour un examen, un contrôle, un test, une évaluation, une épreuve, un quiz noté, une dictée notée ou une présentation orale évaluée ; "devoir" pour un devoir, des exercices, une leçon à étudier, une lecture, un travail ou un projet à remettre. Ignore le reste (congés, sorties, rappels de matériel, photo scolaire, activités sans travail à faire).
- "jour" : le jour de la semaine où le travail est à remettre ou où l'examen a lieu. C'est celui de la case, sauf si le texte précise une échéance ("pour jeudi", "à remettre le 12") : prends alors cette échéance.
- "jj", "mm", "aaaa" : le numéro du jour, le mois (1 à 12) et l'année, SEULEMENT s'ils sont écrits ou imprimés pour cette entrée ; sinon null.
- "due" : ta meilleure date AAAA-MM-JJ si tu peux la déduire, sinon null.
- "subject" : Maths|Français|Sciences|Histoire|Anglais|Autre, selon le contenu.
- "title" : ce qui est écrit, recopié fidèlement dans la langue du calendrier, court (80 caractères au maximum). Ne le traduis pas.
- "incertain" : true si un mot ou un chiffre est difficile à lire. Ne devine pas : donne ta meilleure lecture et mets true.
Abréviations courantes : dev. = devoir ; ex. ou exo = exercices ; p. = page ; lect. = lecture ; ctrl ou contr. = contrôle ; éval. = évaluation ; dict. = dictée ; Fr = Français ; Sc ou Sci = Sciences ; Hist ou Géo = Histoire ; Ang = Anglais ; ÉPS, Arts, Musique, Éthique = Autre.
Réponds UNIQUEMENT avec ce JSON, sans aucun texte autour :
{"periode":{"jour":"lundi","jj":6,"mm":10,"aaaa":2026},"semaine":"courte description de la période lue, ou vide","items":[{"kind":"devoir","subject":"Maths","title":"Exercices page 42","jour":"mardi","jj":7,"mm":10,"aaaa":null,"due":"AAAA-MM-JJ","incertain":false}]}
Si tu ne vois aucun devoir ni examen, réponds {"items":[]}. Si la photo n'est pas un calendrier lisible, réponds {"erreur":"courte explication en ${LANG_ERR[L]}"}.`;
}
const KIND_EXAM = /exam|contr[oô]le|test|[ée]valuation|[ée]preuve|quiz/i;
const JOUR_NUM = { dimanche: 0, lundi: 1, mardi: 2, mercredi: 3, jeudi: 4, vendredi: 5, samedi: 6, sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
const JOUR_ABR = { dim: 0, lun: 1, mar: 2, mer: 3, jeu: 4, ven: 5, sam: 6, sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
function jourNum(x) {
  const k = str(x).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z]/g, "");
  if (k in JOUR_NUM) return JOUR_NUM[k];
  return k.length >= 3 && k.slice(0, 3) in JOUR_ABR ? JOUR_ABR[k.slice(0, 3)] : null;
}
const dowOf = (d) => new Date(d + "T00:00:00Z").getUTCDay();
const intOr = (x) => { const n = Number(x); return Number.isInteger(n) && n > 0 ? n : null; };
const pad2 = (n) => String(n).padStart(2, "0");
// Jour + mois (+ année si écrite) -> date. Sans année : celle qui rend la date la plus proche d'aujourd'hui.
function fromParts(jj, mm, aaaa, today) {
  if (!jj || !mm) return null;
  if (aaaa && aaaa >= 2000 && aaaa <= 2100) { const d = `${aaaa}-${pad2(mm)}-${pad2(jj)}`; return isoOk(d) ? d : null; }
  const y = Number(today.slice(0, 4));
  let best = null;
  for (const yy of [y - 1, y, y + 1]) {
    const d = `${yy}-${pad2(mm)}-${pad2(jj)}`;
    if (!isoOk(d)) continue;
    const gap = Math.abs(Date.parse(d + "T00:00:00Z") - Date.parse(today + "T00:00:00Z"));
    if (!best || gap < best.gap) best = { d, gap };
  }
  return best ? best.d : null;
}
// Les dates sont calculées ici, pas par l'IA : on lui demande seulement ce qui est écrit sur la photo.
function resolveDate(it, per, today) {
  const want = jourNum(it.jour);
  const jj = intOr(it.jj), mm = intOr(it.mm) || per.mm, aaaa = intOr(it.aaaa) || per.aaaa;
  const own = isoOk(str(it.due)) ? str(it.due) : null;
  let due = fromParts(jj, mm, aaaa, today);                                   // 1. jour et mois écrits
  if (!due && own && (want === null || dowOf(own) === want)) due = own;        // 2. date de l'IA, si elle correspond au jour écrit
  if (!due && want !== null && per.iso) {                                      // 3. seulement un jour de la semaine : on le cherche dans la semaine de départ
    for (let k = 0; k < 7; k++) { const d = shiftDay(per.iso, k); if (dowOf(d) === want) { due = d; break; } }
  }
  if (!due) due = own;                                                         // 4. dernier recours : la date de l'IA, à vérifier
  const conflict = own !== null && want !== null && dowOf(own) !== want;      // l'IA et le jour écrit se contredisent
  return { due, want, conflict };
}
function parseAgenda(text, today) {
  const raw = JSON.parse(text.replace(/```json|```/g, "").trim());
  if (raw.erreur) return { erreur: str(raw.erreur) };
  const p = raw.periode || {};
  const per = { mm: intOr(p.mm), aaaa: intOr(p.aaaa) };
  per.iso = fromParts(intOr(p.jj), per.mm, per.aaaa, today);
  const lo = shiftDay(today, -60), hi = shiftDay(today, 400), items = [], seen = new Set();
  for (const x of Array.isArray(raw.items) ? raw.items : []) {
    if (!x || !str(x.title).trim()) continue;
    const kind = KIND_EXAM.test(str(x.kind)) ? "examen" : "devoir";
    const title = str(x.title).replace(/\s+/g, " ").trim().slice(0, 80);
    const { due, want, conflict } = resolveDate(x, per, today);
    const mismatch = due !== null && want !== null && dowOf(due) !== want;       // le jour écrit ne correspond pas à la date trouvée
    const incertain = Boolean(x.incertain) || due === null || mismatch || conflict || due < lo || due > hi;
    const key = [kind, title.toLowerCase(), due].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ kind, subject: SUBJECTS[str(x.subject).trim()] || "Autre", title, due, incertain, js: want });
    if (items.length >= 60) break;
  }
  return { semaine: str(raw.semaine).slice(0, 80), items };
}

// Vérifications communes : clé d'IA, connexion, limite par heure, image valide
async function guard(req, res) {
  if (!KEY && !CLAUDE_KEY) { res.status(500).json({ erreur: "Aucune clé d'IA n'est configurée sur le serveur." }); return null; }
  const body = req.body || {};
  const lg = LANG_NAME[body.lang] ? body.lang : "fr";
  let who = req.ip;
  if (needLogin) {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || "");
    const id = m ? await whoIs(m[1]).catch(() => null) : null;
    if (!id) { res.status(401).json({ erreur: MSG.login[lg] }); return null; }
    who = "u:" + id;
  }
  const wait = limited(who);
  if (wait) { res.status(429).json({ erreur: MSG.limit[lg](MAX_PER_HOUR, wait) }); return null; }
  const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(body.image || "");
  if (!m) { res.status(400).json({ erreur: MSG.image[lg] }); return null; }
  return { lg, m, mode: body.mode === "kids" ? "kids" : "studia", body };
}

// Ordre d'essai : Gemini, Gemini (modèle de secours), puis Claude
async function runAI(m, promptText, parse, temp, opt = {}) {
  const t0 = Date.now(), steps = [];
  if (KEY) {
    if (opt.model && opt.model !== MODEL) steps.push([opt.model, (ms) => callGemini(opt.model, 2, m, promptText, temp, opt.cfg, ms)]);
    steps.push([MODEL, (ms) => callGemini(MODEL, 2, m, promptText, temp, opt.cfg, ms)]);
    if (FALLBACK && FALLBACK !== MODEL) steps.push([FALLBACK, (ms) => callGemini(FALLBACK, 2, m, promptText, temp, opt.cfg, ms)]);
  }
  if (CLAUDE_KEY) steps.push([CLAUDE_MODEL, (ms) => callClaude(2, m, promptText, opt.maxTokens, ms)]);
  let busy = false;
  for (const [name, run] of steps) {
    const left = AI_BUDGET - (Date.now() - t0);                // on répond toujours avant que Render coupe la connexion (~100 s)
    if (left < Math.min(8000, AI_BUDGET / 3)) { busy = true; console.error("Délai total atteint avant", name); break; }
    try {
      const r = await run(Math.min(GEMINI_TIMEOUT, left));
      if (!r.ok) { if ([429, 503, 504, 529].includes(r.status)) busy = true; continue; }
      const out = parse(r.text);
      console.log("IA :", name, `(${Math.round((Date.now() - t0) / 1000)} s)`);
      return { ok: true, out };
    } catch (e) {
      console.error("Réponse inutilisable de", name, e.message);
    }
  }
  return { ok: false, busy };
}

app.post("/api/agenda", async (req, res) => {
  const g = await guard(req, res); if (!g) return;
  const t0 = String((g.body || {}).today || "");
  const today = isoOk(t0) && Math.abs(Date.parse(t0 + "T12:00:00Z") - Date.now()) < 3 * 864e5 ? t0 : new Date().toISOString().slice(0, 10);
  const r = await runAI(g.m, agendaPrompt(g.lg, today), (text) => parseAgenda(text, today), 0.2, { model: AGENDA_MODEL, cfg: { mediaResolution: "MEDIA_RESOLUTION_HIGH" } });
  if (r.ok) return r.out.erreur ? res.status(422).json({ erreur: r.out.erreur }) : res.json(r.out);
  res.status(r.busy ? 503 : 502).json({ erreur: r.busy ? MSG.busy[g.lg] : MSG.unreadableCal[g.lg] });
});

app.post("/api/analyze", async (req, res) => {
  const g = await guard(req, res); if (!g) return;
  const n = [5, 10, 15].includes(Number(g.body.n)) ? Number(g.body.n) : 10; // 10 par défaut
  const r = await runAI(g.m, prompt(g.mode, g.lg, n), (text) => parseLesson(text, n), 0.4, { maxTokens: 3000 + (n - 5) * 300 });
  if (r.ok) return r.out.erreur ? res.status(422).json({ erreur: r.out.erreur }) : res.json(r.out);
  res.status(r.busy ? 503 : 502).json({ erreur: r.busy ? MSG.busy[g.lg] : MSG.unreadable[g.lg] });
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
  const id = await parentId(req); if (!id) return noLogin(res);
  if (!tgEnabled) { // on dit seulement QUELS réglages manquent sur Render, jamais leurs valeurs
    const missing = [["TELEGRAM_BOT_TOKEN", TG_TOKEN], ["SUPABASE_URL", SB_URL], ["SUPABASE_SERVICE_KEY", SB_SERVICE]].filter(([, v]) => !v).map(([k]) => k);
    return res.json({ enabled: false, missing });
  }
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

// Données d'un compte (profils de la version choisie + devoirs/examens non faits)
async function loadAlertData(pid, appName) {
  const base = `profiles?select=id,name,av&parent_id=eq.${pid}`;
  const [profiles, tasks] = await Promise.all([
    sbRest(`${base}&app=eq.${appName}`).catch(() => sbRest(base)),
    sbRest(`tasks?select=id,profile_id,kind,title,subject,due&parent_id=eq.${pid}&done_at=is.null`),
  ]);
  return { pid, kids: new Map((profiles || []).map((p) => [p.id, p])), tasks: tasks || [] };
}
// Les règles : devoir en retard (au 1er puis au 3e jour) ; examen à 7, 3, 1 jour(s) et le jour même. Chaque rappel n'est envoyé qu'une fois.
function gatherAlerts(data, sentIn, today) {
  const sent = sentIn || {}, marks = {}, late = [], exams = [];
  for (const x of data.tasks) {
    const kid = data.kids.get(x.profile_id); if (!kid) continue;
    const n = dayNum(x.due) - dayNum(today);
    if (x.kind === "devoir" && n < 0) {
      const lt = -n, k1 = `late:${x.id}:1`, k3 = `late:${x.id}:3`;
      const fire = lt >= 3 && !sent[k3] ? [k1, k3] : lt >= 1 && !sent[k1] && lt < 3 ? [k1] : null;
      if (!fire) continue;
      fire.forEach((k) => { marks[k] = today; });
      late.push({ kid, x, late: lt });
    } else if (x.kind === "examen" && n >= 0) {
      const bands = [0, 1, 3, 7], T = bands.find((b) => b >= n);
      if (T === undefined || sent[`exam:${x.id}:${T}`]) continue;
      bands.filter((b) => b >= T).forEach((b) => { marks[`exam:${x.id}:${b}`] = today; });
      exams.push({ kid, x, n });
    }
  }
  return { late, exams, marks };
}

async function buildAlerts(link, today) {
  const pid = link.parent_id, data = await loadAlertData(pid, "kids"), sent = { ...(link.sent || {}) };
  const { late, exams, marks } = gatherAlerts(data, sent, today);
  const kids = data.kids, lines = new Map(); // enfant -> lignes du message
  for (const { kid, x, late: lt } of late) {
    lines.set(kid.id, [...(lines.get(kid.id) || []), `⚠️ Devoir en retard : <b>${eh(x.title)}</b> (${eh(x.subject)}) — en retard de ${lt} jour${lt > 1 ? "s" : ""}`]);
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
  const lateTxt = blocks.some((b) => b.includes("Devoir en retard"));
  const text = `🔔 <b>Studia Kids</b>\n\n${blocks.join("\n\n")}${lateTxt ? "\n\n<i>« En retard » veut dire que le devoir n'est pas marqué comme fait dans Studia.</i>" : ""}${PUBLIC_URL ? `\n${PUBLIC_URL}` : ""}`;
  return { text, marks, sent };
}

// ---------- Notifications sur le téléphone (Web Push, gratuit) ----------
// Réglages sur Render : VAPID_PUBLIC_KEY et VAPID_PRIVATE_KEY (générées par /api/push/keys), SUPABASE_SERVICE_KEY, CRON_SECRET.
let webpush = null;
try { webpush = require("web-push"); } catch (e) { console.warn("Module web-push absent : notifications du téléphone désactivées."); }
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || "", VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || "";
const pushEnabled = Boolean(webpush && VAPID_PUBLIC && VAPID_PRIVATE && SB_URL && SB_SERVICE);
if (webpush && VAPID_PUBLIC && VAPID_PRIVATE) {
  try { webpush.setVapidDetails(process.env.VAPID_SUBJECT || PUBLIC_URL || "https://studia-nouveau.onrender.com", VAPID_PUBLIC, VAPID_PRIVATE); }
  catch (e) { console.error("Clés VAPID invalides :", e.message); }
}
// On n'accepte que les adresses des vrais services de notification (Google, Apple, Mozilla, Microsoft)
const PUSH_HOSTS = /^https:\/\/([a-z0-9-]+\.)*(googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)(:\d+)?\//i;
const SUBJ_EN = { Maths: "Maths", "Français": "French", Sciences: "Science", Histoire: "History", Anglais: "English", Autre: "Other" };
const enIn = (n) => (n === 0 ? "today" : n === 1 ? "tomorrow" : `in ${n} days`);
function pushMessage(g, lang, appName) {
  const en = lang === "en", per = new Map();
  const get = (kid) => { if (!per.has(kid.id)) per.set(kid.id, { kid, late: [], exams: [] }); return per.get(kid.id); };
  g.late.forEach((a) => get(a.kid).late.push(a));
  g.exams.forEach((a) => get(a.kid).exams.push(a));
  if (!per.size) return null;
  const parts = [];
  for (const { kid, late, exams } of per.values()) {
    const bits = [];
    if (late.length === 1) { const { x } = late[0]; bits.push(en ? `Late homework: ${x.title} (${SUBJ_EN[x.subject] || x.subject})` : `Devoir en retard : ${x.title} (${x.subject})`); }
    else if (late.length > 1) bits.push(en ? `${late.length} late homework` : `${late.length} devoirs en retard`);
    exams.sort((a, b) => a.n - b.n);
    for (const { x, n } of exams.slice(0, 2)) bits.push(en ? `${SUBJ_EN[x.subject] || x.subject} exam ${enIn(n)}` : `Examen de ${x.subject} ${frIn(n)}`);
    if (exams.length > 2) bits.push(en ? `+${exams.length - 2} more exams` : `+${exams.length - 2} autres examens`);
    parts.push(appName === "kids" ? `${kid.name} : ${bits.join(" · ")}` : bits.join(" · "));
  }
  const body = parts.join("\n");
  return body.length > 220 ? body.slice(0, 217) + "…" : body;
}
const pushPayload = (sub, body) => ({ t: sub.app === "studia" ? "Studia" : "Studia Kids", b: body, u: `/${sub.app === "studia" ? "studia" : "kids"}/app?open=agenda`, i: sub.app === "studia" ? "/studia-icon-192.png" : "/icon-192.png", g: "studia-alertes", l: sub.lang === "en" ? "en" : "fr" });
const sendPush = (sub, payload) => webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(payload), { TTL: 12 * 3600, urgency: "normal" });
const goneErr = (e) => Boolean(e && (e.statusCode === 404 || e.statusCode === 410));
const noPush = (res) => res.status(503).json({ erreur: "Les notifications du téléphone ne sont pas activées sur le serveur." });

async function runPush(dry, today) {
  const out = { subs: 0, messages: 0, removed: 0, details: [] };
  if (!pushEnabled) return out;
  const subs = (await sbRest("push_subs?select=id,parent_id,endpoint,p256dh,auth,app,lang,sent")) || [], cache = new Map();
  for (const sub of subs) {
    out.subs++;
    try {
      const key = `${sub.parent_id}:${sub.app}`;
      if (!cache.has(key)) cache.set(key, await loadAlertData(sub.parent_id, sub.app));
      const g = gatherAlerts(cache.get(key), sub.sent, today), body = pushMessage(g, sub.lang, sub.app);
      if (!body) continue;
      const payload = pushPayload(sub, body);
      if (dry) { out.messages++; out.details.push({ sub: String(sub.id).slice(0, 8), app: sub.app, title: payload.t, body }); continue; }
      try { await sendPush(sub, payload); }
      catch (e) {
        if (goneErr(e)) { await sbRest(`push_subs?id=eq.${sub.id}`, { method: "DELETE", prefer: "return=minimal" }); out.removed++; continue; }
        throw e;
      }
      const keep = Date.now() - 90 * 864e5, old = Object.fromEntries(Object.entries(sub.sent || {}).filter(([, d]) => Date.parse(d) > keep));
      await sbRest(`push_subs?id=eq.${sub.id}`, { method: "PATCH", prefer: "return=minimal", body: { sent: { ...old, ...g.marks }, last_ok: new Date().toISOString() } });
      out.messages++;
    } catch (e) { console.error("Notification pour un appareil :", e.message); }
  }
  return out;
}

app.get("/api/push/config", (req, res) => res.json({ enabled: pushEnabled, publicKey: pushEnabled ? VAPID_PUBLIC : "" }));

app.post("/api/push/status", async (req, res) => {
  const id = await parentId(req); if (!id) return noLogin(res);
  if (!pushEnabled) { // on dit seulement QUELS réglages manquent, jamais leurs valeurs
    const missing = [["web-push (package.json)", webpush], ["VAPID_PUBLIC_KEY", VAPID_PUBLIC], ["VAPID_PRIVATE_KEY", VAPID_PRIVATE], ["SUPABASE_URL", SB_URL], ["SUPABASE_SERVICE_KEY", SB_SERVICE]].filter(([, v]) => !v).map(([k]) => k);
    return res.json({ enabled: false, missing });
  }
  try {
    const ep = String((req.body || {}).endpoint || ""), rows = (await sbRest(`push_subs?select=endpoint&parent_id=eq.${id}`)) || [];
    res.json({ enabled: true, subscribed: Boolean(ep) && rows.some((r) => r.endpoint === ep), count: rows.length, cron: Boolean(CRON_SECRET) });
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ enabled: true, erreur: "Impossible de lire l'état des notifications. Le SQL des notifications est-il lancé dans Supabase ?" });
  }
});

app.post("/api/push/subscribe", async (req, res) => {
  if (!pushEnabled) return noPush(res);
  const id = await parentId(req); if (!id) return noLogin(res);
  if (!rateOk("psub:" + id, 20, 3600000)) return res.status(429).json({ erreur: "Trop d'essais. Réessaie dans un moment." });
  const b = req.body || {}, s = b.subscription || {}, k = s.keys || {};
  const ep = String(s.endpoint || ""), p256 = String(k.p256dh || ""), au = String(k.auth || "");
  if (ep.length > 1000 || !PUSH_HOSTS.test(ep) || !/^[\w-]{20,200}$/.test(p256) || !/^[\w-]{10,60}$/.test(au)) return res.status(400).json({ erreur: "Abonnement invalide." });
  try {
    await sbRest("push_subs?on_conflict=endpoint", { method: "POST", prefer: "resolution=merge-duplicates,return=minimal", body: { parent_id: id, endpoint: ep, p256dh: p256, auth: au, app: b.app === "studia" ? "studia" : "kids", lang: b.lang === "en" ? "en" : "fr" } });
    const rows = (await sbRest(`push_subs?select=id&parent_id=eq.${id}&order=created_at.desc`)) || []; // au plus 10 appareils par compte
    for (const r of rows.slice(10)) await sbRest(`push_subs?id=eq.${r.id}`, { method: "DELETE", prefer: "return=minimal" });
    res.json({ ok: true });
  } catch (e) {
    console.error(e.message);
    res.status(502).json({ erreur: "Impossible d'enregistrer cet appareil. Le SQL des notifications est-il lancé dans Supabase ?" });
  }
});

app.post("/api/push/unsubscribe", async (req, res) => {
  if (!pushEnabled) return noPush(res);
  const id = await parentId(req); if (!id) return noLogin(res);
  try {
    await sbRest(`push_subs?parent_id=eq.${id}&endpoint=eq.${encodeURIComponent(String((req.body || {}).endpoint || ""))}`, { method: "DELETE", prefer: "return=minimal" });
    res.json({ ok: true });
  } catch (e) { console.error(e.message); res.status(500).json({ erreur: "Impossible de désactiver les notifications." }); }
});

app.post("/api/push/test", async (req, res) => {
  if (!pushEnabled) return noPush(res);
  const id = await parentId(req); if (!id) return noLogin(res);
  if (!rateOk("ptest:" + id, 10, 3600000)) return res.status(429).json({ erreur: "Trop d'essais. Réessaie dans un moment." });
  try {
    const rows = await sbRest(`push_subs?select=id,endpoint,p256dh,auth,app,lang&parent_id=eq.${id}&endpoint=eq.${encodeURIComponent(String((req.body || {}).endpoint || ""))}`), sub = rows && rows[0];
    if (!sub) return res.status(409).json({ erreur: "Cet appareil n'est pas encore abonné." });
    const en = sub.lang === "en";
    try { await sendPush(sub, pushPayload(sub, en ? "🔔 Notifications are on. You'll get a reminder when homework is late or an exam is coming up." : "🔔 Les notifications fonctionnent. Tu recevras un rappel quand un devoir est en retard ou qu'un examen approche.")); }
    catch (e) {
      if (goneErr(e)) { await sbRest(`push_subs?id=eq.${sub.id}`, { method: "DELETE", prefer: "return=minimal" }); return res.status(410).json({ erreur: "Cet appareil n'est plus abonné. Réactive les notifications." }); }
      throw e;
    }
    res.json({ ok: true });
  } catch (e) {
    console.error(e.message);
    res.status(502).json({ erreur: "Le service de notification n'a pas livré le message. Désactive puis réactive les notifications." });
  }
});

// Génère les deux clés à copier dans Render (une seule fois). Réservé à la personne qui connaît CRON_SECRET.
app.get("/api/push/keys", (req, res) => {
  const q = new URL(req.url, "http://x").searchParams, a = Buffer.from(String(q.get("key") || "")), b = Buffer.from(CRON_SECRET);
  if (!CRON_SECRET || a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(403).json({ erreur: "Clé invalide." });
  if (VAPID_PUBLIC || VAPID_PRIVATE) return res.status(409).json({ erreur: "Les clés des notifications existent déjà sur ce serveur." });
  const jwk = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ format: "jwk" });
  res.set("Cache-Control", "no-store").json({ VAPID_PUBLIC_KEY: Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]).toString("base64url"), VAPID_PRIVATE_KEY: jwk.d });
});

async function runAlerts(dry) {
  const today = ymdInTz(), out = { today, parents: 0, messages: 0, details: [] };
  const links = tgEnabled ? (await sbRest("tg_links?select=parent_id,chat_id,sent&chat_id=not.is.null")) || [] : [];
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
  out.push = await runPush(dry, today).catch((e) => { console.error("Notifications :", e.message); return { subs: 0, messages: 0, removed: 0, details: [], erreur: true }; });
  return out;
}

app.get("/api/cron/alerts", async (req, res) => {
  if ((!tgEnabled && !pushEnabled) || !CRON_SECRET) return res.status(503).json({ erreur: "Alertes non configurées sur le serveur." });
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
