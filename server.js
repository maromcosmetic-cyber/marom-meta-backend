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
app.get("/diag/openai", (req, res) => {
  res.json({
    ok: !!process.env.OPENAI_API_KEY,
    keyLength: process.env.OPENAI_API_KEY?.length
  });
});
