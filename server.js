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
const PRODUCTS_FILE = path.join(MEMORY_DIR, "products.json");

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

// Product synchronization functions
async function fetchProductsFromWebsite() {
  const PRODUCTS_URL = process.env.PRODUCTS_URL || "https://maromcosmetic.com/products.json";
  
  try {
    console.log(`[Products] Fetching from ${PRODUCTS_URL}`);
    const response = await axios.get(PRODUCTS_URL, {
      timeout: 10000,
      headers: {
        "User-Agent": "MAROM-Ads-Copilot/1.0"
      }
    });
    
    const products = Array.isArray(response.data) ? response.data : (response.data.products || []);
    console.log(`[Products] Fetched ${products.length} products`);
    
    return products;
  } catch (err) {
    console.error("[Products] Error fetching from website:", err.message);
    throw new Error(`Failed to fetch products: ${err.message}`);
  }
}

function saveProductsCache(data) {
  try {
    const cacheData = {
      products: data,
      lastUpdated: new Date().toISOString(),
      timestamp: Date.now()
    };
    fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(cacheData, null, 2), "utf8");
    console.log(`[Products] Cached ${data.length} products`);
    return true;
  } catch (err) {
    console.error("[Products] Error saving cache:", err);
    return false;
  }
}

function loadProductsCache() {
  try {
    if (fs.existsSync(PRODUCTS_FILE)) {
      const data = JSON.parse(fs.readFileSync(PRODUCTS_FILE, "utf8"));
      return data.products || [];
    }
  } catch (err) {
    console.error("[Products] Error loading cache:", err);
  }
  return [];
}

function getProductsCacheAge() {
  try {
    if (fs.existsSync(PRODUCTS_FILE)) {
      const data = JSON.parse(fs.readFileSync(PRODUCTS_FILE, "utf8"));
      if (data.timestamp) {
        return Date.now() - data.timestamp;
      }
    }
  } catch (err) {
    // Ignore
  }
  return Infinity; // No cache = very old
}

function findProductByName(name) {
  const products = loadProductsCache();
  const searchName = name.toLowerCase().trim();
  
  return products.find(p => {
    const productName = (p.name || p.title || "").toLowerCase();
    return productName.includes(searchName);
  });
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

// JSON parser for all routes
app.use(express.json());

// Allow only your website to call the API
const origins = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => (!origin || origins.includes(origin)) ? cb(null, true) : cb(new Error("Not allowed by CORS"))
}));

const TOKEN = process.env.META_TOKEN;         // keep secret (never in frontend)
const GRAPH = "https://graph.facebook.com/v24.0";

// WhatsApp configuration
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN || TOKEN; // Can use same token if it has WhatsApp permissions
const ADMIN_NUMBERS = (process.env.ADMIN_NUMBERS || "").split(",").map(s => s.trim()).filter(Boolean);

// Pending confirmations for risky commands
const pendingConfirmations = new Map(); // phone -> { command, params, timestamp }

// Helper
const fb = async (path, method="GET", paramsOrBody={}) => {
  const cfg = { url: `${GRAPH}${path}`, method, headers: { Authorization: `Bearer ${TOKEN}` } };
  if (method === "GET") cfg.params = paramsOrBody; else cfg.data = paramsOrBody;
  const { data } = await axios(cfg); return data;
};

// Health
app.get("/health", (_,res) => res.json({ ok: true }));

// WhatsApp webhook verification (GET)
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

// WhatsApp webhook handler (POST) - receives incoming messages
app.post("/webhook/whatsapp", async (req, res) => {
  try {
    const body = req.body;
    
    // Verify webhook signature (optional but recommended for production)
    // You can add signature verification here using req.headers['x-hub-signature-256']
    
    if (body.object === "whatsapp_business_account") {
      body.entry?.forEach((entry) => {
        entry.changes?.forEach((change) => {
          if (change.field === "messages") {
            const value = change.value;
            
            // Handle incoming messages
            if (value.messages) {
              value.messages.forEach(async (message) => {
                await handleIncomingWhatsAppMessage(message, value.contacts?.[0]);
              });
            }
            
            // Handle status updates (message delivered, read, etc.)
            if (value.statuses) {
              value.statuses.forEach((status) => {
                console.log(`Message ${status.id} status: ${status.status}`);
              });
            }
          }
        });
      });
      
      res.status(200).send("OK");
    } else {
      res.status(404).send("Not Found");
    }
  } catch (err) {
    console.error("WhatsApp webhook error:", err);
    res.status(500).send("Internal Server Error");
  }
});

