const express = require("express");
const path = require("path");

const app = express();
app.set("trust proxy", 1); // derrière Render, pour lire la vraie adresse IP
const KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const GEMINI_BASE = process.env.GEMINI_BASE || "https://generativelanguage.googleapis.com";
const MAX_PER_HOUR = 20;

app.use(express.json({ limit: "12mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Réglages publics pour les comptes parents (la clé anon est faite pour être publique)
app.get("/api/config", (req, res) =>
  res.json({ url: process.env.SUPABASE_URL || "", key: process.env.SUPABASE_ANON_KEY || "" })
);

// Connexion obligatoire : on demande à Supabase si le jeton est valide
const SB_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SB_KEY = process.env.SUPABASE_ANON_KEY || "";
const needLogin = Boolean(SB_URL && SB_KEY);
const tokens = new Map(); // jeton -> { id, exp } (mémoire de 60 s pour éviter trop d'appels)

async function whoIs(token) {
  const c = tokens.get(token);
  if (c && c.exp > Date.now()) return c.id;
  const r = await fetch(`${SB_URL}/auth/v1/user`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const u = await r.json();
  if (!u || !u.id) return null;
  tokens.set(token, { id: u.id, exp: Date.now() + 60000 });
  if (tokens.size > 500) for (const [k, v] of tokens) if (v.exp < Date.now()) tokens.delete(k);
  return u.id;
}

// Limite simple : 20 analyses par heure et par parent (ou par adresse IP sans compte)
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

// Réessaie jusqu'à 3 fois si Gemini est surchargé (503) ou limité (429)
async function withRetry(call) {
  let r;
  for (let i = 0; i < 3; i++) {
    r = await call();
    if (r.status !== 503 && r.status !== 429 && r.status !== 500) return r;
    await new Promise((ok) => setTimeout(ok, 2000 * (i + 1)));
  }
  return r;
}

function prompt(mode) {
  const kids = mode === "kids";
  return `Tu es Studia, un assistant de révision pour élèves. Analyse la photo d'une leçon (cahier ou manuel).
Public : ${kids ? "enfant de 6 à 11 ans. Phrases très courtes, mots simples, ton très encourageant." : "adolescent de 12 à 17 ans. Ton direct et clair."}
Écris en français. Base-toi uniquement sur ce qui est visible sur la photo. Si la photo est illisible, mets "erreur" avec une courte explication.
Réponds UNIQUEMENT avec ce JSON :
{"matiere":"Maths|Français|Sciences|Histoire|Anglais|Autre","titre":"titre court de la leçon","resume":"résumé en 3 à 5 phrases","fiches":[{"q":"question ou mot clé","r":"réponse courte"}],"quiz":[{"q":"question","choix":["a","b","c"],"bonne":0,"explication":"une phrase"}]}
Donne 4 à 6 fiches et exactement 5 questions de quiz. "bonne" est l'index (0, 1 ou 2) de la bonne réponse.`;
}

app.post("/api/analyze", async (req, res) => {
  if (!KEY) return res.status(500).json({ erreur: "Clé Gemini manquante sur le serveur." });
  let who = req.ip;
  if (needLogin) {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || "");
    const id = m ? await whoIs(m[1]).catch(() => null) : null;
    if (!id) return res.status(401).json({ erreur: "Connecte-toi avec ton compte parent pour utiliser Studia." });
    who = "u:" + id;
  }
  const wait = limited(who);
  if (wait) {
    return res.status(429).json({
      erreur: `Tu as atteint la limite de ${MAX_PER_HOUR} analyses par heure. Réessaie dans environ ${wait} minute${wait > 1 ? "s" : ""}.`,
    });
  }

  const { image, mode } = req.body || {};
  const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(image || "");
  if (!m) return res.status(400).json({ erreur: "Image invalide. Utilise une photo JPG, PNG ou WebP." });

  try {
    const r = await withRetry(() => fetch(`${GEMINI_BASE}/v1beta/models/${MODEL}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": KEY },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt(mode) }, { inline_data: { mime_type: m[1], data: m[2] } }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.4 },
      }),
    }));
    if (!r.ok) {
      console.error("Gemini", r.status, (await r.text()).slice(0, 300));
      if (r.status === 429 || r.status === 503) {
        return res.status(503).json({ erreur: "L'IA est très sollicitée en ce moment. Réessaie dans une minute ou deux." });
      }
      return res.status(502).json({ erreur: "L'IA ne répond pas pour le moment. Réessaie." });
    }
    const data = await r.json();
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
    const out = JSON.parse(text.replace(/```json|```/g, "").trim());
    if (out.erreur) return res.status(422).json({ erreur: String(out.erreur) });
    if (!Array.isArray(out.quiz) || !Array.isArray(out.fiches)) throw new Error("format");
    res.json(out);
  } catch (e) {
    console.error(e);
    res.status(500).json({ erreur: "Je n'ai pas réussi à lire cette leçon. Essaie avec une photo plus nette." });
  }
});

app.listen(process.env.PORT || 3000, () => console.log("Studia prêt"));
