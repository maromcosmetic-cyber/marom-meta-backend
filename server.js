import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";
dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Memory storage paths
const MEMORY_DIR = path.join(__dirname, "memory");
const COMPANY_FILE = path.join(MEMORY_DIR, "company.json");
const CONVERSATIONS_FILE = path.join(MEMORY_DIR, "conversations.json");

// Ensure memory directory exists
if (!fs.existsSync(MEMORY_DIR)) {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
}

// Load company context
function loadCompanyContext() {
  try {
    if (fs.existsSync(COMPANY_FILE)) {
      return JSON.parse(fs.readFileSync(COMPANY_FILE, "utf8"));
    }
  } catch (err) {
    console.error("Error loading company context:", err);
  }
  return {
    name: "MAROM",
    industry: "Natural Hair Care & Cosmetics",
    products: [],
    targetAudience: "",
    brandValues: "",
    campaignGoals: "",
    pastCampaigns: [],
    preferences: {},
    notes: ""
  };
}

// Save company context
function saveCompanyContext(context) {
  try {
    fs.writeFileSync(COMPANY_FILE, JSON.stringify(context, null, 2), "utf8");
    return true;
  } catch (err) {
    console.error("Error saving company context:", err);
    return false;
  }
}

// Load conversation history
function loadConversations() {
  try {
    if (fs.existsSync(CONVERSATIONS_FILE)) {
      return JSON.parse(fs.readFileSync(CONVERSATIONS_FILE, "utf8"));
    }
  } catch (err) {
    console.error("Error loading conversations:", err);
  }
  return [];
}

// Save conversation history
function saveConversation(userMessage, aiResponse) {
  try {
    const conversations = loadConversations();
    conversations.push({
      timestamp: new Date().toISOString(),
      user: userMessage,
      assistant: aiResponse
    });
    // Keep last 100 conversations
    const recent = conversations.slice(-100);
    fs.writeFileSync(CONVERSATIONS_FILE, JSON.stringify(recent, null, 2), "utf8");
    return true;
  } catch (err) {
    console.error("Error saving conversation:", err);
    return false;
  }
}

// Build system prompt with company context
function buildSystemPrompt(companyContext) {
  let prompt = `You are an AI assistant helping with ${companyContext.name}'s Facebook and Instagram ad campaigns through the MAROM Ads Copilot dashboard. `;
  
  if (companyContext.industry) {
    prompt += `The company operates in the ${companyContext.industry} industry. `;
  }
  
  if (companyContext.products && companyContext.products.length > 0) {
    prompt += `Their main products/services include: ${companyContext.products.join(", ")}. `;
  }
  
  if (companyContext.targetAudience) {
    prompt += `Their target audience: ${companyContext.targetAudience}. `;
  }
  
  if (companyContext.brandValues) {
    prompt += `Brand values: ${companyContext.brandValues}. `;
  }
  
  if (companyContext.campaignGoals) {
    prompt += `Campaign goals: ${companyContext.campaignGoals}. `;
  }
  
  if (companyContext.notes) {
    prompt += `Additional context: ${companyContext.notes}. `;
  }
  
  prompt += `\n\nIMPORTANT CONTEXT:\n`;
  prompt += `- You are helping users navigate the MAROM Ads Copilot dashboard, NOT Facebook/Instagram directly.\n`;
  prompt += `- When users ask about "company profile" or "company settings", they mean the Company Profile tab in this dashboard where they can save company information for AI personalization.\n`;
  prompt += `- You can help with: campaign creation, audience targeting, creative generation, performance monitoring, and optimization recommendations.\n`;
  prompt += `- All features are accessed through the dashboard interface, not by logging into Facebook/Instagram directly.\n`;
  prompt += `- Use this information to provide personalized recommendations. Be helpful, concise, and professional. Remember past conversations and preferences to provide better suggestions over time.`;
  
  return prompt;
}

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