// Helper: Find entity by name or ID
async function findEntityByNameOrId(type, query) {
  try {
    // Get ad accounts
    const accounts = await fb(`/me/adaccounts`, "GET", { fields: "id,account_id,name" });
    
    if (!accounts.data || accounts.data.length === 0) {
      return null;
    }
    
    // Search across all accounts
    for (const account of accounts.data) {
      try {
        const entities = await fb(`/${account.id}/${type}`, "GET", {
          fields: "id,name,status",
          limit: 100
        });
        
        if (entities.data) {
          // Check if query is an ID
          const byId = entities.data.find(e => e.id === query || e.id === query.toString());
          if (byId) return { accountId: account.id, entity: byId };
          
          // Search by name (case-insensitive contains)
          const byName = entities.data.find(e => 
            e.name && e.name.toLowerCase().includes(query.toLowerCase())
          );
          if (byName) return { accountId: account.id, entity: byName };
        }
      } catch (e) {
        // Continue to next account
        continue;
      }
    }
    
    return null;
  } catch (err) {
    console.error(`Error finding ${type}:`, err);
    return null;
  }
}

// Helper: Check if user is admin
function isAdmin(phoneNumber) {
  return ADMIN_NUMBERS.length === 0 || ADMIN_NUMBERS.includes(phoneNumber);
}

// Helper: Log command execution
function logCommand(command, from, result) {
  const log = {
    timestamp: new Date().toISOString(),
    command,
    from,
    result: result.success ? "success" : "error",
    error: result.error || null
  };
  console.log(`[WhatsApp Command] ${JSON.stringify(log)}`);
}

// Handle incoming WhatsApp message
async function handleIncomingWhatsAppMessage(message, contact) {
  const from = message.from;
  const messageText = message.text?.body || "";
  const messageType = message.type;
  
  console.log(`Received WhatsApp message from ${from}: ${messageText}`);
  
  // Only process text messages for now
  if (messageType !== "text") {
    await sendWhatsAppMessage(from, "I can only process text messages at the moment.");
    return;
  }
  
  // Check for pending confirmation
  const pending = pendingConfirmations.get(from);
  if (pending && messageText.toUpperCase() === "YES") {
    pendingConfirmations.delete(from);
    return await executeCommand(from, pending.command, pending.params, true);
  } else if (pending) {
    pendingConfirmations.delete(from);
    await sendWhatsAppMessage(from, "⚠️ Confirmation cancelled.");
    return;
  }
  
  // Command router
  if (messageText.startsWith("/")) {
    const parts = messageText.trim().split(/\s+/);
    const command = parts[0].toLowerCase();
    const params = parts.slice(1);
    
    await executeCommand(from, command, params, false);
  } else {
    // Regular AI chat
    try {
      const companyContext = loadCompanyContext();
      const pastConversations = loadConversations();
      const systemPrompt = buildSystemPrompt(companyContext);
      
      const messages = [
        {
          role: "system",
          content: systemPrompt + " You are helping via WhatsApp. Keep responses concise and conversational. When users mention 'company profile' or 'dashboard', they mean the MAROM Ads Copilot dashboard."
        }
      ];
      
      if (pastConversations.length > 0) {
        const recent = pastConversations.slice(-3);
        messages.push({
          role: "system",
          content: `Previous conversation context: ${recent.map(c => `Q: ${c.user} A: ${c.assistant}`).join(" | ")}`
        });
      }
      
      messages.push({ role: "user", content: messageText });

      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: messages,
        temperature: 0.7,
        max_tokens: 500
      });

      const aiResponse = completion.choices[0].message.content;
      saveConversation(messageText, aiResponse);
      await sendWhatsAppMessage(from, aiResponse);
      
    } catch (err) {
      console.error("Error processing WhatsApp message:", err);
      await sendWhatsAppMessage(from, "⚠️ Couldn't complete action: " + err.message);
    }
  }
}

