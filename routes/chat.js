import express from "express";

const router = express.Router();

/**
 * POST /api/chat
 * Body: { message: string }
 * Returns: { reply: string }
 */
router.post("/chat", async (req, res) => {
  try {
    const message = (req.body?.message || "").toString().trim();
    if (!message) return res.status(400).json({ error: "message is required" });

    // ✅ Marom rules: no medical claims, no campaign/internal info
    const systemPrompt = `
You are MAROM’s website assistant.
You help visitors with hair/scalp questions and how to use MAROM products.
Be warm, simple, and practical.
Do NOT mention campaigns, internal dashboard data, ads, or backend details.
Do NOT give medical diagnosis. No “treat/cure/prevent”.
If someone asks medical questions, suggest consulting a professional.
Keep answers short and helpful.
`.trim();

    // IMPORTANT:
    // Replace the AI call below with YOUR existing AI helper.
    // For now, this is a placeholder response so the route works immediately.
    // ----
    // Example: const reply = await askAI({ systemPrompt, message });
    const reply = `Thanks — I can help. Tell me: is your hair loss more like shedding (more hair in shower/brush) or breakage (short snapped hairs)?`;

    return res.json({ reply });
  } catch (err) {
    console.error("CHAT ERROR:", err);
    return res.status(500).json({ error: "chat_failed" });
  }
});

/**
 * GET /api/chat/test
 */
router.get("/chat/test", (req, res) => {
  res.json({ ok: true, route: "/api/chat" });
});

export default router;
