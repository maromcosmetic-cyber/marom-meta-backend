import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import cors from "cors";
dotenv.config();

const app = express();
app.use(express.json());

// Allow only your website to call the API
const origins = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => (!origin || origins.includes(origin)) ? cb(null, true) : cb(new Error("Not allowed by CORS"))
}));

const TOKEN = process.env.META_TOKEN;         // keep secret (never in frontend)
const GRAPH = "https://graph.facebook.com/v24.0";

// Helper
const fb = async (path, method="GET", paramsOrBody={}) => {
  const cfg = { url: `${GRAPH}${path}`, method, headers: { Authorization: `Bearer ${TOKEN}` } };
  if (method === "GET") cfg.params = paramsOrBody; else cfg.data = paramsOrBody;
  const { data } = await axios(cfg); return data;
};

// Health
app.get("/health", (_,res) => res.json({ ok: true }));

// 1) List ad accounts
app.get("/api/adaccounts", async (_,res) => {
  try { res.json(await fb(`/me/adaccounts`, "GET", { fields: "id,account_id,name,currency" })); }
  catch(e){ res.status(500).json(e.response?.data || { error:String(e) }); }
});

// 2) Insights (last 7d)
app.get("/api/adaccounts/:actId/insights", async (req,res) => {
  try { res.json(await fb(`/${req.params.actId}/insights`, "GET", { date_preset:"last_7d", fields:"spend,impressions,clicks,ctr,cpc,cpm" })); }
  catch(e){ res.status(500).json(e.response?.data || { error:String(e) }); }
});

// --- Diagnostic routes ---
app.get("/diag/permissions", async (_req, res) => {
  try {
    const j = await fb(`/me/permissions`, "GET");
    res.json(j);
  } catch (e) {
    res.status(500).json(e.response?.data || { error: String(e) });
  }
});

app.get("/diag/whoami", async (_req, res) => {
  try {
    const j = await fb(`/me`, "GET", { fields: "id,name,adaccounts.limit(5){id,name}" });
    res.json(j);
  } catch (e) {
    res.status(500).json(e.response?.data || { error: String(e) });
  }
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Backend on http://localhost:${PORT}`));
// --- AI endpoints for the dashboard ---
import OpenAI from "openai";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Generate audience suggestions
app.post("/api/ai/audience", async (req, res) => {
  try {
    const { product } = req.body;
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are Marom’s Facebook Ads strategist." },
        { role: "user", content: `Suggest 3 ideal Facebook target audiences for ${product}. Include age, gender, interests, and reason why they fit.` },
      ],
    });
    res.json({ suggestions: completion.choices[0].message.content });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Generate ad copy / creatives
app.post("/api/ai/creatives", async (req, res) => {
  try {
    const { product, tone } = req.body;
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a creative copywriter for Marom natural cosmetics." },
        { role: "user", content: `Write 3 short Facebook ad texts in ${tone || "English"} for ${product}. Make them natural, emotional, and add a call-to-action.` },
      ],
    });
    res.json({ copy: completion.choices[0].message.content });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Campaign improvement suggestions
app.get("/api/ai/recommendations", async (req, res) => {
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a Facebook Ads performance expert for Marom." },
        { role: "user", content: "Suggest 3 actions to improve campaign performance for natural cosmetics (based on spend, CTR, CPM)." },
      ],
    });
    res.json({ recommendations: completion.choices[0].message.content });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mock actions
app.post("/api/ai/recommendations/:type/apply", (req, res) => {
  res.json({ ok: true, message: `Applied recommendation: ${req.params.type}` });
});
app.post("/api/ai/recommendations/:type/dismiss", (req, res) => {
  res.json({ ok: true, message: `Dismissed recommendation: ${req.params.type}` });
});