// Execute command
async function executeCommand(from, command, params, confirmed = false) {
  const result = { success: false, error: null };
  
  try {
    // Check admin access for control commands
    const controlCommands = ["/pause", "/resume", "/budget", "/createad"];
    if (controlCommands.includes(command) && !isAdmin(from)) {
      await sendWhatsAppMessage(from, "⚠️ This command requires admin access.");
      logCommand(command, from, { success: false, error: "Unauthorized" });
      return;
    }
    
    switch (command) {
      case "/help":
        result.success = true;
        await sendWhatsAppMessage(from, getHelpMessage());
        break;
        
      case "/stats":
        result.success = true;
        await handleStats(from, params[0] || "7d");
        break;
        
      case "/campaigns":
        result.success = true;
        await handleCampaigns(from, params[0] || "all");
        break;
        
      case "/best":
        result.success = true;
        await handleBest(from);
        break;
        
      case "/pause":
        if (!confirmed) {
          pendingConfirmations.set(from, { command, params, timestamp: Date.now() });
          await sendWhatsAppMessage(from, `⚠️ Type YES to confirm pausing: ${params.join(" ")}`);
          return;
        }
        result.success = true;
        await handlePause(from, params.join(" "));
        break;
        
      case "/resume":
        if (!confirmed) {
          pendingConfirmations.set(from, { command, params, timestamp: Date.now() });
          await sendWhatsAppMessage(from, `⚠️ Type YES to confirm resuming: ${params.join(" ")}`);
          return;
        }
        result.success = true;
        await handleResume(from, params.join(" "));
        break;
        
      case "/budget":
        if (!confirmed) {
          pendingConfirmations.set(from, { command, params, timestamp: Date.now() });
          await sendWhatsAppMessage(from, `⚠️ Type YES to confirm budget change: ${params.join(" ")}`);
          return;
        }
        result.success = true;
        await handleBudget(from, params);
        break;
        
      case "/ideas":
        result.success = true;
        await handleIdeas(from, params.join(" "));
        break;
        
      case "/copy":
        result.success = true;
        await handleCopy(from, params.join(" "));
        break;
        
      case "/audience":
        result.success = true;
        await handleAudience(from, params.join(" "));
        break;
        
      case "/createad":
        result.success = true;
        await handleCreateAd(from, params);
        break;
        
      case "/profile":
        result.success = true;
        await handleProfile(from, params);
        break;
        
      case "/report":
        result.success = true;
        await handleReport(from, params);
        break;
        
      case "/alerts":
        result.success = true;
        await handleAlerts(from, params[0]);
        break;
        
      case "/products":
        result.success = true;
        await handleProducts(from);
        break;
        
      case "/product":
        result.success = true;
        await handleProduct(from, params.join(" "));
        break;
        
      case "/sync":
        if (params[0] === "products") {
          result.success = true;
          await handleSyncProducts(from);
        } else {
          await sendWhatsAppMessage(from, "⚠️ Usage: /sync products");
          result.error = "Invalid sync target";
        }
        break;
        
      default:
        await sendWhatsAppMessage(from, "⚠️ Unknown command. Type /help for command list.");
        result.error = "Unknown command";
    }
  } catch (err) {
    result.error = err.message;
    await sendWhatsAppMessage(from, `⚠️ Couldn't complete action: ${err.message}`);
  }
  
  logCommand(command, from, result);
}

// Command handlers
async function handleStats(from, period) {
  try {
    const accounts = await fb(`/me/adaccounts`, "GET", { fields: "id,account_id,name" });
    
    if (!accounts.data || accounts.data.length === 0) {
      await sendWhatsAppMessage(from, "📊 No ad accounts found.");
      return;
    }
    
    let datePreset = "last_7d";
    if (period === "today") datePreset = "today";
    else if (period === "30d") datePreset = "last_30d";
    
    let totalSpend = 0, totalImpressions = 0, totalClicks = 0;
    
    for (const account of accounts.data) {
      try {
        const insights = await fb(`/${account.id}/insights`, "GET", {
          date_preset: datePreset,
          fields: "spend,impressions,clicks,ctr,cpc,cpm"
        });
        
        if (insights.data && insights.data[0]) {
          const d = insights.data[0];
          totalSpend += parseFloat(d.spend || 0);
          totalImpressions += parseInt(d.impressions || 0);
          totalClicks += parseInt(d.clicks || 0);
        }
      } catch (e) {
        continue;
      }
    }
    
    const ctr = totalImpressions > 0 ? ((totalClicks / totalImpressions) * 100).toFixed(2) : "0.00";
    const cpc = totalClicks > 0 ? (totalSpend / totalClicks).toFixed(2) : "0.00";
    const cpm = totalImpressions > 0 ? ((totalSpend / totalImpressions) * 1000).toFixed(2) : "0.00";
    
    await sendWhatsAppMessage(from, 
      `📊 Stats (${period})\n` +
      `💰 Spend: $${totalSpend.toFixed(2)}\n` +
      `👁️ Impressions: ${totalImpressions.toLocaleString()}\n` +
      `🖱️ Clicks: ${totalClicks.toLocaleString()}\n` +
      `📈 CTR: ${ctr}%\n` +
      `💵 CPC: $${cpc}\n` +
      `📊 CPM: $${cpm}`
    );
  } catch (err) {
    throw new Error("Failed to fetch stats: " + err.message);
  }
}