// WhatsApp webhook verification
app.get("/webhook/whatsapp", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  
  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log("WhatsApp webhook verified");
    res.status(200).send(challenge);
  } else {
    console.log("WhatsApp webhook verification failed");
    res.status(403).send("Forbidden");
  }
});

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
// Company context endpoints
app.get("/api/company/context", (req, res) => {
  try {
    const context = loadCompanyContext();
    res.json(context);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/company/context", (req, res) => {
  try {
    const currentContext = loadCompanyContext();
    const updatedContext = { ...currentContext, ...req.body, updatedAt: new Date().toISOString() };
    saveCompanyContext(updatedContext);
    res.json({ success: true, context: updatedContext });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Generate audience suggestions
app.post("/api/ai/audience", async (req, res) => {
  try {
    const { description } = req.body;
    const companyContext = loadCompanyContext();
    const systemPrompt = buildSystemPrompt(companyContext);
    
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt + " You are a Facebook Ads audience strategist. Provide detailed audience suggestions with demographics, interests, behaviors, estimated reach, and best use cases. Format as JSON with suggestions array." },
        { role: "user", content: `Based on this description: "${description}", suggest 3 ideal Facebook target audiences. Format as JSON array with title, demographics, interests, behaviors, reach, and bestFor fields.` },
      ],
      response_format: { type: "json_object" }
    });
    
    const response = JSON.parse(completion.choices[0].message.content);
    
    // Ensure suggestions is always an array
    let suggestions = [];
    if (response.suggestions && Array.isArray(response.suggestions)) {
      suggestions = response.suggestions;
    } else if (Array.isArray(response)) {
      suggestions = response;
    } else if (response.suggestions && typeof response.suggestions === 'string') {
      // If it's a string, try to parse it or create a single suggestion
      try {
        const parsed = JSON.parse(response.suggestions);
        suggestions = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        suggestions = [{ title: "Suggested Audience", demographics: response.suggestions }];
      }
    } else {
      // Fallback: create a single suggestion from the response
      suggestions = [response];
    }
    
    res.json({ suggestions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Generate ad copy / creatives
app.post("/api/ai/creatives", async (req, res) => {
  try {
    const { productDescription, language } = req.body;
    const companyContext = loadCompanyContext();
    const systemPrompt = buildSystemPrompt(companyContext);
    
    const langInstruction = language === "th" ? "Thai" : language === "en" ? "English" : "both Thai and English";
    
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt + " You are a creative copywriter. Generate multiple ad copy variants with headlines and primary text. Format as JSON with variants array, each containing name, th (headline/text), and en (headline/text) fields." },
        { role: "user", content: `Create 3 Facebook ad copy variants in ${langInstruction} for: "${productDescription}". Make them natural, emotional, and include call-to-actions. Format as JSON.` },
      ],
      response_format: { type: "json_object" }
    });
    
    const response = JSON.parse(completion.choices[0].message.content);
    
    // Ensure variants is always an array
    let variants = [];
    if (response.variants && Array.isArray(response.variants)) {
      variants = response.variants;
    } else if (Array.isArray(response)) {
      variants = response;
    } else if (response.variants && typeof response.variants === 'string') {
      // If it's a string, try to parse it or create a single variant
      try {
        const parsed = JSON.parse(response.variants);
        variants = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        variants = [{ name: "Ad Variant", text: response.variants }];
      }
    } else {
      // Fallback: create a single variant from the response
      variants = [response];
    }
    
    res.json({ variants });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Campaign improvement suggestions
app.get("/api/ai/recommendations", async (req, res) => {
  try {
    const companyContext = loadCompanyContext();
    const conversations = loadConversations();
    
    // Try to fetch actual campaigns from Facebook API
    let hasCampaigns = false;
    let campaignData = null;
    
    try {
      // Check if we can access ad accounts (indicates campaigns might exist)
      const accountsResponse = await fb(`/me/adaccounts`, "GET", { 
        fields: "id,account_id,name",
        limit: 1 
      });
      
      if (accountsResponse.data && accountsResponse.data.length > 0) {
        const account = accountsResponse.data[0];
        // Try to get campaigns for this account
        try {
          const campaignsResponse = await fb(`/${account.id}/campaigns`, "GET", {
            fields: "id,name,status",
            limit: 1
          });
          if (campaignsResponse.data && campaignsResponse.data.length > 0) {
            hasCampaigns = true;
            campaignData = {
              accountName: account.name,
              campaignCount: campaignsResponse.data.length
            };
          }
        } catch (e) {
          // No campaigns or can't access
          hasCampaigns = false;
        }
      }
    } catch (e) {
      // Can't access Facebook API or no accounts
      hasCampaigns = false;
    }
    
    const systemPrompt = buildSystemPrompt(companyContext);
    
    // Include recent conversation insights
    let conversationContext = "";
    if (conversations.length > 0) {
      const recent = conversations.slice(-5);
      conversationContext = `Recent conversation insights: ${recent.map(c => `User: ${c.user.substring(0, 100)}... Assistant: ${c.assistant.substring(0, 100)}...`).join(" ")}`;
    }
    
    let userPrompt = "";
    if (hasCampaigns) {
      userPrompt = `Based on ${companyContext.name}'s context and existing campaign data, suggest 5 actionable recommendations to improve ad campaigns. ${conversationContext}`;
    } else {
      userPrompt = `The user doesn't have any active campaigns yet. Based on ${companyContext.name}'s context (${companyContext.industry || 'their industry'}), provide 5 helpful "Getting Started" recommendations for creating their first Facebook/Instagram ad campaigns. Focus on best practices, setup tips, and initial strategy. ${conversationContext}`;
    }
    
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { 
          role: "system", 
          content: systemPrompt + ` You are a Facebook Ads performance expert. ${hasCampaigns ? 'Analyze campaign data and provide actionable recommendations.' : 'Provide helpful getting-started guidance for users who haven\'t created campaigns yet.'} Format as JSON with recommendations array, each containing title, campaign (or "Getting Started" if no campaigns), issue (or "Setup" if no campaigns), performance (or "Best Practice" if no campaigns), recommendation, and type fields.` 
        },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" }
    });
    
    const response = JSON.parse(completion.choices[0].message.content);
    
    // Ensure recommendations is always an array
    let recommendations = [];
    if (response.recommendations && Array.isArray(response.recommendations)) {
      recommendations = response.recommendations;
    } else if (Array.isArray(response)) {
      recommendations = response;
    } else if (response.recommendations && typeof response.recommendations === 'string') {
      try {
        const parsed = JSON.parse(response.recommendations);
        recommendations = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        recommendations = [{ title: "Recommendation", recommendation: response.recommendations }];
      }
    } else {
      recommendations = [response];
    }
    
    // Add metadata about data source
    res.json({ 
      recommendations,
      hasCampaigns,
      basedOn: hasCampaigns ? 'existing campaigns' : 'company context and best practices',
      message: hasCampaigns ? 'Recommendations based on your active campaigns' : 'Getting started recommendations - create campaigns to get performance-based suggestions'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Chat endpoint with memory
app.post("/api/ai/chat", async (req, res) => {
  try {
    const { message, history = [] } = req.body;
    
    if (!message) {
      return res.status(400).json({ error: "Message is required" });
    }

    // Load company context and past conversations
    const companyContext = loadCompanyContext();
    const pastConversations = loadConversations();
    const systemPrompt = buildSystemPrompt(companyContext);
    
    // Build messages array for OpenAI
    const messages = [
      {
        role: "system",
        content: systemPrompt + " Remember past conversations and use company context to provide personalized, relevant advice. When users mention 'company profile', they're referring to the Company Profile tab in this dashboard where they can save company information for AI personalization - NOT Facebook or Instagram profile settings."
      }
    ];
    
    // Add relevant past conversations (last 3) for context
    if (pastConversations.length > 0) {
      const recent = pastConversations.slice(-3);
      messages.push({
        role: "system",
        content: `Previous conversation context: ${recent.map(c => `Q: ${c.user} A: ${c.assistant}`).join(" | ")}`
      });
    }
    
    // Add current conversation history
    messages.push(...history.map(msg => ({
      role: msg.role === "user" ? "user" : "assistant",
      content: msg.content
    })));
    
    // Add current message
    messages.push({ role: "user", content: message });

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: messages,
      temperature: 0.7,
      max_tokens: 800
    });

    const aiResponse = completion.choices[0].message.content;
    
    // Save conversation to memory
    saveConversation(message, aiResponse);
    
    res.json({ message: aiResponse });
  } catch (err) {
    console.error("Chat error:", err);
    res.status(500).json({ error: err.message || "Failed to generate response" });
  }
});

// Mock actions
app.post("/api/ai/recommendations/:type/apply", (req, res) => {
  res.json({ ok: true, message: `Applied recommendation: ${req.params.type}` });
});
app.post("/api/ai/recommendations/:type/dismiss", (req, res) => {
  res.json({ ok: true, message: `Dismissed recommendation: ${req.params.type}` });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Backend on http://localhost:${PORT}`));