async function handleCampaigns(from, filter) {
  try {
    const accounts = await fb(`/me/adaccounts`, "GET", { fields: "id" });
    
    if (!accounts.data || accounts.data.length === 0) {
      await sendWhatsAppMessage(from, "📊 No campaigns found.");
      return;
    }
    
    const campaigns = [];
    for (const account of accounts.data) {
      try {
        const result = await fb(`/${account.id}/campaigns`, "GET", {
          fields: "id,name,status",
          limit: 50
        });
        if (result.data) campaigns.push(...result.data);
      } catch (e) {
        continue;
      }
    }
    
    let filtered = campaigns;
    if (filter === "active") filtered = campaigns.filter(c => c.status === "ACTIVE");
    else if (filter === "paused") filtered = campaigns.filter(c => c.status === "PAUSED");
    
    if (filtered.length === 0) {
      await sendWhatsAppMessage(from, `📊 No ${filter === "all" ? "" : filter} campaigns found.`);
      return;
    }
    
    let msg = `📊 Campaigns (${filtered.length}):\n`;
    filtered.slice(0, 10).forEach(c => {
      msg += `\n${c.status === "ACTIVE" ? "✅" : "🛑"} ${c.name}\nStatus: ${c.status}`;
    });
    
    if (filtered.length > 10) msg += `\n\n...and ${filtered.length - 10} more`;
    
    await sendWhatsAppMessage(from, msg);
  } catch (err) {
    throw new Error("Failed to fetch campaigns: " + err.message);
  }
}

async function handleBest(from) {
  try {
    const accounts = await fb(`/me/adaccounts`, "GET", { fields: "id" });
    const topCampaigns = [];
    
    for (const account of accounts.data || []) {
      try {
        const campaigns = await fb(`/${account.id}/campaigns`, "GET", {
          fields: "id,name",
          limit: 50
        });
        
        for (const campaign of campaigns.data || []) {
          try {
            const insights = await fb(`/${campaign.id}/insights`, "GET", {
              date_preset: "last_7d",
              fields: "ctr,spend,clicks"
            });
            
            if (insights.data && insights.data[0]) {
              const ctr = parseFloat(insights.data[0].ctr || 0);
              topCampaigns.push({
                name: campaign.name,
                ctr,
                spend: parseFloat(insights.data[0].spend || 0),
                clicks: parseInt(insights.data[0].clicks || 0)
              });
            }
          } catch (e) {
            continue;
          }
        }
      } catch (e) {
        continue;
      }
    }
    
    topCampaigns.sort((a, b) => b.ctr - a.ctr);
    const top3 = topCampaigns.slice(0, 3);
    
    if (top3.length === 0) {
      await sendWhatsAppMessage(from, "📊 No performance data available.");
      return;
    }
    
    let msg = "🏆 Top 3 Campaigns:\n";
    top3.forEach((c, i) => {
      msg += `\n${i + 1}. ${c.name}\nCTR: ${c.ctr.toFixed(2)}%\nSpend: $${c.spend.toFixed(2)}`;
    });
    
    await sendWhatsAppMessage(from, msg);
  } catch (err) {
    throw new Error("Failed to fetch best campaigns: " + err.message);
  }
}

async function handlePause(from, query) {
  try {
    const result = await findEntityByNameOrId("campaigns", query);
    if (!result) {
      await sendWhatsAppMessage(from, `⚠️ Campaign not found: ${query}`);
      return;
    }
    
    await fb(`/${result.entity.id}`, "POST", { status: "PAUSED" });
    await sendWhatsAppMessage(from, `🛑 Paused: ${result.entity.name}`);
  } catch (err) {
    throw new Error("Failed to pause: " + err.message);
  }
}

async function handleResume(from, query) {
  try {
    const result = await findEntityByNameOrId("campaigns", query);
    if (!result) {
      await sendWhatsAppMessage(from, `⚠️ Campaign not found: ${query}`);
      return;
    }
    
    await fb(`/${result.entity.id}`, "POST", { status: "ACTIVE" });
    await sendWhatsAppMessage(from, `✅ Resumed: ${result.entity.name}`);
  } catch (err) {
    throw new Error("Failed to resume: " + err.message);
  }
}

async function handleBudget(from, params) {
  try {
    if (params.length < 2) {
      await sendWhatsAppMessage(from, "⚠️ Usage: /budget <name|id> <amount>/day");
      return;
    }
    
    const query = params[0];
    const amountStr = params[1].replace("/day", "").trim();
    const amount = parseFloat(amountStr) * 100; // Convert to cents
    
    const result = await findEntityByNameOrId("campaigns", query);
    if (!result) {
      await sendWhatsAppMessage(from, `⚠️ Campaign not found: ${query}`);
      return;
    }
    
    // Get ad sets for the campaign
    const adsets = await fb(`/${result.entity.id}/adsets`, "GET", {
      fields: "id,name,daily_budget",
      limit: 1
    });
    
    if (!adsets.data || adsets.data.length === 0) {
      await sendWhatsAppMessage(from, "⚠️ No adsets found for this campaign.");
      return;
    }
    
    await fb(`/${adsets.data[0].id}`, "POST", { daily_budget: amount });
    await sendWhatsAppMessage(from, `✅ Budget updated: $${amountStr}/day for ${result.entity.name}`);
  } catch (err) {
    throw new Error("Failed to update budget: " + err.message);
  }
}

async function handleIdeas(from, product) {
  try {
    const companyContext = loadCompanyContext();
    const productData = findProductByName(product);
    const systemPrompt = buildSystemPrompt(companyContext);
    
    let productContext = "";
    if (productData) {
      productContext = `\n\nProduct Details:\n- Name: ${productData.name || productData.title || product}\n- Description: ${productData.description || productData.short_description || "N/A"}\n- Price: ${productData.price ? `$${productData.price}` : "N/A"}\n- Benefits: ${(productData.benefits || productData.features || []).join(", ") || "N/A"}`;
    }
    
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: systemPrompt + " You are a creative strategist. Generate 3 ad angles with hooks in both Thai and English. Format as JSON with ideas array, each containing angle, hook_th, hook_en."
        },
        {
          role: "user",
          content: `Generate 3 ad angles with hooks for: "${product}".${productContext} Format as JSON.`
        }
      ],
      response_format: { type: "json_object" }
    });
    
    const response = JSON.parse(completion.choices[0].message.content);
    const ideas = response.ideas || [];
    
    let msg = `💡 Ad Ideas for "${product}":\n\n`;
    ideas.slice(0, 3).forEach((idea, i) => {
      msg += `${i + 1}. ${idea.angle || "Angle"}\n`;
      msg += `🇹🇭 ${idea.hook_th || ""}\n`;
      msg += `🇬🇧 ${idea.hook_en || ""}\n\n`;
    });
    
    await sendWhatsAppMessage(from, msg);
  } catch (err) {
    throw new Error("Failed to generate ideas: " + err.message);
  }
}

async function handleCopy(from, product) {
  try {
    const companyContext = loadCompanyContext();
    const productData = findProductByName(product);
    const systemPrompt = buildSystemPrompt(companyContext);
    
    let productContext = "";
    if (productData) {
      productContext = `\n\nProduct Details:\n- Name: ${productData.name || productData.title || product}\n- Description: ${productData.description || productData.short_description || "N/A"}\n- Price: ${productData.price ? `$${productData.price}` : "N/A"}\n- Benefits: ${(productData.benefits || productData.features || []).join(", ") || "N/A"}`;
    }
    
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: systemPrompt + " You are a copywriter. Generate 3 ad copies with headlines and primary text in Thai and English. Format as JSON with copies array."
        },
        {
          role: "user",
          content: `Generate 3 ad copies for: "${product}".${productContext} Format as JSON.`
        }
      ],
      response_format: { type: "json_object" }
    });
    
    const response = JSON.parse(completion.choices[0].message.content);
    const copies = response.copies || response.variants || [];
    
    let msg = `✍️ Ad Copy for "${product}":\n\n`;
    copies.slice(0, 3).forEach((copy, i) => {
      msg += `${i + 1}. ${copy.headline_th || copy.headline || ""}\n`;
      msg += `${copy.text_th || copy.text || ""}\n\n`;
    });
    
    await sendWhatsAppMessage(from, msg);
  } catch (err) {
    throw new Error("Failed to generate copy: " + err.message);
  }
}

async function handleAudience(from, product) {
  try {
    const companyContext = loadCompanyContext();
    const productData = findProductByName(product);
    const systemPrompt = buildSystemPrompt(companyContext);
    
    let productContext = "";
    if (productData) {
      productContext = `\n\nProduct Details:\n- Name: ${productData.name || productData.title || product}\n- Description: ${productData.description || productData.short_description || "N/A"}\n- Price: ${productData.price ? `$${productData.price}` : "N/A"}\n- Benefits: ${(productData.benefits || productData.features || []).join(", ") || "N/A"}`;
    }
    
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: systemPrompt + " You are an audience strategist. Recommend targeting demographics, interests, and behaviors. Format as JSON with audience object containing demographics, interests, behaviors."
        },
        {
          role: "user",
          content: `Recommend audience targeting for: "${product}".${productContext} Format as JSON.`
        }
      ],
      response_format: { type: "json_object" }
    });
    
    const response = JSON.parse(completion.choices[0].message.content);
    const audience = response.audience || response;
    
    let msg = `👥 Audience for "${product}":\n\n`;
    if (audience.demographics) msg += `👤 Demographics: ${audience.demographics}\n`;
    if (audience.interests) msg += `🎯 Interests: ${audience.interests}\n`;
    if (audience.behaviors) msg += `📊 Behaviors: ${audience.behaviors}\n`;
    
    await sendWhatsAppMessage(from, msg);
  } catch (err) {
    throw new Error("Failed to generate audience: " + err.message);
  }
}

async function handleCreateAd(from, params) {
  try {
    if (params.length < 2) {
      await sendWhatsAppMessage(from, "⚠️ Usage: /createad <product> <budget>");
      return;
    }
    
    const product = params[0];
    const budget = params[1];
    const companyContext = loadCompanyContext();
    const productData = findProductByName(product);
    
    // Build product context
    let productContext = "";
    if (productData) {
      productContext = `\n\nProduct Details:\n- Name: ${productData.name || productData.title || product}\n- Description: ${productData.description || productData.short_description || "N/A"}\n- Price: ${productData.price ? `$${productData.price}` : "N/A"}\n- Benefits: ${(productData.benefits || productData.features || []).join(", ") || "N/A"}`;
    }
    
    // Generate copy and audience
    const copyPrompt = buildSystemPrompt(companyContext) + " Generate ad copy.";
    const audiencePrompt = buildSystemPrompt(companyContext) + " Generate audience targeting.";
    
    const [copyRes, audienceRes] = await Promise.all([
      openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: copyPrompt },
          { role: "user", content: `Create ad copy for: ${product}${productContext}` }
        ],
        response_format: { type: "json_object" }
      }),
      openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: audiencePrompt },
          { role: "user", content: `Recommend audience for: ${product}${productContext}` }
        ],
        response_format: { type: "json_object" }
      })
    ]);
    
    const copy = JSON.parse(copyRes.choices[0].message.content);
    const audience = JSON.parse(audienceRes.choices[0].message.content);
    
    const preview = {
      product,
      budget: `$${budget}/day`,
      copy: copy.headline || copy.text || "Generated copy",
      audience: audience.demographics || "Target audience",
      status: "DRAFT"
    };
    
    await sendWhatsAppMessage(from, 
      `📝 Ad Draft Preview:\n\n` +
      `Product: ${preview.product}\n` +
      `Budget: ${preview.budget}\n` +
      `Copy: ${preview.copy.substring(0, 50)}...\n` +
      `Audience: ${preview.audience}\n\n` +
      `Status: ${preview.status}\n\n` +
      `(Full JSON available in logs)`
    );
    
    console.log("Ad Draft JSON:", JSON.stringify(preview, null, 2));
  } catch (err) {
    throw new Error("Failed to create ad draft: " + err.message);
  }
}

async function handleProfile(from, params) {
  try {
    const action = params[0]?.toLowerCase();
    
    if (action === "show") {
      const context = loadCompanyContext();
      await sendWhatsAppMessage(from,
        `📋 Company Profile:\n\n` +
        `Name: ${context.name || "N/A"}\n` +
        `Industry: ${context.industry || "N/A"}\n` +
        `Products: ${context.products?.join(", ") || "N/A"}\n` +
        `Audience: ${context.targetAudience || "N/A"}`
      );
    } else if (action === "update" && params.length >= 2) {
      const updateStr = params.slice(1).join(" ");
      const [key, ...valueParts] = updateStr.split("=");
      const value = valueParts.join("=").trim();
      
      const context = loadCompanyContext();
      context[key.trim()] = value;
      saveCompanyContext(context);
      
      await sendWhatsAppMessage(from, `✅ Updated ${key.trim()}`);
    } else if (action === "set") {
      const updates = {};
      params.slice(1).forEach(param => {
        const [key, ...valueParts] = param.split("=");
        if (key && valueParts.length > 0) {
          updates[key.trim()] = valueParts.join("=").trim();
        }
      });
      
      const context = loadCompanyContext();
      Object.assign(context, updates);
      saveCompanyContext(context);
      
      await sendWhatsAppMessage(from, `✅ Updated ${Object.keys(updates).length} fields`);
    } else if (action === "sync") {
      const context = loadCompanyContext();
      await sendWhatsAppMessage(from, `✅ Profile synced: ${context.name}`);
    } else {
      await sendWhatsAppMessage(from, "⚠️ Usage: /profile show|update|set|sync");
    }
  } catch (err) {
    throw new Error("Failed to handle profile: " + err.message);
  }
}

async function handleReport(from, params) {
  const schedule = params[1] || "09:00";
  await sendWhatsAppMessage(from, `📅 Daily report scheduled for ${schedule} (placeholder)`);
}

async function handleAlerts(from, action) {
  const enabled = action === "on";
  await sendWhatsAppMessage(from, `🔔 Alerts ${enabled ? "enabled" : "disabled"} (placeholder)`);
}

async function handleProducts(from) {
  try {
    const products = loadProductsCache();
    
    if (products.length === 0) {
      await sendWhatsAppMessage(from, "📦 No products found. Use /sync products to fetch from website.");
      return;
    }
    
    let msg = `📦 Products (${products.length}):\n\n`;
    products.slice(0, 10).forEach((p, i) => {
      const name = p.name || p.title || "Unnamed";
      const price = p.price ? `$${p.price}` : "N/A";
      const desc = (p.description || p.short_description || "").substring(0, 50);
      msg += `${i + 1}. ${name}\n💰 ${price}${desc ? `\n${desc}...` : ""}\n\n`;
    });
    
    if (products.length > 10) {
      msg += `...and ${products.length - 10} more\n\nUse /product <name> for details`;
    }
    
    await sendWhatsAppMessage(from, msg);
  } catch (err) {
    throw new Error("Failed to list products: " + err.message);
  }
}

async function handleProduct(from, name) {
  try {
    if (!name) {
      await sendWhatsAppMessage(from, "⚠️ Usage: /product <name>");
      return;
    }
    
    const product = findProductByName(name);
    
    if (!product) {
      await sendWhatsAppMessage(from, `⚠️ Product not found: ${name}\n\nUse /products to see all products.`);
      return;
    }
    
    const productName = product.name || product.title || "Unnamed";
    const price = product.price ? `$${product.price}` : "N/A";
    const description = product.description || product.short_description || "No description";
    const benefits = product.benefits || product.features || [];
    const url = product.url || product.link || "";
    
    let msg = `📦 ${productName}\n\n`;
    msg += `💰 Price: ${price}\n\n`;
    msg += `📝 Description:\n${description.substring(0, 300)}${description.length > 300 ? "..." : ""}\n`;
    
    if (benefits.length > 0) {
      msg += `\n✨ Benefits:\n`;
      benefits.slice(0, 5).forEach(b => {
        msg += `• ${b}\n`;
      });
    }
    
    if (url) {
      msg += `\n🔗 ${url}`;
    }
    
    await sendWhatsAppMessage(from, msg);
  } catch (err) {
    throw new Error("Failed to get product: " + err.message);
  }
}

async function handleSyncProducts(from) {
  try {
    await sendWhatsAppMessage(from, "🔄 Syncing products from website...");
    
    const products = await fetchProductsFromWebsite();
    saveProductsCache(products);
    
    await sendWhatsAppMessage(from, `✅ Synced ${products.length} products successfully!`);
    console.log(`[WhatsApp] /sync products executed by ${from}`);
  } catch (err) {
    throw new Error("Failed to sync products: " + err.message);
  }
}

function getHelpMessage() {
  return (
    `📱 *WhatsApp Ad Bot Commands*\n\n` +
    `*📊 MONITORING*\n` +
    `/stats [period] - Get stats (today/7d/30d)\n` +
    `/campaigns [active|paused] - List campaigns\n` +
    `/best - Top 3 campaigns by CTR\n\n` +
    `*🎮 CONTROL*\n` +
    `/pause <name|id> - Pause campaign\n` +
    `/resume <name|id> - Resume campaign\n` +
    `/budget <name|id> <amount>/day - Set budget\n\n` +
    `*💡 CREATIVE*\n` +
    `/ideas <product> - Generate ad angles\n` +
    `/copy <product> - Generate ad copy\n` +
    `/audience <product> - Get targeting\n` +
    `/createad <product> <budget> - Draft ad\n\n` +
    `*📦 PRODUCTS*\n` +
    `/products - List all products\n` +
    `/product <name> - Get product details\n` +
    `/sync products - Refresh from website\n\n` +
    `*📋 PROFILE*\n` +
    `/profile show - View profile\n` +
    `/profile update key=value - Update field\n` +
    `/profile set k1=v1 k2=v2 - Bulk update\n` +
    `/profile sync - Reload profile\n\n` +
    `*⚙️ AUTOMATION*\n` +
    `/report daily [HH:mm] - Schedule reports\n` +
    `/alerts on|off - Toggle alerts\n\n` +
    `Type /help anytime for this list.`
  );
}

// Send WhatsApp message
async function sendWhatsAppMessage(to, text) {
  if (!WHATSAPP_PHONE_NUMBER_ID || !WHATSAPP_ACCESS_TOKEN) {
    console.error("WhatsApp credentials not configured");
    return;
  }
  
  try {
    const response = await axios.post(
      `${GRAPH}/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: to,
        type: "text",
        text: {
          preview_url: false,
          body: text
        }
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );
    
    console.log(`WhatsApp message sent to ${to}:`, response.data);
    return response.data;
  } catch (err) {
    console.error("Error sending WhatsApp message:", err.response?.data || err.message);
    throw err;
  }
}

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

// Products endpoint
app.get("/api/products", async (req, res) => {
  try {
    const refresh = req.query.refresh === "true";
    const cacheAge = getProductsCacheAge();
    const cacheAgeHours = cacheAge / (1000 * 60 * 60);
    
    // Refresh if explicitly requested or cache is older than 24 hours
    if (refresh || cacheAgeHours > 24) {
      console.log(`[Products] ${refresh ? "Manual refresh" : "Auto-refresh (cache > 24h)"}`);
      const products = await fetchProductsFromWebsite();
      saveProductsCache(products);
      res.json({ 
        products, 
        cached: false, 
        lastUpdated: new Date().toISOString(),
        count: products.length 
      });
    } else {
      const products = loadProductsCache();
      console.log(`[Products] Serving from cache (${cacheAgeHours.toFixed(1)}h old)`);
      res.json({ 
        products, 
        cached: true, 
        lastUpdated: fs.existsSync(PRODUCTS_FILE) ? JSON.parse(fs.readFileSync(PRODUCTS_FILE, "utf8")).lastUpdated : null,
        count: products.length 
      });
    }
  } catch (err) {
    console.error("[Products] Error in /api/products:", err);
    // Fallback to cache if fetch fails
    const products = loadProductsCache();
    res.json({ 
      products, 
      cached: true, 
      error: err.message,
      count: products.length 
    });
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
