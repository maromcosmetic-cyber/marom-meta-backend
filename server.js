import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import sharp from "sharp";
import FormData from "form-data";
import {
  WORKFLOWS,
  isMenuTrigger,
  isWorkflowNavigation,
  isShortcut,
  showMainMenu,
  handleWorkflowNavigation,
  handleWorkflowStep,
  handleShortcut,
  initWorkflows
} from "./workflows.js";
dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Memory storage paths
const MEMORY_DIR = path.join(__dirname, "memory");
const DATA_DIR = path.join(__dirname, "data");
const COMPANY_FILE = path.join(MEMORY_DIR, "company.json");
const CONVERSATIONS_FILE = path.join(MEMORY_DIR, "conversations.json");
const AUDIENCES_FILE = path.join(DATA_DIR, "audiences.json");

// Ensure memory and data directories exist
if (!fs.existsSync(MEMORY_DIR)) {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
}
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
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

// WooCommerce configuration
const WC_API_URL = process.env.WC_API_URL || "https://maromcosmetic.com/wp-json/wc/v3/products";
const WC_API_KEY = process.env.WC_API_KEY;
const WC_API_SECRET = process.env.WC_API_SECRET;
const WC_AUTH_MODE = process.env.WC_AUTH_MODE || "query";

// WooCommerce API helper
async function wooFetch(method, endpoint, body = null) {
  const baseUrl = WC_API_URL.replace(/\/products.*$/, ""); // Remove /products suffix if present
  const fullUrl = endpoint.startsWith("http") ? endpoint : `${baseUrl}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`;
  
  // Build query params for authentication
  const params = new URLSearchParams();
  params.append("consumer_key", WC_API_KEY || "");
  params.append("consumer_secret", WC_API_SECRET || "");
  
  const urlWithAuth = `${fullUrl}${fullUrl.includes("?") ? "&" : "?"}${params.toString()}`;
  
  const config = {
    method,
    url: urlWithAuth,
    timeout: 15000,
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json"
    }
  };
  
  if (body) {
    config.data = body;
  }
  
  try {
    const response = await axios(config);
    return response.data;
  } catch (err) {
    // Retry once on 401
    if (err.response?.status === 401 && WC_API_KEY && WC_API_SECRET) {
      console.log("[WooCommerce] Retrying after 401...");
      await new Promise(resolve => setTimeout(resolve, 500));
      const retryResponse = await axios(config);
      return retryResponse.data;
    }
    throw err;
  }
}

// Normalize WooCommerce product to standard format
// Extract WooCommerce store base URL (e.g., https://maromcosmetic.com from https://maromcosmetic.com/wp-json/wc/v3/products)
function getWooCommerceStoreUrl() {
  if (!WC_API_URL) return null;
  try {
    const url = new URL(WC_API_URL);
    return `${url.protocol}//${url.host}`;
  } catch (e) {
    // Fallback: try to extract domain manually
    const match = WC_API_URL.match(/https?:\/\/([^\/]+)/);
    return match ? `${match[0]}` : null;
  }
}

function normalizeProduct(wcProduct) {
  // Extract image URL from WooCommerce product
  // WooCommerce images can be: {src: "...", url: "...", full: {...}, thumbnail: {...}, etc.}
  function getImageUrl(img) {
    if (!img) return null;
    // Prefer full-size image, fallback to src, then url
    if (img.full && img.full.src) return img.full.src;
    if (img.src) return img.src;
    if (img.url) return img.url;
    // Handle string directly
    if (typeof img === 'string') return img;
    return null;
  }
  
  // Ensure image URLs are absolute
  function ensureAbsoluteUrl(url) {
    if (!url) return null;
    // Already absolute
    if (url.startsWith('http://') || url.startsWith('https://')) return url;
    // Protocol-relative
    if (url.startsWith('//')) {
      const storeUrl = getWooCommerceStoreUrl();
      return storeUrl ? `${storeUrl.match(/https?:/)?.[0] || 'https:'}${url}` : url;
    }
    // Relative URL - make absolute
    const storeUrl = getWooCommerceStoreUrl();
    if (storeUrl) {
      return url.startsWith('/') ? `${storeUrl}${url}` : `${storeUrl}/${url}`;
    }
    return url;
  }
  
  const primaryImage = wcProduct.images && wcProduct.images.length > 0 
    ? ensureAbsoluteUrl(getImageUrl(wcProduct.images[0]))
    : null;
  
  const allImages = (wcProduct.images || [])
    .map(img => ensureAbsoluteUrl(getImageUrl(img)))
    .filter(Boolean);
  
  return {
    id: wcProduct.id,
    name: wcProduct.name || "",
    sku: wcProduct.sku || "",
    price: wcProduct.price || wcProduct.regular_price || "0",
    regular_price: wcProduct.regular_price || null,
    sale_price: wcProduct.sale_price || null,
    stock_status: wcProduct.stock_status || "instock",
    stock_quantity: wcProduct.stock_quantity || null,
    categories: (wcProduct.categories || []).map(cat => ({
      id: cat.id,
      name: cat.name
    })),
    image: primaryImage,
    images: allImages,
    // Keep full image objects for frontend flexibility
    images_full: wcProduct.images || [],
    permalink: wcProduct.permalink || "",
    status: wcProduct.status || "publish",
    description: wcProduct.description || "",
    short_description: wcProduct.short_description || ""
  };
}

// Get cached products or fetch fresh
async function getProductsCache() {
  const now = Date.now();
  if (!productCache || (now - productCacheTimestamp) > PRODUCT_CACHE_TTL) {
    try {
      productCache = await wooFetch("GET", "/products?per_page=100");
      productCacheTimestamp = now;
      console.log(`[Products] Cache refreshed: ${productCache.length} products`);
    } catch (err) {
      console.error("[Products] Cache refresh failed:", err.message);
      // Use stale cache if available
      if (!productCache) throw err;
    }
  }
  return productCache || [];
}

// Calculate similarity score between two strings (Levenshtein-based)
function calculateSimilarity(str1, str2) {
  const s1 = str1.toLowerCase();
  const s2 = str2.toLowerCase();
  
  // Exact match
  if (s1 === s2) return 1.0;
  
  // Contains match
  if (s1.includes(s2) || s2.includes(s1)) return 0.8;
  
  // Word-based matching
  const words1 = s1.split(/\s+/);
  const words2 = s2.split(/\s+/);
  const commonWords = words1.filter(w => words2.includes(w));
  if (commonWords.length > 0) {
    return commonWords.length / Math.max(words1.length, words2.length);
  }
  
  // Simple Levenshtein distance approximation
  const maxLen = Math.max(s1.length, s2.length);
  if (maxLen === 0) return 1.0;
  
  let matches = 0;
  const minLen = Math.min(s1.length, s2.length);
  for (let i = 0; i < minLen; i++) {
    if (s1[i] === s2[i]) matches++;
  }
  
  return matches / maxLen;
}

// Find product by name with fuzzy matching and scoring
async function findProductByName(name, useCache = true) {
  try {
    const products = useCache ? await getProductsCache() : await wooFetch("GET", "/products?per_page=100");
    const searchName = name.toLowerCase().trim();
    
    if (!searchName) return null;
    
    // Score all products
    const scored = products.map(p => {
      const productName = (p.name || "").toLowerCase();
      const sku = (p.sku || "").toLowerCase();
      
      // Calculate similarity scores
      const nameScore = calculateSimilarity(searchName, productName);
      const skuScore = sku && calculateSimilarity(searchName, sku) * 0.7; // SKU matches are less important
      
      // Bonus for exact word matches
      const searchWords = searchName.split(/\s+/);
      const productWords = productName.split(/\s+/);
      const wordMatchBonus = searchWords.filter(w => productWords.includes(w)).length / searchWords.length * 0.2;
      
      const totalScore = Math.max(nameScore, skuScore || 0) + wordMatchBonus;
      
      return { product: p, score: totalScore };
    });
    
    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);
    
    // Return best match if score is above threshold (0.5)
    if (scored.length > 0 && scored[0].score >= 0.5) {
      const best = scored[0];
      console.log(`[Products] Found "${name}" → "${best.product.name}" (score: ${best.score.toFixed(2)})`);
      return normalizeProduct(best.product);
    }
    
    // If no good match, return null
    if (scored.length > 0) {
      console.log(`[Products] No good match for "${name}". Best: "${scored[0].product.name}" (score: ${scored[0].score.toFixed(2)})`);
    }
    
    return null;
  } catch (err) {
    console.error("[WooCommerce] Error finding product:", err.message);
    return null;
  }
}

// Find multiple product candidates (for disambiguation)
async function findProductCandidates(name, limit = 5) {
  try {
    const products = await getProductsCache();
    const searchName = name.toLowerCase().trim();
    
    const scored = products.map(p => {
      const productName = (p.name || "").toLowerCase();
      const score = calculateSimilarity(searchName, productName);
      return { product: normalizeProduct(p), score };
    });
    
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).filter(s => s.score >= 0.3).map(s => s.product);
  } catch (err) {
    return [];
  }
}

// Website scraping function
async function scrapeWebsite(url) {
  try {
    const response = await axios.get(url, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });
    
    const html = response.data;
    
    // Extract key information using regex (simple but effective)
    const extractText = (regex, html) => {
      const match = html.match(regex);
      return match ? match[1].replace(/<[^>]*>/g, '').trim() : null;
    };
    
    // Extract title
    const title = extractText(/<title[^>]*>([^<]+)<\/title>/i, html) || 
                  extractText(/<meta\s+property="og:title"\s+content="([^"]+)"/i, html);
    
    // Extract description
    const description = extractText(/<meta\s+name="description"\s+content="([^"]+)"/i, html) ||
                          extractText(/<meta\s+property="og:description"\s+content="([^"]+)"/i, html);
    
    // Extract main content (from common content areas)
    const mainContent = extractText(/<main[^>]*>([\s\S]{0,2000})<\/main>/i, html) ||
                       extractText(/<article[^>]*>([\s\S]{0,2000})<\/article>/i, html) ||
                       extractText(/<div[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]{0,2000})<\/div>/i, html);
    
    // Extract headings
    const headings = [];
    const h1Matches = html.matchAll(/<h1[^>]*>([^<]+)<\/h1>/gi);
    for (const match of h1Matches) {
      headings.push(match[1].replace(/<[^>]*>/g, '').trim());
    }
    const h2Matches = html.matchAll(/<h2[^>]*>([^<]+)<\/h2>/gi);
    for (const match of h2Matches) {
      headings.push(match[1].replace(/<[^>]*>/g, '').trim());
    }
    
    // Extract colors from CSS
    const colors = {
      primary: null,
      secondary: null,
      accent: null
    };
    
    // Look for CSS variables (--primary-color, --brand-color, etc.)
    const cssVarMatches = html.matchAll(/--(?:primary|brand|main|color)[-_]?color:\s*([^;]+);/gi);
    const cssVars = Array.from(cssVarMatches).map(m => m[1].trim());
    if (cssVars.length > 0) {
      colors.primary = cssVars[0];
    }
    
    // Look for common color patterns in style tags and inline styles
    const colorPatterns = [
      /(?:primary|brand|main)[-_]?color['":\s]*[:=]\s*['"]?([#][0-9A-Fa-f]{6}|[#][0-9A-Fa-f]{3}|rgb\([^)]+\)|rgba\([^)]+\))/gi,
      /background[-_]?color:\s*([#][0-9A-Fa-f]{6}|[#][0-9A-Fa-f]{3}|rgb\([^)]+\)|rgba\([^)]+\))/gi,
      /color:\s*([#][0-9A-Fa-f]{6}|[#][0-9A-Fa-f]{3}|rgb\([^)]+\)|rgba\([^)]+\))/gi
    ];
    
    const foundColors = [];
    colorPatterns.forEach(pattern => {
      const matches = html.matchAll(pattern);
      for (const match of matches) {
        let color = match[1].trim();
        // Convert rgb/rgba to hex if needed
        if (color.startsWith('rgb')) {
          const rgbMatch = color.match(/\d+/g);
          if (rgbMatch && rgbMatch.length >= 3) {
            const r = parseInt(rgbMatch[0]);
            const g = parseInt(rgbMatch[1]);
            const b = parseInt(rgbMatch[2]);
            color = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
          }
        }
        // Normalize 3-digit hex to 6-digit
        if (color.match(/^#[0-9A-Fa-f]{3}$/)) {
          color = `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`;
        }
        if (color.match(/^#[0-9A-Fa-f]{6}$/i) && !foundColors.includes(color.toUpperCase())) {
          foundColors.push(color.toUpperCase());
        }
      }
    });
    
    // Assign colors (most common = primary, second = secondary, third = accent)
    if (foundColors.length > 0) {
      colors.primary = foundColors[0];
      if (foundColors.length > 1) colors.secondary = foundColors[1];
      if (foundColors.length > 2) colors.accent = foundColors[2];
    }
    
    // Extract fonts from CSS
    const fonts = {
      primary: null,
      secondary: null
    };
    
    // Look for font-family in CSS
    const fontPatterns = [
      /font[-_]?family:\s*['"]?([^;'"]+)['"]?/gi,
      /--(?:primary|main|body)[-_]?font:\s*['"]?([^;'"]+)['"]?/gi,
      /--font[-_]?family:\s*['"]?([^;'"]+)['"]?/gi
    ];
    
    const foundFonts = [];
    fontPatterns.forEach(pattern => {
      const matches = html.matchAll(pattern);
      for (const match of matches) {
        let font = match[1].trim();
        // Extract first font from font stack (before comma)
        font = font.split(',')[0].trim();
        // Remove quotes
        font = font.replace(/['"]/g, '');
        // Common font names
        const commonFonts = ['Montserrat', 'Inter', 'Roboto', 'Open Sans', 'Lato', 'Poppins', 'Raleway', 'Nunito', 'Playfair Display', 'Merriweather', 'Arial', 'Helvetica', 'Georgia', 'Times New Roman'];
        const matchedFont = commonFonts.find(f => font.toLowerCase().includes(f.toLowerCase()));
        if (matchedFont && !foundFonts.includes(matchedFont)) {
          foundFonts.push(matchedFont);
        } else if (!matchedFont && font && !foundFonts.includes(font)) {
          // Try to extract font name (remove generic fallbacks)
          const fontName = font.split(/\s+/)[0];
          if (fontName && fontName.length > 2 && !['sans-serif', 'serif', 'monospace'].includes(fontName.toLowerCase())) {
            foundFonts.push(fontName);
          }
        }
      }
    });
    
    if (foundFonts.length > 0) {
      fonts.primary = foundFonts[0];
      if (foundFonts.length > 1) fonts.secondary = foundFonts[1];
    }
    
    // Clean up text
    const cleanText = (text) => {
      if (!text) return '';
      return text
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 2000);
    };
    
    return {
      title: title || 'Website',
      description: cleanText(description || mainContent),
      headings: headings.slice(0, 10),
      mainContent: cleanText(mainContent || description),
      colors: colors,
      fonts: fonts,
      url: url
    };
  } catch (err) {
    console.error(`[Website Scraping] Error fetching ${url}:`, err.message);
    throw new Error(`Failed to fetch website: ${err.message}`);
  }
}

// Build system prompt with company context
function buildSystemPrompt(companyContext) {
  let prompt = `You're a friendly, knowledgeable assistant helping ${companyContext.name || "MAROM"} manage their Facebook and Instagram ad campaigns. `;
  
  if (companyContext.industry) {
    prompt += `They're in the ${companyContext.industry} space. `;
  }
  
  if (companyContext.products && companyContext.products.length > 0) {
    const productsList = Array.isArray(companyContext.products) 
      ? companyContext.products.join(", ") 
      : companyContext.products;
    prompt += `Their main products include ${productsList}. `;
  }
  
  if (companyContext.targetAudience) {
    prompt += `They're targeting ${companyContext.targetAudience}. `;
  }
  
  if (companyContext.brandValues) {
    prompt += `Their brand stands for ${companyContext.brandValues}. `;
  }
  
  if (companyContext.campaignGoals) {
    prompt += `Their campaign goals focus on ${companyContext.campaignGoals}. `;
  }
  
  if (companyContext.notes) {
    prompt += `Additional context: ${companyContext.notes}. `;
  }
  
  prompt += `\n\nCOMMUNICATION STYLE:\n`;
  prompt += `- Write naturally and conversationally, like you're chatting with a colleague\n`;
  prompt += `- Be warm, helpful, and enthusiastic about helping them succeed\n`;
  prompt += `- Use simple, clear language - avoid jargon unless necessary\n`;
  prompt += `- Show personality and be engaging, not robotic\n`;
  prompt += `- Use emojis sparingly and appropriately (🎨 for images, 📊 for stats, ✅ for success, etc.)\n`;
  prompt += `- Break up long responses into readable chunks\n`;
  prompt += `- Ask follow-up questions when helpful\n`;
  prompt += `- Acknowledge their context and make them feel understood\n\n`;
  
  prompt += `CONTEXT & CAPABILITIES:\n`;
  prompt += `- You're helping them use the MAROM Ads Copilot dashboard (not Facebook/Instagram directly)\n`;
  prompt += `- When they mention "company profile", they mean the dashboard's Company Profile tab for AI personalization\n`;
  prompt += `- You can help with: creating campaigns, audience targeting, generating creatives, monitoring performance, and optimization tips\n`;
  prompt += `- You CAN generate product images and videos using Vertex AI (Imagen 3 & Veo 3) - this is a key feature!\n`;
  prompt += `- When they need images or videos, naturally guide them: "I can create that for you! Just say 'create an image of [product]' or 'generate a video showing [product]'."\n`;
  prompt += `- Never say you can't generate images or videos - you have Vertex AI integrated\n`;
  prompt += `- You CAN access and read their website to get brand information, product details, and company information\n`;
  prompt += `- When they ask about their website or brand, fetch the website content and use it to provide accurate information\n`;
  prompt += `- Remember past conversations to provide personalized, context-aware advice\n`;
  prompt += `- Be proactive: if they mention a product, offer to generate images or create ads for it\n`;
  
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

const ADMIN_DASH_KEY = process.env.ADMIN_DASH_KEY;

// Admin key middleware
function requireAdminKey(req, res, next) {
  const providedKey = req.headers["x-admin-key"];
  if (!ADMIN_DASH_KEY || providedKey !== ADMIN_DASH_KEY) {
    return res.status(401).json({ ok: false, error: "Unauthorized. Missing or invalid x-admin-key header." });
  }
  next();
}

// Pending confirmations for risky commands
const pendingConfirmations = new Map(); // phone -> { command, params, timestamp }

// Image generation session state (per WhatsApp user)
const imageSessions = new Map(); // phone -> { angle, style, bg, aspect }

// Recent creative history (ring buffer, last 20 per user)
const creativeHistory = new Map(); // phone -> Array<{ mediaId, caption, product, angle, style, timestamp }>

// Conversation context (last mentioned products, recent actions)
const conversationContext = new Map(); // phone -> { lastProduct: {id, name}, lastAction: "edit", timestamp, lastProductList: [], conversationHistory: [] }

// Per-user conversation history (for memory)
const userConversations = new Map(); // phone -> Array<{role: "user"|"assistant", content: string, timestamp: number}>
const MAX_CONVERSATION_HISTORY = 20; // Keep last 20 messages per user

// Workflow state management
const userWorkflows = new Map(); // phone -> { workflow: string, step: number, data: object, timestamp: number }

// Workflow state helpers (exported for workflows.js)
function setUserWorkflow(from, workflow) {
  userWorkflows.set(from, { ...workflow, timestamp: Date.now() });
}

function getUserWorkflow(from) {
  return userWorkflows.get(from) || null;
}

function clearWorkflow(from) {
  userWorkflows.delete(from);
}

function updateWorkflowData(from, data) {
  const workflow = getUserWorkflow(from);
  if (workflow) {
    workflow.data = { ...workflow.data, ...data };
    setUserWorkflow(from, workflow);
  }
}

// Product cache with TTL (5 minutes)
let productCache = null;
let productCacheTimestamp = 0;
const PRODUCT_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Angle presets
const ANGLE_PRESETS = {
  "front": "front-on product hero, eye-level camera",
  "45": "three-quarter 45-degree product angle",
  "side": "side profile product angle",
  "top": "top view, flat lay composition",
  "flatlay": "top view, flat lay composition",
  "macro": "macro close-up, shallow depth of field",
  "lifestyle": "lifestyle context, natural surface, soft daylight"
};

// Get or initialize session
function getSession(from) {
  if (!imageSessions.has(from)) {
    imageSessions.set(from, {
      angle: "front",
      style: "clean studio, premium cosmetics look",
      bg: "plain",
      aspect: "1:1"
    });
  }
  return imageSessions.get(from);
}

// Convert image buffer to base64 data URL
function imageToDataURL(imageBuffer) {
  return `data:image/jpeg;base64,${imageBuffer.toString("base64")}`;
}

// Match angle from user text
function matchAngle(text) {
  const lower = text.toLowerCase();
  if (lower.includes("45") || lower.includes("three-quarter")) return "45";
  if (lower.includes("side") || lower.includes("profile")) return "side";
  if (lower.includes("top") || lower.includes("flatlay") || lower.includes("flat lay")) return "top";
  if (lower.includes("macro") || lower.includes("close-up")) return "macro";
  if (lower.includes("lifestyle") || lower.includes("context")) return "lifestyle";
  if (lower.includes("front") || lower.includes("hero")) return "front";
  return null;
}

// Add to creative history
function addToHistory(from, mediaId, caption, product, angle, style) {
  if (!creativeHistory.has(from)) {
    creativeHistory.set(from, []);
  }
  const history = creativeHistory.get(from);
  history.push({
    mediaId,
    caption,
    product,
    angle,
    style,
    timestamp: Date.now()
  });
  // Keep last 20
  if (history.length > 20) {
    history.shift();
  }
}

// Get last creative
function getLastCreative(from) {
  const history = creativeHistory.get(from);
  return history && history.length > 0 ? history[history.length - 1] : null;
}

// Helper
const fb = async (path, method="GET", paramsOrBody={}) => {
  if (!TOKEN) {
    throw new Error("META_TOKEN not configured. Please set META_TOKEN in your .env file.");
  }
  
  const cfg = { url: `${GRAPH}${path}`, method, headers: { Authorization: `Bearer ${TOKEN}` } };
  if (method === "GET") cfg.params = paramsOrBody; else cfg.data = paramsOrBody;
  
  try {
    const { data } = await axios(cfg);
    return data;
  } catch (err) {
    // Provide more helpful error messages
    if (err.response) {
      const errorData = err.response.data?.error || {};
      const errorMsg = errorData.message || err.response.statusText || "Unknown error";
      const errorCode = errorData.code || err.response.status;
      
      if (errorCode === 190 || errorMsg.includes("Invalid OAuth")) {
        throw new Error("Invalid or expired access token. Please check your META_TOKEN.");
      } else if (errorCode === 200 || errorMsg.includes("Permission denied")) {
        throw new Error("Missing permissions. Please grant 'ads_read' and 'ads_management' permissions.");
      } else if (errorCode === 10 || errorMsg.includes("Permission")) {
        throw new Error("API access denied. Check your app permissions in Meta for Developers.");
      } else {
        throw new Error(`Meta API error (${errorCode}): ${errorMsg}`);
      }
    }
    throw err;
  }
};

// Meta Ads API: Upload image to Ad Account
async function uploadImageToMeta(adAccountId, imageBuffer, name) {
  try {
    const form = new FormData();
    form.append("bytes", imageBuffer, { filename: `${name || "image"}.jpg`, contentType: "image/jpeg" });
    form.append("name", name || "Generated Image");
    
    const response = await axios.post(
      `${GRAPH}/${adAccountId}/adimages`,
      form,
      {
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          ...form.getHeaders()
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity
      }
    );
    
    if (response.data?.images && response.data.images.length > 0) {
      return response.data.images[0].hash; // image_hash for Ad Creative
    }
    throw new Error("No image hash returned from Meta");
  } catch (err) {
    console.error("[Meta] Error uploading image:", err.response?.data || err.message);
    throw new Error(`Failed to upload image to Meta: ${err.message}`);
  }
}

// Meta Ads API: Upload video to Ad Account
async function uploadVideoToMeta(adAccountId, videoBuffer, name) {
  try {
    const form = new FormData();
    form.append("source", videoBuffer, { filename: `${name || "video"}.mp4`, contentType: "video/mp4" });
    form.append("name", name || "Generated Video");
    
    const response = await axios.post(
      `${GRAPH}/${adAccountId}/advideos`,
      form,
      {
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          ...form.getHeaders()
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: 120000 // 2 minutes for video upload
      }
    );
    
    if (response.data?.id) {
      return response.data.id; // video_id for Ad Creative
    }
    throw new Error("No video ID returned from Meta");
  } catch (err) {
    console.error("[Meta] Error uploading video:", err.response?.data || err.message);
    throw new Error(`Failed to upload video to Meta: ${err.message}`);
  }
}

// Meta Ads API: Create Ad Creative
async function createAdCreative(adAccountId, imageHash, headline, text, link, pageId = null) {
  try {
    // Get page ID if not provided
    if (!pageId) {
      const pages = await fb(`/${adAccountId}`, "GET", { fields: "account_id" });
      // Try to get a page associated with the account
      // For now, we'll need PAGE_ID from env or user to provide it
      pageId = process.env.META_PAGE_ID;
      if (!pageId) {
        throw new Error("PAGE_ID required. Set META_PAGE_ID environment variable.");
      }
    }
    
    const creativeData = {
      name: headline.substring(0, 50) || "Ad Creative",
      object_story_spec: {
        page_id: pageId,
        link_data: {
          image_hash: imageHash,
          link: link || process.env.SHOP_URL || "https://maromcosmetic.com",
          message: text || headline,
          name: headline
        }
      }
    };
    
    const creative = await fb(`/${adAccountId}/adcreatives`, "POST", creativeData);
    return creative.id; // creative_id for Ad creation
  } catch (err) {
    console.error("[Meta] Error creating ad creative:", err.response?.data || err.message);
    throw new Error(`Failed to create ad creative: ${err.message}`);
  }
}

// Meta Ads API: Create full campaign structure
async function createCampaignStructure(adAccountId, campaignData) {
  try {
    const { name, objective, budget, media, copy, audience, startTime, endTime } = campaignData;
    
    // 1. Create Campaign
    const campaign = await fb(`/${adAccountId}/campaigns`, "POST", {
      name: name,
      objective: objective || "CONVERSIONS",
      status: "PAUSED", // Create paused by default
      special_ad_categories: []
    });
    const campaignId = campaign.id;
    
    // 2. Create Ad Set
    const adSet = await fb(`/${adAccountId}/adsets`, "POST", {
      name: `${name} - Ad Set`,
      campaign_id: campaignId,
      daily_budget: Math.round(budget * 100), // Convert to cents
      billing_event: "IMPRESSIONS",
      optimization_goal: objective === "CONVERSIONS" ? "OFFSITE_CONVERSIONS" : "REACH",
      targeting: audience || {},
      status: "PAUSED",
      ...(startTime && { start_time: startTime }),
      ...(endTime && { end_time: endTime })
    });
    const adSetId = adSet.id;
    
    // 3. Create Ad Creative (if media provided)
    let creativeId = null;
    if (media && media.imageHash) {
      creativeId = await createAdCreative(
        adAccountId,
        media.imageHash,
        copy?.headline || name,
        copy?.text || "",
        media.link || process.env.SHOP_URL || "https://maromcosmetic.com"
      );
    }
    
    // 4. Create Ad
    const ad = await fb(`/${adAccountId}/ads`, "POST", {
      name: `${name} - Ad`,
      adset_id: adSetId,
      creative: creativeId ? { creative_id: creativeId } : undefined,
      status: "PAUSED"
    });
    
    return {
      campaignId,
      adSetId,
      adId: ad.id,
      creativeId
    };
  } catch (err) {
    console.error("[Meta] Error creating campaign structure:", err.response?.data || err.message);
    throw new Error(`Failed to create campaign: ${err.message}`);
  }
}

// Health
// Serve campaigns HTML page
app.get("/campaigns", (req, res) => {
  try {
    // Try both with and without .html extension
    const campaignsPath = path.join(__dirname, "campaigns.html");
    const campaignsPathNoExt = path.join(__dirname, "campaigns");
    
    let filePath = null;
    if (fs.existsSync(campaignsPath)) {
      filePath = campaignsPath;
    } else if (fs.existsSync(campaignsPathNoExt)) {
      filePath = campaignsPathNoExt;
    }
    
    if (filePath) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
      res.sendFile(filePath);
      console.log("[Server] Served campaigns page from:", filePath);
    } else {
      console.error("[Server] Campaigns file not found. Tried:", campaignsPath, "and", campaignsPathNoExt);
      res.status(404).send("Campaigns page not found");
    }
  } catch (err) {
    console.error("[Server] Error serving campaigns page:", err);
    res.status(500).send("Error loading campaigns page: " + err.message);
  }
});

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
// Get conversation context for a user
function getConversationContext(from) {
  if (!conversationContext.has(from)) {
    conversationContext.set(from, {
      lastProduct: null,
      lastAction: null,
      lastProductList: null, // Store the last shown product list for "number X" references
      conversationHistory: [], // Recent conversation messages for context
      timestamp: Date.now()
    });
  }
  return conversationContext.get(from);
}

// Add message to user's conversation history
function addToConversationHistory(from, role, content) {
  if (!userConversations.has(from)) {
    userConversations.set(from, []);
  }
  
  const history = userConversations.get(from);
  history.push({
    role: role, // "user" or "assistant"
    content: content,
    timestamp: Date.now()
  });
  
  // Keep only last MAX_CONVERSATION_HISTORY messages
  if (history.length > MAX_CONVERSATION_HISTORY) {
    history.shift(); // Remove oldest
  }
  
  // Also update conversation context
  const ctx = getConversationContext(from);
  ctx.conversationHistory = history.slice(-10); // Keep last 10 in context too
}

// Get conversation history for a user (formatted for AI prompt)
function getConversationHistoryForPrompt(from, maxMessages = 10) {
  if (!userConversations.has(from)) {
    return "";
  }
  
  const history = userConversations.get(from);
  const recent = history.slice(-maxMessages); // Last N messages
  
  if (recent.length === 0) return "";
  
  let historyText = "\n\nRECENT CONVERSATION HISTORY:\n";
  recent.forEach((msg, idx) => {
    const role = msg.role === "user" ? "User" : "Assistant";
    historyText += `${role}: ${msg.content}\n`;
  });
  historyText += "\nUse this context to understand what we've been discussing. Reference previous messages naturally when relevant.\n";
  
  return historyText;
}

// Update conversation context
function updateConversationContext(from, product = null, action = null) {
  const ctx = getConversationContext(from);
  if (product) {
    ctx.lastProduct = { id: product.id, name: product.name };
  }
  if (action) {
    ctx.lastAction = action;
  }
  ctx.timestamp = Date.now();
  
  // Clean old contexts (older than 30 minutes)
  const now = Date.now();
  for (const [phone, context] of conversationContext.entries()) {
    if (now - context.timestamp > 30 * 60 * 1000) {
      conversationContext.delete(phone);
    }
  }
}

// Parse natural language product edit requests with improved accuracy
async function parseProductEditRequest(messageText, from = null) {
  const lower = messageText.toLowerCase();
  
  // Enhanced patterns with more variations
  const namePatterns = [
    /(?:change|update|set|make|rename|edit|modify)\s+(?:the\s+)?(?:product\s+)?(?:name|title)\s+(?:to|as|is|be)\s+["']?([^"'\n]+?)["']?(?:\s|$|\.|,)/i,
    /(?:name|title)\s+(?:should\s+be|is|to|as)\s+["']?([^"'\n]+?)["']?(?:\s|$|\.|,)/i,
    /(?:change|update|rename)\s+["']?([^"'\n]+?)["']?\s+(?:name|title)/i,
    /(?:want|need|make)\s+(?:the\s+)?(?:name|title)\s+(?:to\s+be|as)\s+["']?([^"'\n]+?)["']?(?:\s|$|\.|,)/i,
    /(?:call|name)\s+it\s+["']?([^"'\n]+?)["']?(?:\s|$|\.|,)/i
  ];
  
  const pricePatterns = [
    /(?:change|update|set|make)\s+(?:the\s+)?(?:product\s+)?price\s+(?:to|as|is|be)\s+[$]?([\d.]+)/i,
    /price\s+(?:should\s+be|is|to|as)\s+[$]?([\d.]+)/i,
    /(?:want|need|make)\s+(?:the\s+)?price\s+(?:to\s+be|as)\s+[$]?([\d.]+)/i,
    /[$]?([\d.]+)\s+(?:for|as)\s+(?:the\s+)?price/i
  ];
  
  const descPatterns = [
    /(?:change|update|set|edit)\s+(?:the\s+)?(?:product\s+)?description\s+(?:to|as|is|be)\s+["']?([^"'\n]+?)["']?(?:\s|$|\.|,)/i,
    /description\s+(?:should\s+be|is|to|as)\s+["']?([^"'\n]+?)["']?(?:\s|$|\.|,)/i
  ];
  
  const updates = {};
  
  // Extract name/title (more aggressive matching)
  for (const pattern of namePatterns) {
    const match = messageText.match(pattern);
    if (match && match[1]) {
      let value = match[1].trim();
      // Clean up common trailing words
      value = value.replace(/\s+(please|thanks|thank you|ok|okay)$/i, "").trim();
      if (value.length > 0) {
        updates.title = value;
        break;
      }
    }
  }
  
  // Extract price
  for (const pattern of pricePatterns) {
    const match = messageText.match(pattern);
    if (match && match[1]) {
      updates.price = match[1].trim();
      break;
    }
  }
  
  // Extract description
  for (const pattern of descPatterns) {
    const match = messageText.match(pattern);
    if (match && match[1]) {
      updates.description = match[1].trim();
      break;
    }
  }
  
  // Find product name - improved extraction with number support
  let productName = null;
  
  // 0. Check for "product number X" or "number X" references
  if (from) {
    const ctx = getConversationContext(from);
    if (ctx.lastProductList && ctx.lastProductList.length > 0) {
      // Match patterns like "product number 5", "number 5", "#5", "product 5"
      const numberMatch = messageText.match(/(?:product\s+)?(?:number|#|num|no\.?)\s*(\d+)/i);
      if (numberMatch) {
        const index = parseInt(numberMatch[1]) - 1;
        if (index >= 0 && index < ctx.lastProductList.length) {
          const product = ctx.lastProductList[index];
          productName = product.name;
          console.log(`[Context] Using product number ${numberMatch[1]}: ${productName}`);
        }
      }
    }
  }
  
  // 1. Check conversation context for "it", "this", "that"
  if (!productName && from) {
    const ctx = getConversationContext(from);
    if (ctx.lastProduct && (lower.includes("it") || lower.includes("this") || lower.includes("that") || Object.keys(updates).length > 0)) {
      productName = ctx.lastProduct.name;
      console.log(`[Context] Using last mentioned product: ${productName}`);
    }
  }
  
  // 2. Look for explicit product mentions
  if (!productName) {
    // Common product keywords
    const productKeywords = /\b(shampoo|hair|treatment|cream|serum|oil|mask|conditioner|toner|cleanser)\b/i;
    const keywordMatch = messageText.match(productKeywords);
    if (keywordMatch) {
      productName = keywordMatch[0];
    }
  }
  
  // 3. Look for quoted names
  if (!productName) {
    const quotedMatch = messageText.match(/["']([^"']{2,})["']/);
    if (quotedMatch && !quotedMatch[1].match(/^\d+\.?\d*$/)) {
      // Check if it's likely a product name (not a price or description)
      const quoted = quotedMatch[1].trim();
      if (quoted.length > 2 && !quoted.match(/^\$?\d+\.?\d*$/)) {
        productName = quoted;
      }
    }
  }
  
  // 4. Extract product name before "name" or "title" keywords
  if (!productName && updates.title) {
    const beforeNameMatch = messageText.match(/(.+?)\s+(?:name|title)\s+(?:to|as|is|be)/i);
    if (beforeNameMatch && beforeNameMatch[1]) {
      let candidate = beforeNameMatch[1].replace(/(?:change|update|set|make|rename|edit|the|product|number|#|num|no\.?)\s*\d*\s*/gi, "").trim();
      // Remove number if it's just "product number X"
      candidate = candidate.replace(/^(?:product\s+)?(?:number|#|num|no\.?)\s*\d+\s*$/i, "").trim();
      if (candidate.length > 2 && !candidate.match(/^\d+$/)) {
        productName = candidate;
      }
    }
  }
  
  // 5. If we have updates but no product name, try to extract from the beginning
  if (!productName && Object.keys(updates).length > 0) {
    // Pattern: "change product number X name to Y" -> extract X
    const fullPattern = /(?:change|update|set|make|rename|edit)\s+(?:product\s+)?(?:number|#|num|no\.?)\s*(\d+)/i;
    const fullMatch = messageText.match(fullPattern);
    if (fullMatch && from) {
      const ctx = getConversationContext(from);
      if (ctx.lastProductList && ctx.lastProductList.length > 0) {
        const index = parseInt(fullMatch[1]) - 1;
        if (index >= 0 && index < ctx.lastProductList.length) {
          productName = ctx.lastProductList[index].name;
          console.log(`[Context] Extracted product number ${fullMatch[1]}: ${productName}`);
        }
      }
    }
  }
  
  return Object.keys(updates).length > 0 && productName ? { productName, updates } : null;
}

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
    // Check for content creation requests (image/video generation)
    try {
      // Try to import and use the WhatsApp webhook handler for content creation
      const { handleIncomingMessage } = await import("./routes/whatsapp.js");
      const contentResult = await handleIncomingMessage({ from, text: { body: messageText }, type: "text" }, null);
      
      // If content was generated or action handled, don't process as regular chat
      if (contentResult === false) {
        return; // Content creation handled
      }
      // If null, continue with normal chat flow
    } catch (err) {
      // Content creation routes not available, continue with normal flow
      console.log("[WhatsApp] Content creation routes not available:", err.message);
    }
    
    // Check for natural language product edit requests first
    const editRequest = await parseProductEditRequest(messageText, from);
    if (editRequest && editRequest.productName && Object.keys(editRequest.updates).length > 0) {
      // Send immediate acknowledgment
      addToConversationHistory(from, "user", messageText);
      await sendWhatsAppMessage(from, "🔄 Updating...");
      
      // Execute the edit directly
      try {
        // Find product with fuzzy matching
        let product = await findProductByName(editRequest.productName, true);
        
        // If not found, try candidates for disambiguation
        if (!product) {
          const candidates = await findProductCandidates(editRequest.productName, 3);
          if (candidates.length === 1) {
            product = candidates[0];
            console.log(`[Products] Using single candidate: ${product.name}`);
          } else if (candidates.length > 1) {
            let candidateMsg = `I found ${candidates.length} similar products:\n\n`;
            candidates.forEach((c, i) => {
              candidateMsg += `${i + 1}. ${c.name}\n`;
            });
            candidateMsg += `\nWhich one did you mean? Reply with the number or product name.`;
            await sendWhatsAppMessage(from, candidateMsg);
            // Store candidates in context for follow-up
            getConversationContext(from).candidates = candidates;
            return;
          } else {
            await sendWhatsAppMessage(from, `I couldn't find a product matching "${editRequest.productName}".\n\nUse /products to see all products, or try a more specific name.`);
            return;
          }
        }
        
        if (!product) {
          await sendWhatsAppMessage(from, `I couldn't find a product called "${editRequest.productName}". Want me to list all products?`);
          return;
        }
        
        if (!isAdmin(from)) {
          await sendWhatsAppMessage(from, "⚠️ Product editing requires admin access.");
          return;
        }
        
        // Update conversation context
        updateConversationContext(from, product, "edit");
        
        // Build update payload
        const updateData = {};
        if (editRequest.updates.title) updateData.name = editRequest.updates.title;
        if (editRequest.updates.price) updateData.regular_price = String(editRequest.updates.price);
        if (editRequest.updates.description) updateData.description = editRequest.updates.description;
        
        // Execute update and fetch fresh product in parallel for faster response
        const baseUrl = WC_API_URL.replace(/\/products.*$/, "");
        const endpoint = `/products/${product.id}`;
        const fullUrl = `${baseUrl}${endpoint}`;
        
        const queryParams = new URLSearchParams();
        queryParams.append("consumer_key", WC_API_KEY || "");
        queryParams.append("consumer_secret", WC_API_SECRET || "");
        
        const urlWithAuth = `${fullUrl}?${queryParams.toString()}`;
        
        const response = await axios.put(urlWithAuth, updateData, {
          headers: {
            "Content-Type": "application/json",
            "Accept": "application/json"
          },
          timeout: 15000
        });
        
        if (response.status >= 200 && response.status < 300) {
          // Invalidate cache and fetch fresh product
          productCache = null;
          const freshProduct = await wooFetch("GET", `/products/${product.id}`);
          
          // Update context with new product name
          if (freshProduct) {
            updateConversationContext(from, normalizeProduct(freshProduct), "edit");
          }
          
          let confirmMsg = `✅ Done! Updated:\n\n`;
          
          if (editRequest.updates.title) {
            confirmMsg += `📦 Name: ${product.name} → ${freshProduct.name}\n`;
          }
          if (editRequest.updates.price) {
            const oldPrice = product.price || "N/A";
            const newPrice = freshProduct.regular_price || editRequest.updates.price;
            confirmMsg += `💰 Price: $${oldPrice} → $${newPrice}\n`;
          }
          if (editRequest.updates.description) {
            confirmMsg += `📝 Description updated\n`;
          }
          
          confirmMsg += `\n✨ Changes are live on your website!`;
          
          await sendWhatsAppMessage(from, confirmMsg);
          return; // Don't process as natural language chat
        } else {
          await sendWhatsAppMessage(from, `⚠️ Update returned status ${response.status}. Check WooCommerce.`);
          return;
        }
      } catch (err) {
        console.error("[WhatsApp] Natural language edit error:", {
          status: err.response?.status,
          data: err.response?.data,
          message: err.message
        });
        
        let errorMsg = "❌ Couldn't update that.";
        if (err.response?.status === 404) {
          errorMsg = `❌ Product not found in WooCommerce. It may have been deleted.`;
        } else if (err.response?.status === 401) {
          errorMsg = `❌ Permission denied. Check API key permissions.`;
        } else if (err.response?.data?.message) {
          errorMsg = `❌ ${err.response.data.message}`;
        } else {
          errorMsg = `❌ ${err.message || "Unknown error"}`;
        }
        
        addToConversationHistory(from, "assistant", errorMsg);
        await sendWhatsAppMessage(from, errorMsg);
        return;
      }
    }
    
    // Handle follow-up to candidate selection
    const ctx = getConversationContext(from);
    if (ctx.candidates && messageText.match(/^\d+$/)) {
      const index = parseInt(messageText) - 1;
      if (index >= 0 && index < ctx.candidates.length) {
        const selectedProduct = ctx.candidates[index];
        ctx.candidates = null;
        updateConversationContext(from, selectedProduct, "selected");
        const responseMsg = `Got it! Selected "${selectedProduct.name}". What would you like to change?`;
        addToConversationHistory(from, "assistant", responseMsg);
        await sendWhatsAppMessage(from, responseMsg);
        return;
      }
    }
    
    // Natural language AI chat with data integration
    await handleNaturalLanguageChat(from, messageText);
  }
}

// Handle natural language queries with real data integration
async function handleNaturalLanguageChat(from, messageText) {
  try {
    // Add user message to conversation history
    addToConversationHistory(from, "user", messageText);
    
    const companyContext = loadCompanyContext();
    const pastConversations = loadConversations();
    const conversationHistory = getConversationHistoryForPrompt(from, 10); // Last 10 messages
    const ctx = getConversationContext(from);
    const lowerMessage = messageText.toLowerCase();
    
    // Detect what the user is asking about
    let dataContext = "";
    let detectedIntent = null;
    
    // Check for campaign/stats queries
    if (lowerMessage.includes("stat") || lowerMessage.includes("performance") || 
        lowerMessage.includes("spend") || lowerMessage.includes("impression") ||
        lowerMessage.includes("click") || lowerMessage.includes("ctr") ||
        lowerMessage.includes("campaign") || lowerMessage.includes("ad performance")) {
      detectedIntent = "stats";
      try {
        if (TOKEN) {
          const accounts = await fb(`/me/adaccounts`, "GET", { fields: "id,account_id,name" });
          if (accounts.data && accounts.data.length > 0) {
            let totalSpend = 0, totalImpressions = 0, totalClicks = 0;
            for (const account of accounts.data) {
              try {
                const insights = await fb(`/${account.id}/insights`, "GET", {
                  date_preset: "last_7d",
                  fields: "spend,impressions,clicks,ctr,cpc,cpm"
                });
                if (insights.data && insights.data[0]) {
                  const d = insights.data[0];
                  totalSpend += parseFloat(d.spend || 0);
                  totalImpressions += parseInt(d.impressions || 0);
                  totalClicks += parseInt(d.clicks || 0);
                }
              } catch (e) {
                // Continue
              }
            }
            const ctr = totalImpressions > 0 ? ((totalClicks / totalImpressions) * 100).toFixed(2) : "0.00";
            const cpc = totalClicks > 0 ? (totalSpend / totalClicks).toFixed(2) : "0.00";
            dataContext += `\n\nCURRENT CAMPAIGN DATA (Last 7 days):\n- Total Spend: $${totalSpend.toFixed(2)}\n- Impressions: ${totalImpressions.toLocaleString()}\n- Clicks: ${totalClicks.toLocaleString()}\n- CTR: ${ctr}%\n- CPC: $${cpc}`;
          }
        }
      } catch (err) {
        dataContext += `\n\nNote: Could not fetch campaign stats. Error: ${err.message}`;
      }
    }
    
    // Check for campaign list queries
    if (lowerMessage.includes("list campaign") || lowerMessage.includes("show campaign") ||
        lowerMessage.includes("my campaign") || lowerMessage.includes("all campaign")) {
      detectedIntent = "campaigns";
      try {
        if (TOKEN) {
          const accounts = await fb(`/me/adaccounts`, "GET", { fields: "id" });
          if (accounts.data && accounts.data.length > 0) {
            const campaigns = [];
            for (const account of accounts.data) {
              try {
                const result = await fb(`/${account.id}/campaigns`, "GET", {
                  fields: "id,name,status",
                  limit: 20
                });
                if (result.data) campaigns.push(...result.data);
              } catch (e) {
                // Continue
              }
            }
            if (campaigns.length > 0) {
              const activeCount = campaigns.filter(c => c.status === "ACTIVE").length;
              const pausedCount = campaigns.filter(c => c.status === "PAUSED").length;
              dataContext += `\n\nCURRENT CAMPAIGNS:\n- Total: ${campaigns.length}\n- Active: ${activeCount}\n- Paused: ${pausedCount}\n\nRecent campaigns: ${campaigns.slice(0, 5).map(c => `${c.name} (${c.status})`).join(", ")}`;
            }
          }
        }
      } catch (err) {
        dataContext += `\n\nNote: Could not fetch campaigns. Error: ${err.message}`;
      }
    }
    
    // Check for product queries
    if (lowerMessage.includes("product") && !lowerMessage.includes("create")) {
      detectedIntent = "products";
      try {
        const products = await wooFetch("GET", "/products?per_page=10");
        if (products && products.length > 0) {
          dataContext += `\n\nAVAILABLE PRODUCTS (${products.length}):\n`;
          products.slice(0, 5).forEach((p, i) => {
            const normalized = normalizeProduct(p);
            const name = normalized.name || "Unnamed";
            const price = normalized.price ? `$${normalized.price}` : "N/A";
            dataContext += `${i + 1}. ${name} - ${price}\n`;
          });
          
          // Try to find specific product mentioned
          const productMatch = messageText.match(/\b(shampoo|hair|treatment|product|cream|serum|oil|mask)\b/i);
          if (productMatch) {
            const foundProduct = await findProductByName(productMatch[0]);
            if (foundProduct) {
              dataContext += `\n\nMATCHED PRODUCT DETAILS:\n- Name: ${foundProduct.name}\n- Price: ${foundProduct.price ? `$${foundProduct.price}` : "N/A"}\n- Description: ${(foundProduct.description || foundProduct.short_description || "").substring(0, 200)}`;
            }
          }
        } else {
          dataContext += `\n\nNote: No products found in WooCommerce. Use /products to list all products.`;
        }
      } catch (err) {
        dataContext += `\n\nNote: Could not fetch products from WooCommerce. Error: ${err.message}`;
      }
    }
    
    // Check for product management queries (edit, update, change, set)
    if ((lowerMessage.includes("edit product") || lowerMessage.includes("update product") || 
         lowerMessage.includes("change product") || lowerMessage.includes("set product") ||
         lowerMessage.includes("product title") || lowerMessage.includes("product price") ||
         lowerMessage.includes("product description")) && !lowerMessage.includes("create")) {
      detectedIntent = "product_management";
      try {
        const products = await wooFetch("GET", "/products?per_page=20");
        if (products && products.length > 0) {
          dataContext += `\n\nAVAILABLE PRODUCTS TO MANAGE:\n`;
          products.slice(0, 10).forEach((p, i) => {
            const normalized = normalizeProduct(p);
            dataContext += `${i + 1}. ${normalized.name} (ID: ${normalized.id})\n`;
          });
          dataContext += `\n\nPRODUCT MANAGEMENT COMMANDS:\n`;
          dataContext += `- /product edit <name> title="New Title"\n`;
          dataContext += `- /product edit <name> price=99.99\n`;
          dataContext += `- /product edit <name> description="New description"\n`;
          dataContext += `- /product info <name> - Get full product details\n`;
        }
      } catch (err) {
        dataContext += `\n\nNote: Could not fetch products. Error: ${err.message}`;
      }
    }
    
    // Check for website/brand information queries
    if (lowerMessage.includes("website") || lowerMessage.includes("look at") || 
        lowerMessage.includes("check website") || lowerMessage.includes("visit website") ||
        lowerMessage.includes("brand info") || lowerMessage.includes("company info") ||
        lowerMessage.includes("about us") || lowerMessage.includes("our brand") ||
        lowerMessage.includes("what's on") || lowerMessage.includes("what is on")) {
      detectedIntent = "website_info";
      try {
        const websiteUrl = process.env.SHOP_URL || process.env.WEBSITE_URL || "https://maromcosmetic.com";
        await sendWhatsAppMessage(from, "🌐 Fetching information from your website...");
        
        const websiteData = await scrapeWebsite(websiteUrl);
        
        dataContext += `\n\nWEBSITE INFORMATION (${websiteData.url}):\n`;
        dataContext += `- Title: ${websiteData.title}\n`;
        if (websiteData.description) {
          dataContext += `- Description: ${websiteData.description.substring(0, 500)}\n`;
        }
        if (websiteData.headings && websiteData.headings.length > 0) {
          dataContext += `- Key Sections: ${websiteData.headings.slice(0, 5).join(", ")}\n`;
        }
        if (websiteData.mainContent) {
          dataContext += `- Main Content: ${websiteData.mainContent.substring(0, 800)}\n`;
        }
        
        // Update company context with website info if not already set
        if (!companyContext.name && websiteData.title) {
          companyContext.name = websiteData.title.replace(/ - .*$/, '').trim();
        }
        if (!companyContext.notes) {
          companyContext.notes = `Website: ${websiteData.url}. ${websiteData.description || ''}`;
        }
        
      } catch (err) {
        dataContext += `\n\nNote: Could not fetch website information. Error: ${err.message}`;
        await sendWhatsAppMessage(from, `⚠️ Could not access website: ${err.message}\n\nPlease check SHOP_URL or WEBSITE_URL environment variable.`);
      }
    }
    
    // Check for ad creation queries
    if (lowerMessage.includes("create ad") || lowerMessage.includes("make ad") ||
        lowerMessage.includes("generate ad") || lowerMessage.includes("new campaign")) {
      detectedIntent = "create_ad";
      try {
        const products = await wooFetch("GET", "/products?per_page=10");
        if (products && products.length > 0) {
          dataContext += `\n\nAVAILABLE PRODUCTS FOR AD CREATION:\n`;
          products.slice(0, 10).forEach((p, i) => {
            const normalized = normalizeProduct(p);
            const name = normalized.name || "Unnamed";
            dataContext += `${i + 1}. ${name}\n`;
          });
        }
      } catch (err) {
        dataContext += `\n\nNote: Could not fetch products. Error: ${err.message}`;
      }
    }
    
    // Check for image/video generation queries (natural language)
    const isImageRequest = lowerMessage.includes("generate image") || lowerMessage.includes("create image") ||
        lowerMessage.includes("make image") || lowerMessage.includes("product photo") ||
        lowerMessage.includes("product image") || lowerMessage.includes("need image") ||
        lowerMessage.includes("create photo") || lowerMessage.includes("generate photo") ||
        lowerMessage.includes("i need an image") || lowerMessage.includes("i want an image");
    
    const isVideoRequest = lowerMessage.includes("create video") || lowerMessage.includes("generate video") ||
        lowerMessage.includes("make video") || lowerMessage.includes("video clip") ||
        lowerMessage.includes("video for campaign") || lowerMessage.includes("campaign video") ||
        lowerMessage.includes("i need a video") || lowerMessage.includes("i want a video");
    
    if (isImageRequest || isVideoRequest) {
      detectedIntent = "content_generation";
      
      // Flag to track if we're generating media (to prevent AI response)
      let isGeneratingMedia = false;
      
      // Try to extract product name from message
      let productName = null;
      
      // Common patterns: "create image of [product]", "generate video for [product]", etc.
      const productPatterns = [
        /(?:image|photo|video|clip)\s+(?:of|for|with|showing)\s+([^,\.\?\!]+)/i,
        /(?:create|generate|make)\s+(?:an?\s+)?(?:image|photo|video|clip)\s+(?:of|for|with|showing)?\s*([^,\.\?\!]+)/i,
        /(?:serum|shampoo|conditioner|product|mosquito|repellent|cream|oil|mask|treatment)/i
      ];
      
      for (const pattern of productPatterns) {
        const match = messageText.match(pattern);
        if (match && match[1]) {
          productName = match[1].trim().replace(/\s+(image|photo|video|clip|for|of|with|showing)$/i, '').trim();
          break;
        }
      }
      
      // If no pattern match, try to find product keywords
      if (!productName) {
        const productKeywords = ["serum", "shampoo", "conditioner", "mosquito", "repellent", "cream", "oil", "mask", "treatment"];
        for (const keyword of productKeywords) {
          if (lowerMessage.includes(keyword)) {
            productName = keyword;
            break;
          }
        }
      }
      
      // Handle multi-word products like "mosquito repellent"
      if (lowerMessage.includes("mosquito") && lowerMessage.includes("repellent")) {
        productName = "mosquito repellent";
      }
      
      console.log(`[Natural Language] Detected ${isImageRequest ? 'image' : 'video'} request, extracted productName: "${productName}"`);
      
      // If we found a product, actually generate the media
      if (productName) {
        try {
          console.log(`[Natural Language] Looking up product: "${productName}"`);
          const product = await findProductByName(productName, true);
          console.log(`[Natural Language] Product lookup result:`, product ? `Found: ${product.name} (ID: ${product.id})` : 'Not found');
          
          if (product) {
            isGeneratingMedia = true; // Set flag before starting generation
            // Actually trigger generation instead of just responding
            if (isVideoRequest) {
              // Generate video
              await sendWhatsAppMessage(from, `🎬 Creating optimized prompt for video...`);
              
              const session = getSession(from);
              const companyContext = loadCompanyContext();
              
              // Build enhanced prompt (with fallback for rate limits)
              const basePrompt = `UGC style video showcasing ${product.name}, natural lighting, authentic feel`;
              let enhancedPrompt;
              try {
                enhancedPrompt = await enhanceImagePrompt(
                  basePrompt,
                  product,
                  companyContext,
                  session,
                  null,
                  null
                );
              } catch (err) {
                if (err.message.includes("Rate limit") || err.message.includes("429")) {
                  console.warn("[Video Generation] Rate limit hit, using fallback prompt");
                  enhancedPrompt = buildEnhancedPromptFallback(
                    basePrompt,
                    product,
                    companyContext,
                    session,
                    null,
                    null
                  );
                } else {
                  throw err;
                }
              }
              
              await sendWhatsAppMessage(from, `✨ Generating video with enhanced prompt...`);
              
              let generateVideo;
              try {
                // Try multiple possible paths for production environments
                let vertexModule;
                const possiblePaths = [
                  "./services/vertexService.js",
                  path.join(__dirname, "services", "vertexService.js"),
                  path.join(process.cwd(), "services", "vertexService.js"),
                  "../services/vertexService.js"
                ];
                
                let importError = null;
                for (const importPath of possiblePaths) {
                  try {
                    // For absolute paths, convert to file:// URL for ES modules
                    const normalizedPath = importPath.startsWith(".") 
                      ? importPath 
                      : `file://${importPath}`;
                    vertexModule = await import(normalizedPath);
                    console.log(`[Video Generation] Successfully imported Vertex AI from: ${importPath}`);
                    break;
                  } catch (err) {
                    importError = err;
                    continue;
                  }
                }
                
                if (!vertexModule) {
                  throw importError || new Error("Could not import vertexService from any path");
                }
                
                generateVideo = vertexModule.generateVideo;
                if (!generateVideo) {
                  throw new Error("generateVideo function not found in vertexService module");
                }
              } catch (importErr) {
                console.error("[Video Generation] Failed to import vertexService:", importErr.message);
                console.error("[Video Generation] Import error details:", {
                  message: importErr.message,
                  code: importErr.code,
                  path: importErr.path || "unknown"
                });
                await sendWhatsAppMessage(from, `⚠️ Video generation service not available. Please check Vertex AI configuration.\n\nError: ${importErr.message}`);
                return;
              }
              
              const result = await generateVideo(enhancedPrompt, "9:16", 8, {
                title: product.name,
                shortDesc: product.description || product.short_description || "",
                permalink: product.permalink || ""
              });
              
              // Upload and send video
              const mediaId = await uploadWhatsAppMedia(result.buffer, result.mimeType);
              
              const caption = `✨ Video generated!\n\n📦 ${product.name}\n\n💡 Reply:\n• "use" - Use in campaign\n• "regenerate" - Create another`;
              
              // Send video via WhatsApp
              try {
                await axios.post(
                  `${GRAPH}/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
                  {
                    messaging_product: "whatsapp",
                    recipient_type: "individual",
                    to: from,
                    type: "video",
                    video: {
                      id: mediaId,
                      caption: caption
                    }
                  },
                  {
                    headers: {
                      Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
                      "Content-Type": "application/json"
                    }
                  }
                );
                console.log(`[Natural Language] Video sent to ${from}: ${product.name}, media_id: ${mediaId}`);
              } catch (err) {
                console.error("[Natural Language] Error sending video:", err.response?.data || err.message);
                await sendWhatsAppMessage(from, `✅ Video generated but failed to send. Media ID: ${mediaId}\n\nError: ${err.message}`);
              }
              
              // Save to history
              addToHistory(from, mediaId, `Video: ${product.name}`, product.name, session.angle, session.style);
              
              // Don't continue with AI chat - we've handled it
              return;
              
            } else {
              // Generate image
              await sendWhatsAppMessage(from, `🎨 Creating optimized prompt...`);
              
              const session = getSession(from);
              const companyContext = loadCompanyContext();
              
              // Build enhanced prompt using AI with brand/product data (with fallback)
              let prompt;
              try {
                prompt = await buildEnhancedImagePrompt(product, session, companyContext);
              } catch (err) {
                if (err.message.includes("Rate limit") || err.message.includes("429")) {
                  console.warn("[Image Generation] Rate limit hit, using fallback prompt");
                  prompt = buildEnhancedPromptFallback(
                    `create image for ${product.name}`,
                    product,
                    companyContext,
                    session
                  );
                } else {
                  throw err;
                }
              }
              
              await sendWhatsAppMessage(from, `✨ Generating image with enhanced prompt...`);
              
              // Generate image using Vertex AI
              const imageBuffer = await generateImageWithEngine(prompt, "1:1", 1024, 1024);
              
              // Upload to WhatsApp
              const mediaId = await uploadWhatsAppMedia(imageBuffer, "image/jpeg");
              
              // Send image using existing function
              const caption = `✨ Image generated!\n\n📦 ${product.name}\n📐 Angle: ${session.angle}\n\n💡 Reply:\n• "use" - Use in campaign\n• "edit" - Edit this image\n• "make video" - Create video version\n• "regenerate" - Create another`;
              
              await sendWhatsAppImage(from, mediaId, caption);
              
              // Save to history
              addToHistory(from, mediaId, caption, product.name, session.angle, session.style);
              
              console.log(`[Natural Language] Generated image for ${from}: ${product.name}, media_id: ${mediaId}`);
              
              // Don't continue with AI chat - we've handled it
              return;
            }
          } else {
            // Product not found - try fuzzy search with full phrase
            console.log(`[Natural Language] Product "${productName}" not found, trying fuzzy search...`);
            const candidates = await findProductCandidates(productName, 3);
            if (candidates.length > 0) {
              console.log(`[Natural Language] Found ${candidates.length} candidates, using first: ${candidates[0].name}`);
              const product = candidates[0];
              
              // Generate image with found product
              await sendWhatsAppMessage(from, `🎨 Creating optimized prompt...`);
              
              const session = getSession(from);
              const companyContext = loadCompanyContext();
              
              let prompt;
              try {
                prompt = await buildEnhancedImagePrompt(product, session, companyContext);
              } catch (err) {
                if (err.message.includes("Rate limit") || err.message.includes("429")) {
                  console.warn("[Image Generation] Rate limit hit, using fallback prompt");
                  prompt = buildEnhancedPromptFallback(
                    `create image for ${product.name}`,
                    product,
                    companyContext,
                    session
                  );
                } else {
                  throw err;
                }
              }
              
              await sendWhatsAppMessage(from, `✨ Generating image with enhanced prompt...`);
              
              const imageBuffer = await generateImageWithEngine(prompt, "1:1", 1024, 1024);
              const mediaId = await uploadWhatsAppMedia(imageBuffer, "image/jpeg");
              
              const caption = `✨ Image generated!\n\n📦 ${product.name}\n📐 Angle: ${session.angle}\n\n💡 Reply:\n• "use" - Use in campaign\n• "edit" - Edit this image\n• "make video" - Create video version\n• "regenerate" - Create another`;
              
              await sendWhatsAppImage(from, mediaId, caption);
              addToHistory(from, mediaId, caption, product.name, session.angle, session.style);
              
              console.log(`[Natural Language] Generated image for ${from}: ${product.name}, media_id: ${mediaId}`);
              return; // Don't continue to AI chat
            } else {
              // Product not found - let AI handle it
              console.log(`[Natural Language] No product candidates found for "${productName}"`);
              dataContext += `\n\nNote: Could not find product "${productName}". Available products listed below.`;
            }
          }
        } catch (err) {
          console.error("[Natural Language] Media generation error:", err);
          console.error("[Natural Language] Error stack:", err.stack);
          await sendWhatsAppMessage(from, `⚠️ Failed to generate: ${err.message}\n\nTrying alternative approach...`);
          // Continue to AI chat for fallback
        }
      } else {
        console.log(`[Natural Language] No product name extracted from message: "${messageText}"`);
      }
      
      // Provide context for AI if generation didn't happen
      try {
        const products = await wooFetch("GET", "/products?per_page=10");
        if (products && products.length > 0) {
          dataContext += `\n\nAVAILABLE PRODUCTS FOR CONTENT GENERATION:\n`;
          products.slice(0, 10).forEach((p, i) => {
            const normalized = normalizeProduct(p);
            const name = normalized.name || "Unnamed";
            dataContext += `${i + 1}. ${name}\n`;
          });
        }
      } catch (err) {
        dataContext += `\n\nNote: Could not fetch products. Error: ${err.message}`;
      }
      // If we're generating media, don't let AI respond - we'll handle it
      if ((isImageRequest || isVideoRequest) && isGeneratingMedia) {
        // Media generation is in progress - skip AI response
        console.log(`[Natural Language] Media generation in progress, skipping AI response`);
        return; // Exit early - generation code will handle the response
      }
      
      if (isImageRequest || isVideoRequest) {
        // Only add context if generation didn't happen (product not found)
        if (!productName) {
          dataContext += `\n\nIMPORTANT: User requested ${isImageRequest ? 'image' : 'video'} generation but no product was identified. List available products and ask which one they want.`;
        }
      } else {
        dataContext += `\n\nIMPORTANT: When user requests image/video generation, you should acknowledge enthusiastically and confirm the generation is happening. The system will automatically generate and send the media.`;
      }
    }
    
    // Build enhanced system prompt
    let systemPrompt = buildSystemPrompt(companyContext);
    
    // Add website access capability to system prompt
    systemPrompt += `\n\nIMPORTANT: You CAN access and read their website. When they ask about their website, brand, or company information, use the website data provided in the context below. Never say you can't access websites - you have website scraping capabilities integrated.`;
    systemPrompt += "\n\nYou're chatting via WhatsApp - keep it friendly and concise, like texting a colleague.";
    systemPrompt += "\nYou have access to their REAL campaign data, product catalog, and company profile - use this to give specific, helpful answers.";
    systemPrompt += "\nWhen they ask about performance or campaigns, reference the actual numbers and data below - it makes you more credible and helpful.";
    systemPrompt += "\nFor image generation requests, respond enthusiastically: 'I'd love to help! Use /image [product] for a single image, or /images [product] for a full pack with all sizes.'";
    systemPrompt += "\nIf you don't have data, guide them naturally: 'Let me check that for you - try /stats or /campaigns to see what's running.'";
    systemPrompt += "\nFor campaign actions, suggest commands naturally: 'Want to pause that campaign? Just use /pause [campaign name].'";
    systemPrompt += "\nFor product edits: When users say things like 'change the name to X' or 'update price to Y', you can acknowledge it but DON'T explain commands - the system will handle it automatically. Just respond naturally like 'Got it! Updating that for you...' or 'Done! Changed the name to X.'";
    systemPrompt += "\nBe proactive and action-oriented - if they want to change something, acknowledge it warmly and let them know it's being done. Don't give instructions unless they explicitly ask how to do something.";
    systemPrompt += "\nKeep responses conversational and brief - like texting a friend, not a manual.";
    systemPrompt += "\n\nIMPORTANT: Remember what we've been discussing in this conversation. Reference previous messages naturally when relevant. If the user refers to something mentioned earlier (like 'that product', 'the campaign we discussed', 'the one I mentioned'), use the conversation history to understand what they mean.";
    
    if (detectedIntent) {
      systemPrompt += `\n\nUser intent detected: ${detectedIntent}`;
    }
    
    // Add conversation history to system prompt
    if (conversationHistory) {
      systemPrompt += conversationHistory;
    }
    
    // Build messages array with conversation history
    const messages = [
      {
        role: "system",
        content: systemPrompt + dataContext
      }
    ];
    
    // Add recent conversation history as message history (better for AI context)
    if (userConversations.has(from)) {
      const history = userConversations.get(from);
      const recentHistory = history.slice(-8); // Last 8 messages (4 exchanges)
      
      // Add history messages before the current one
      recentHistory.forEach(msg => {
        if (msg.role === "user" || msg.role === "assistant") {
          messages.push({
            role: msg.role,
            content: msg.content
          });
        }
      });
    }
    
    // Add current user message
    messages.push({ role: "user", content: messageText });

    let aiResponse;
    try {
      // Try primary model first, with fallback
      const completion = await openaiWithFallback({
        model: "gpt-4o-mini",
        messages: messages,
        temperature: 0.8, // Higher temperature for more natural, varied responses
        max_tokens: 600,
        presence_penalty: 0.3, // Encourage more varied vocabulary
        frequency_penalty: 0.2 // Reduce repetition
      });
      aiResponse = completion.choices[0].message.content;
    } catch (err) {
      // If both models fail, use static response
      console.warn("[OpenAI] Both models failed, using static response");
      aiResponse = "I'm experiencing high API demand right now. Let me try a simpler approach...\n\n" +
        "For image/video generation, please use:\n" +
        "• /image <product> - Generate single image\n" +
        "• /images <product> - Generate image pack\n" +
        "• /video <product> - Generate video\n\n" +
        "For campaign management:\n" +
        "• /campaigns - List campaigns\n" +
        "• /stats - View performance\n" +
        "• /help - Full command list";
    }
    
    // Add assistant response to conversation history
    addToConversationHistory(from, "assistant", aiResponse);
    
    // Also save to global conversation log
    saveConversation(messageText, aiResponse);
    
    await sendWhatsAppMessage(from, aiResponse);
    
  } catch (err) {
    console.error("Error processing natural language chat:", err);
    
    // More human-friendly error messages
    let errorMsg = "Sorry, I ran into an issue";
    if (err.message.includes("loadProductsCache")) {
      errorMsg = "I'm having trouble accessing products right now. Let me try fetching them fresh from WooCommerce...";
      try {
        await wooFetch("GET", "/products?per_page=5");
        errorMsg = "Products are accessible! Try asking again, or use /products to see all products.";
      } catch (fetchErr) {
        errorMsg = "I can't connect to WooCommerce right now. Please check:\n• WC_API_URL is set correctly\n• WC_API_KEY and WC_API_SECRET are valid\n• WooCommerce REST API is enabled";
      }
    } else if (err.message.includes("WooCommerce") || err.message.includes("woo")) {
      errorMsg = `I'm having trouble connecting to WooCommerce: ${err.message}\n\nTry:\n• /products - List products\n• /test products - Test connection`;
    } else {
      errorMsg = `I couldn't complete that: ${err.message}\n\nTry rephrasing your request or use /help for available commands.`;
    }
    
    await sendWhatsAppMessage(from, errorMsg);
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
        await handleProduct(from, params);
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
        
      case "/test":
      case "/check":
        if (params[0] === "api") {
          result.success = true;
          await handleTestApi(from);
        } else if (params[0] === "products" || params[0] === "website") {
          result.success = true;
          await handleTestProducts(from);
        } else {
          await sendWhatsAppMessage(from, "⚠️ Usage: /test api | /test products");
          result.error = "Invalid test target";
        }
        break;
        
      case "/angle":
        result.success = true;
        await handleAngle(from, params.join(" "));
        break;
        
      case "/style":
        result.success = true;
        await handleStyle(from, params.join(" "));
        break;
        
      case "/image":
        result.success = true;
        await handleImage(from, params);
        break;
        
      case "/images":
        if (!isAdmin(from) && ADMIN_NUMBERS.length > 0) {
          await sendWhatsAppMessage(from, "⚠️ This command requires admin access.");
          result.error = "Unauthorized";
        } else {
          result.success = true;
          await handleImages(from, params);
        }
        break;
        
      case "/last":
        result.success = true;
        await handleLast(from);
        break;
        
      case "/redo":
        if (!isAdmin(from) && ADMIN_NUMBERS.length > 0) {
          await sendWhatsAppMessage(from, "⚠️ This command requires admin access.");
          result.error = "Unauthorized";
        } else {
          result.success = true;
          await handleRedo(from);
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
async function handleTestApi(from) {
  try {
    await sendWhatsAppMessage(from, "🔍 Testing Meta API access...");
    
    // Check if token is configured
    if (!TOKEN) {
      await sendWhatsAppMessage(from, 
        "❌ META_TOKEN not configured.\n\n" +
        "Please set META_TOKEN in your .env file.\n" +
        "Get your token from:\n" +
        "https://developers.facebook.com/tools/explorer/"
      );
      return;
    }
    
    // Test basic API access
    try {
      const me = await fb(`/me`, "GET", { fields: "id,name" });
      await sendWhatsAppMessage(from, `✅ API Connected!\n\nUser: ${me.name || me.id}\nID: ${me.id}`);
    } catch (err) {
      await sendWhatsAppMessage(from, `❌ API Connection Failed:\n\n${err.message}\n\nCheck your META_TOKEN.`);
      return;
    }
    
    // Test ad accounts access
    try {
      const accounts = await fb(`/me/adaccounts`, "GET", { fields: "id,account_id,name", limit: 1 });
      
      if (!accounts.data || accounts.data.length === 0) {
        await sendWhatsAppMessage(from, 
          "⚠️ No ad accounts found.\n\n" +
          "You may need to:\n" +
          "1. Create an ad account\n" +
          "2. Grant 'ads_read' permission\n" +
          "3. Link your ad account to your app"
        );
        return;
      }
      
      const account = accounts.data[0];
      await sendWhatsAppMessage(from, 
        `✅ Ad Account Access OK!\n\n` +
        `Account: ${account.name || account.account_id}\n` +
        `ID: ${account.id}\n\n` +
        `You can now use:\n` +
        `/stats\n` +
        `/campaigns\n` +
        `/best`
      );
    } catch (err) {
      await sendWhatsAppMessage(from, 
        `❌ Ad Account Access Failed:\n\n${err.message}\n\n` +
        `You may need 'ads_read' permission.\n` +
        `Check: https://developers.facebook.com/apps/`
      );
    }
  } catch (err) {
    await sendWhatsAppMessage(from, `❌ Test failed: ${err.message}`);
  }
}

async function handleTestProducts(from) {
  try {
    await sendWhatsAppMessage(from, `🔍 Testing WooCommerce connection...\n\nAPI: ${WC_API_URL}`);
    
    try {
      const products = await wooFetch("GET", "/products?per_page=1");
      
      let msg = "✅ WooCommerce Connection Successful!\n\n";
      msg += `• API URL: ${WC_API_URL}\n`;
      msg += `• Products Found: ${products ? products.length : 0}\n`;
      msg += `• Source: WooCommerce REST API\n\n`;
      
      if (products && products.length > 0) {
        const normalized = normalizeProduct(products[0]);
        msg += `Sample product:\n`;
        msg += `• ${normalized.name}\n`;
        msg += `• Price: $${normalized.price}\n`;
        msg += `• SKU: ${normalized.sku || "N/A"}\n`;
        msg += `• Stock: ${normalized.stock_status}\n`;
      } else {
        msg += `⚠️ No products found. Check your WooCommerce store.`;
      }
      
      await sendWhatsAppMessage(from, msg);
    } catch (fetchErr) {
      let msg = "❌ WooCommerce Connection Failed\n\n";
      msg += `• API URL: ${WC_API_URL}\n`;
      msg += `• Error: ${fetchErr.message}\n\n`;
      msg += `Troubleshooting:\n`;
      msg += `1. Check WC_API_URL, WC_API_KEY, WC_API_SECRET\n`;
      msg += `2. Verify WooCommerce REST API is enabled\n`;
      msg += `3. Check API key permissions\n`;
      msg += `4. Test URL: ${WC_API_URL}?consumer_key=XXX&consumer_secret=XXX`;
      
      await sendWhatsAppMessage(from, msg);
    }
  } catch (err) {
    await sendWhatsAppMessage(from, `❌ Test failed: ${err.message}`);
  }
}

async function handleStats(from, period) {
  try {
    if (!TOKEN) {
      await sendWhatsAppMessage(from, 
        "❌ META_TOKEN not configured.\n\n" +
        "Use /test api to diagnose.\n" +
        "Set META_TOKEN in .env file."
      );
      return;
    }
    
    const accounts = await fb(`/me/adaccounts`, "GET", { fields: "id,account_id,name" });
    
    if (!accounts.data || accounts.data.length === 0) {
      await sendWhatsAppMessage(from, 
        "📊 No ad accounts found.\n\n" +
        "Use /test api to check access.\n" +
        "You may need to create an ad account or grant permissions."
      );
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
    if (!TOKEN) {
      await sendWhatsAppMessage(from, 
        "❌ META_TOKEN not configured.\n\n" +
        "Use /test api to diagnose.\n" +
        "Set META_TOKEN in .env file."
      );
      return;
    }
    
    const accounts = await fb(`/me/adaccounts`, "GET", { fields: "id" });
    
    if (!accounts.data || accounts.data.length === 0) {
      await sendWhatsAppMessage(from, 
        "📊 No ad accounts found.\n\n" +
        "Use /test api to check access.\n" +
        "You may need to create an ad account or grant permissions."
      );
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
    if (!TOKEN) {
      await sendWhatsAppMessage(from, 
        "❌ META_TOKEN not configured.\n\n" +
        "Use /test api to diagnose.\n" +
        "Set META_TOKEN in .env file."
      );
      return;
    }
    
    const accounts = await fb(`/me/adaccounts`, "GET", { fields: "id" });
    
    if (!accounts.data || accounts.data.length === 0) {
      await sendWhatsAppMessage(from, 
        "📊 No ad accounts found.\n\n" +
        "Use /test api to check access.\n" +
        "You may need to create an ad account or grant permissions."
      );
      return;
    }
    
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
    const productData = await findProductByName(product);
    const systemPrompt = buildSystemPrompt(companyContext);
    
    let productContext = "";
    if (productData) {
      productContext = `\n\nProduct Details:\n- Name: ${productData.name || product}\n- Description: ${productData.description || productData.short_description || "N/A"}\n- Price: ${productData.price ? `$${productData.price}` : "N/A"}`;
    }
    
    const completion = await openaiWithFallback({
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
    const productData = await findProductByName(product);
    const systemPrompt = buildSystemPrompt(companyContext);
    
    let productContext = "";
    if (productData) {
      productContext = `\n\nProduct Details:\n- Name: ${productData.name || product}\n- Description: ${productData.description || productData.short_description || "N/A"}\n- Price: ${productData.price ? `$${productData.price}` : "N/A"}`;
    }
    
    const completion = await openaiWithFallback({
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
    const productData = await findProductByName(product);
    const systemPrompt = buildSystemPrompt(companyContext);
    
    let productContext = "";
    if (productData) {
      productContext = `\n\nProduct Details:\n- Name: ${productData.name || product}\n- Description: ${productData.description || productData.short_description || "N/A"}\n- Price: ${productData.price ? `$${productData.price}` : "N/A"}`;
    }
    
    const completion = await openaiWithFallback({
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
    const productData = await findProductByName(product);
    
    // Build product context
    let productContext = "";
    if (productData) {
      productContext = `\n\nProduct Details:\n- Name: ${productData.name || product}\n- Description: ${productData.description || productData.short_description || "N/A"}\n- Price: ${productData.price ? `$${productData.price}` : "N/A"}`;
    }
    
    // Generate copy and audience
    const copyPrompt = buildSystemPrompt(companyContext) + " Generate ad copy.";
    const audiencePrompt = buildSystemPrompt(companyContext) + " Generate audience targeting.";
    
    const [copyRes, audienceRes] = await Promise.all([
      openaiWithFallback({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: copyPrompt },
          { role: "user", content: `Create ad copy for: ${product}${productContext}` }
        ],
        response_format: { type: "json_object" }
      }),
      openaiWithFallback({
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
    // Use cache for faster response
    const products = await getProductsCache();
    
    if (!products || products.length === 0) {
      await sendWhatsAppMessage(from, "📦 No products found in WooCommerce.\n\nMake sure:\n• WooCommerce is set up\n• Products exist in your store\n• API credentials are correct");
      return;
    }
    
    // Normalize and store in context for "number X" references
    const normalizedList = products.slice(0, 10).map(p => normalizeProduct(p));
    const ctx = getConversationContext(from);
    ctx.lastProductList = normalizedList;
    
    let msg = `📦 Products (${products.length}):\n\n`;
    normalizedList.forEach((p, i) => {
      const name = p.name || "Unnamed";
      const price = p.price ? `$${p.price}` : "N/A";
      const desc = (p.description || p.short_description || "").substring(0, 50);
      msg += `${i + 1}. ${name}\n💰 ${price}${desc ? `\n${desc}...` : ""}\n\n`;
    });
    
    if (products.length > 10) {
      msg += `...and ${products.length - 10} more\n\nUse /product <name> for details\nOr say "change product number X name to Y" to edit`;
    } else {
      msg += `💡 Tip: Say "change product number X name to Y" to edit`;
    }
    
    await sendWhatsAppMessage(from, msg);
  } catch (err) {
    await sendWhatsAppMessage(from, `❌ Couldn't fetch products: ${err.message}\n\nTry /test products to check connection`);
  }
}

async function handleProduct(from, params) {
  try {
    // Ensure params is an array
    const productParams = Array.isArray(params) ? params : (params ? [params] : []);
    
    if (!productParams || productParams.length === 0) {
      await sendWhatsAppMessage(from, "📦 Product Commands:\n\n• /product <name> - Get product info\n• /product edit <name> title=\"New Title\" - Edit title\n• /product edit <name> price=99.99 - Edit price\n• /product edit <name> description=\"New desc\" - Edit description\n• /product info <name> - Full details");
      return;
    }
    
    const action = productParams[0]?.toLowerCase();
    
    // Handle edit command
    if (action === "edit" && productParams.length >= 3) {
      if (!isAdmin(from)) {
        await sendWhatsAppMessage(from, "⚠️ Product editing requires admin access.");
        return;
      }
      
      const productName = productParams[1];
      const updates = {};
      
      // Parse update parameters (title="...", price=99.99, description="...")
      for (let i = 2; i < productParams.length; i++) {
        const param = productParams[i];
        if (param.includes("=")) {
          const [key, ...valueParts] = param.split("=");
          const value = valueParts.join("=").replace(/^["']|["']$/g, ""); // Remove quotes
          updates[key.trim()] = value.trim();
        }
      }
      
      if (Object.keys(updates).length === 0) {
        await sendWhatsAppMessage(from, "⚠️ No updates specified.\n\nExample: /product edit shampoo title=\"New Title\" price=29.99");
        return;
      }
      
      // Find product
      const product = await findProductByName(productName);
      if (!product) {
        await sendWhatsAppMessage(from, `❌ Product not found: ${productName}\n\nUse /products to see all products.`);
        return;
      }
      
      // Build WooCommerce payload
      const updateData = {};
      if (updates.title) updateData.name = updates.title;
      if (updates.price) updateData.regular_price = String(updates.price);
      if (updates.description) updateData.description = updates.description;
      if (updates.short_description) updateData.short_description = updates.short_description;
      
      // Use direct axios call with proper WooCommerce API format (same as PUT endpoint)
      const baseUrl = WC_API_URL.replace(/\/products.*$/, "");
      const endpoint = `/products/${product.id}`;
      const fullUrl = `${baseUrl}${endpoint}`;
      
      // Build query params for authentication
      const queryParams = new URLSearchParams();
      queryParams.append("consumer_key", WC_API_KEY || "");
      queryParams.append("consumer_secret", WC_API_SECRET || "");
      
      const urlWithAuth = `${fullUrl}?${queryParams.toString()}`;
      
      try {
        console.log(`[WhatsApp] Updating product ${product.id} with data:`, JSON.stringify(updateData));
        
        const response = await axios.put(urlWithAuth, updateData, {
          headers: {
            "Content-Type": "application/json",
            "Accept": "application/json"
          },
          timeout: 15000
        });
        
        console.log(`[WhatsApp] WooCommerce response status: ${response.status}`);
        
        // Verify success
        if (response.status >= 200 && response.status < 300) {
          // Fetch fresh product to confirm the change
          const freshProduct = await wooFetch("GET", `/products/${product.id}`);
          
          let updateMsg = `✅ Updated product:\n\n`;
          Object.keys(updates).forEach(key => {
            const oldValue = key === "title" ? product.name : (product[key] || "N/A");
            const newValue = updates[key];
            updateMsg += `• ${key}: ${oldValue} → ${newValue}\n`;
          });
          
          if (freshProduct && freshProduct.name) {
            updateMsg += `\n📦 Confirmed: ${freshProduct.name}`;
            if (freshProduct.regular_price) {
              updateMsg += `\n💰 Price: $${freshProduct.regular_price}`;
            }
          }
          
          await sendWhatsAppMessage(from, updateMsg);
        } else {
          await sendWhatsAppMessage(from, `⚠️ Update returned status ${response.status}. Response: ${JSON.stringify(response.data).substring(0, 200)}`);
        }
      } catch (err) {
        console.error("[WhatsApp] Product update error:", {
          status: err.response?.status,
          data: err.response?.data,
          message: err.message,
          url: urlWithAuth.replace(/consumer_key=[^&]+/, "consumer_key=***").replace(/consumer_secret=[^&]+/, "consumer_secret=***")
        });
        
        let errorMsg = "❌ Failed to update product.";
        if (err.response) {
          const wooError = err.response.data;
          const errorText = wooError.message || wooError.error || (typeof wooError === 'string' ? wooError : JSON.stringify(wooError));
          errorMsg = `❌ WooCommerce error (${err.response.status}): ${errorText}`;
          
          // Provide helpful hints
          if (err.response.status === 401) {
            errorMsg += "\n\nCheck WC_API_KEY and WC_API_SECRET permissions.";
          } else if (err.response.status === 404) {
            errorMsg += `\n\nProduct ID ${product.id} not found in WooCommerce.`;
          } else if (err.response.status === 400) {
            errorMsg += "\n\nInvalid data format. Check field names and values.";
          }
        } else if (err.code === "ECONNREFUSED" || err.code === "ETIMEDOUT") {
          errorMsg = `❌ Cannot connect to WooCommerce (${err.code}). Check WC_API_URL.`;
        } else {
          errorMsg = `❌ ${err.message}`;
        }
        
        await sendWhatsAppMessage(from, errorMsg);
      }
      
      return;
    }
    
    // Handle info command or default to showing product info
    const searchName = action === "info" ? productParams.slice(1).join(" ") : productParams.join(" ");
    const product = await findProductByName(searchName, true);
    
    if (!product) {
      // Try to find candidates for better UX
      const candidates = await findProductCandidates(searchName, 3);
      if (candidates.length > 0) {
        let msg = `❌ Product "${searchName}" not found.\n\nDid you mean:\n\n`;
        candidates.forEach((c, i) => {
          msg += `${i + 1}. ${c.name}\n`;
        });
        msg += `\nReply with the number or use /product <exact name>`;
        await sendWhatsAppMessage(from, msg);
      } else {
        await sendWhatsAppMessage(from, `❌ Product not found: ${searchName}\n\nUse /products to see all products.`);
      }
      return;
    }
    
    // Update conversation context
    updateConversationContext(from, product, "view");
    
    const productName = product.name || "Unnamed";
    const price = product.price ? `$${product.price}` : "N/A";
    const salePrice = product.sale_price ? ` (Sale: $${product.sale_price})` : "";
    const description = product.description || product.short_description || "No description";
    const stockStatus = product.stock_status === "instock" ? "✅ In Stock" : "❌ Out of Stock";
    const stockQty = product.stock_quantity !== null ? ` (${product.stock_quantity} available)` : "";
    const categories = product.categories && product.categories.length > 0 
      ? product.categories.map(c => c.name).join(", ") 
      : "None";
    
    let msg = `📦 ${productName}\n\n`;
    msg += `💰 Price: ${price}${salePrice}\n`;
    msg += `📊 Stock: ${stockStatus}${stockQty}\n`;
    msg += `🏷️ Categories: ${categories}\n`;
    msg += `📝 Description:\n${description.substring(0, 400)}${description.length > 400 ? "..." : ""}\n`;
    
    if (product.permalink) {
      msg += `\n🔗 ${product.permalink}`;
    }
    
    msg += `\n\n💡 To edit: /product edit ${productName} title="..." price=...`;
    
    await sendWhatsAppMessage(from, msg);
  } catch (err) {
    await sendWhatsAppMessage(from, `❌ Couldn't get product info: ${err.message}\n\nTry /products to list all products.`);
  }
}

async function handleSyncProducts(from) {
  try {
    await sendWhatsAppMessage(from, "🔄 Fetching products from WooCommerce...");
    
    try {
      const products = await wooFetch("GET", "/products?per_page=100");
      
      if (!products || products.length === 0) {
        await sendWhatsAppMessage(from, 
          `⚠️ No products found in WooCommerce.\n\n` +
          `Check:\n` +
          `• WC_API_URL is correct\n` +
          `• WC_API_KEY and WC_API_SECRET are set\n` +
          `• WooCommerce REST API is enabled`
        );
        return;
      }
      
      await sendWhatsAppMessage(from, `✅ Found ${products.length} products in WooCommerce!`);
      console.log(`[WhatsApp] /sync products executed by ${from}, found ${products.length} products`);
    } catch (fetchErr) {
      let errorMsg = `❌ Failed to fetch products:\n\n${fetchErr.message}\n\n`;
      errorMsg += `Troubleshooting:\n`;
      errorMsg += `1. Check WC_API_URL, WC_API_KEY, WC_API_SECRET env vars\n`;
      errorMsg += `2. Verify WooCommerce REST API is enabled\n`;
      errorMsg += `3. Check API key permissions\n`;
      
      await sendWhatsAppMessage(from, errorMsg);
      throw fetchErr;
    }
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
    `*🎨 IMAGE GENERATION*\n` +
    `/angle <preset> - Set angle (front/45/side/top/macro/lifestyle)\n` +
    `/style <text> - Set style\n` +
    `/image <product> [| style] - Generate square image\n` +
    `/images <product> - Generate pack (square/portrait/story)\n` +
    `/last - Show last generated image\n` +
    `/redo - Regenerate last image\n\n` +
    `*📦 PRODUCTS*\n` +
    `/products - List all products\n` +
    `/product <name> - Get product details\n` +
    `/product edit <name> title="..." - Edit title\n` +
    `/product edit <name> price=99.99 - Edit price\n` +
    `/product edit <name> description="..." - Edit description\n` +
    `/product info <name> - Full product info\n` +
    `/sync products - Refresh from WooCommerce\n\n` +
    `*📋 PROFILE*\n` +
    `/profile show - View profile\n` +
    `/profile update key=value - Update field\n` +
    `/profile set k1=v1 k2=v2 - Bulk update\n` +
    `/profile sync - Reload profile\n\n` +
    `*⚙️ AUTOMATION*\n` +
    `/report daily [HH:mm] - Schedule reports\n` +
    `/alerts on|off - Toggle alerts\n\n` +
    `*🔧 DIAGNOSTICS*\n` +
    `/test api - Check API connection\n` +
    `/test products - Test website access\n\n` +
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

// Initialize workflows after all dependencies are defined
initWorkflows({
  userWorkflows,
  sendWhatsAppMessage,
  wooFetch,
  normalizeProduct,
  findProductByName,
  getSession,
  ANGLE_PRESETS,
  loadCompanyContext,
  fb,
  GRAPH,
  TOKEN
});

// Upload media to WhatsApp (supports both image and video)
async function uploadWhatsAppMedia(mediaBuffer, mimeType = "image/jpeg") {
  if (!WHATSAPP_PHONE_NUMBER_ID || !WHATSAPP_ACCESS_TOKEN) {
    throw new Error("WhatsApp credentials not configured");
  }
  
  const isVideo = mimeType.includes("video");
  const form = new FormData();
  form.append("file", mediaBuffer, {
    filename: isVideo ? "video.mp4" : "image.jpg",
    contentType: mimeType
  });
  form.append("messaging_product", "whatsapp");
  form.append("type", isVideo ? "video" : "image");
  
  try {
    const response = await axios.post(
      `${GRAPH}/${WHATSAPP_PHONE_NUMBER_ID}/media`,
      form,
      {
        headers: {
          ...form.getHeaders(),
          Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: isVideo ? 120000 : 30000 // 2 minutes for video, 30s for image
      }
    );
    
    return response.data.id; // media_id
  } catch (err) {
    console.error("Error uploading media:", err.response?.data || err.message);
    throw new Error(`Failed to upload media: ${err.message}`);
  }
}

// Send WhatsApp image message
async function sendWhatsAppImage(to, mediaId, caption = "") {
  if (!WHATSAPP_PHONE_NUMBER_ID || !WHATSAPP_ACCESS_TOKEN) {
    throw new Error("WhatsApp credentials not configured");
  }
  
  try {
    const response = await axios.post(
      `${GRAPH}/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: to,
        type: "image",
        image: {
          id: mediaId,
          caption: caption.substring(0, 1024) // WhatsApp caption limit
        }
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );
    
    console.log(`WhatsApp image sent to ${to}, media_id: ${mediaId}`);
    return response.data;
  } catch (err) {
    console.error("Error sending WhatsApp image:", err.response?.data || err.message);
    throw err;
  }
}

// Check if image generation is available (Vertex AI)
async function checkImageConfig() {
  // Check if Vertex AI module actually exists before preferring it
  let vertexAvailable = false;
  
  // Check for Vertex AI credentials (supports both file path and individual env vars)
  // Check for non-empty values (not just truthy)
  const hasProject = !!(process.env.GOOGLE_CLOUD_PROJECT && process.env.GOOGLE_CLOUD_PROJECT.trim());
  const hasCredentialsFile = !!(process.env.GOOGLE_APPLICATION_CREDENTIALS && process.env.GOOGLE_APPLICATION_CREDENTIALS.trim());
  const hasPrivateKey = !!(process.env.GOOGLE_PRIVATE_KEY && process.env.GOOGLE_PRIVATE_KEY.trim());
  const hasClientEmail = !!(process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_CLIENT_EMAIL.trim());
  const hasEnvVars = hasPrivateKey && hasClientEmail;
  
  const hasVertexCredentials = hasProject && (hasCredentialsFile || hasEnvVars);
  
  // Debug logging
  console.log("[Image Config] Checking configuration:");
  console.log(`  GOOGLE_CLOUD_PROJECT: ${hasProject ? '✓' : '✗'}`);
  console.log(`  GOOGLE_APPLICATION_CREDENTIALS: ${hasCredentialsFile ? '✓' : '✗'}`);
  console.log(`  GOOGLE_PRIVATE_KEY: ${hasPrivateKey ? '✓' : '✗'}`);
  console.log(`  GOOGLE_CLIENT_EMAIL: ${hasClientEmail ? '✓' : '✗'}`);
  console.log(`  Has credentials: ${hasVertexCredentials ? '✓' : '✗'}`);
  
  if (hasVertexCredentials) {
    try {
      // Check if file exists first - try multiple possible locations
      const possiblePaths = [
        path.join(__dirname, "services", "vertexService.js"),
        path.join(process.cwd(), "services", "vertexService.js"),
        "./services/vertexService.js"
      ];
      
      let foundPath = null;
      for (const checkPath of possiblePaths) {
        if (fs.existsSync(checkPath)) {
          foundPath = checkPath;
          break;
        }
      }
      
      if (foundPath) {
        try {
          // Convert to file:// URL for ES module import
          const importPath = foundPath.startsWith(".") ? foundPath : `file://${foundPath}`;
          await import(importPath);
          vertexAvailable = true;
          console.log(`[Image Config] Vertex AI module found and loaded from: ${foundPath}`);
        } catch (importErr) {
          console.warn(`[Image Config] Vertex AI module exists but failed to import: ${importErr.message}`);
          vertexAvailable = false;
        }
      } else {
        console.warn(`[Image Config] Vertex AI module not found in any of these paths: ${possiblePaths.join(", ")}`);
        console.warn(`[Image Config] Current working directory: ${process.cwd()}`);
        console.warn(`[Image Config] __dirname: ${__dirname}`);
        vertexAvailable = false;
      }
    } catch (importErr) {
      console.warn("[Image Config] Vertex AI module not available:", importErr.message);
      vertexAvailable = false;
    }
  } else {
    console.warn("[Image Config] Missing Vertex AI credentials. Required:");
    if (!hasProject) console.warn("  - GOOGLE_CLOUD_PROJECT");
    if (!hasCredentialsFile && !hasEnvVars) {
      console.warn("  - Either GOOGLE_APPLICATION_CREDENTIALS (file path)");
      console.warn("  - Or both GOOGLE_PRIVATE_KEY + GOOGLE_CLIENT_EMAIL");
    } else if (!hasEnvVars && hasCredentialsFile) {
      console.warn("  - GOOGLE_APPLICATION_CREDENTIALS is set, but file may not exist");
    }
  }
  
  if (vertexAvailable) {
    console.log("[Image Config] ✓ Vertex AI configured and ready");
    return "vertex";
  }
  
  throw new Error("Image engine not configured. Set GOOGLE_CLOUD_PROJECT and either GOOGLE_APPLICATION_CREDENTIALS (file path) or GOOGLE_PRIVATE_KEY + GOOGLE_CLIENT_EMAIL (env vars) for Vertex AI.");
}

// Generate image using Vertex AI Imagen 3
async function generateImageWithEngine(prompt, aspectRatio = "1:1", width = 1024, height = 1024) {
  try {
    const engine = await checkImageConfig();
    
    if (engine === "vertex") {
      // Use Vertex AI Imagen 3
      try {
        let generateImage;
        try {
          // Try multiple possible paths for production environments
          let vertexModule;
          const possiblePaths = [
            "./services/vertexService.js",
            path.join(__dirname, "services", "vertexService.js"),
            path.join(process.cwd(), "services", "vertexService.js"),
            "../services/vertexService.js"
          ];
          
          let importError = null;
          for (const importPath of possiblePaths) {
            try {
              // For absolute paths, convert to file:// URL for ES modules
              const normalizedPath = importPath.startsWith(".") 
                ? importPath 
                : `file://${importPath}`;
              vertexModule = await import(normalizedPath);
              console.log(`[Image Generation] Successfully imported Vertex AI from: ${importPath}`);
              break;
            } catch (err) {
              importError = err;
              continue;
            }
          }
          
          if (!vertexModule) {
            throw importError || new Error("Could not import vertexService from any path");
          }
          
          generateImage = vertexModule.generateImage;
          if (!generateImage) {
            throw new Error("generateImage function not found in vertexService module");
          }
        } catch (importErr) {
          console.error("[Image Generation] Failed to import vertexService:", importErr.message);
          console.error("[Image Generation] Import error details:", {
            message: importErr.message,
            code: importErr.code,
            path: importErr.path || "unknown"
          });
          throw new Error(`Vertex AI service not available: ${importErr.message}`);
        }
        
        // Only execute if import succeeded
        if (!generateImage) {
          throw new Error("Vertex AI service not available");
        }
        
        const result = await generateImage(prompt, aspectRatio);
        
        // Convert PNG to JPEG and optimize for WhatsApp
        const jpegBuffer = await sharp(result.buffer)
          .jpeg({ quality: 87 })
          .toBuffer();
        
        // Check size (WhatsApp limit ~5MB)
        if (jpegBuffer.length > 4.5 * 1024 * 1024) {
          const resized = await sharp(jpegBuffer)
            .resize(1024, 1024, { fit: "inside", withoutEnlargement: true })
            .jpeg({ quality: 85 })
            .toBuffer();
          return resized;
        }
        
        return jpegBuffer;
      } catch (err) {
        console.error("[Vertex AI] Image generation failed:", err.message);
        throw err;
      }
    }
    
    throw new Error("Vertex AI not configured");
  } catch (err) {
    if (err.code === "ECONNREFUSED" || err.code === "ETIMEDOUT" || err.code === "ENOTFOUND") {
      throw {
        status: 502,
        message: "Image engine unreachable",
        details: err.code
      };
    }
    
    if (err.response) {
      throw {
        status: err.response.status,
        message: err.response.data?.error || err.response.data?.message || `HTTP ${err.response.status}`
      };
    }
    
    if (err.message.includes("Image engine not configured") || err.message.includes("No image engine")) {
      throw {
        status: 503,
        message: err.message
      };
    }
    
    throw {
      status: 500,
      message: `Image generation failed: ${err.message}`
    };
  }
}

// Build image prompt
// Prompt cache to reduce API calls
const promptCache = new Map(); // key -> { prompt, timestamp }
const PROMPT_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

// Generate cache key for prompt enhancement
function getPromptCacheKey(product, angle, style, companyContext) {
  const productId = product?.id || product?.name || "unknown";
  const angleKey = angle || "default";
  const styleKey = style || "default";
  const brandKey = companyContext?.name || "default";
  return `${productId}-${angleKey}-${styleKey}-${brandKey}`;
}

// Helper function to call OpenAI with fallback model support
async function openaiWithFallback(config) {
  const { model = "gpt-4o-mini", messages, temperature = 0.8, max_tokens = 600, ...otherOptions } = config;
  
  try {
    // Try primary model first
    const response = await openai.chat.completions.create({
      model: model,
      messages: messages,
      temperature: temperature,
      max_tokens: max_tokens,
      ...otherOptions
    });
    return response;
  } catch (err) {
    // Check if it's a rate limit error - try fallback model
    if (err.message.includes("Rate limit") || err.message.includes("429") || err.status === 429) {
      console.warn(`[OpenAI] Rate limit on ${model}, trying fallback model gpt-3.5-turbo`);
      try {
        const fallbackResponse = await openai.chat.completions.create({
          model: "gpt-3.5-turbo",
          messages: messages,
          temperature: temperature,
          max_tokens: max_tokens,
          ...otherOptions
        });
        console.log(`[OpenAI] Successfully used fallback model gpt-3.5-turbo`);
        return fallbackResponse;
      } catch (fallbackErr) {
        // If fallback also fails, throw the original error
        console.error(`[OpenAI] Fallback model also failed: ${fallbackErr.message}`);
        throw err; // Throw original error
      }
    } else {
      // Re-throw if not a rate limit error
      throw err;
    }
  }
}

// AI Prompt Enhancer - Creates optimized prompts using brand/product data
async function enhanceImagePrompt(userPrompt, product, companyContext, session, angle = null, style = null) {
  try {
    // Check cache first
    const cacheKey = getPromptCacheKey(product, angle || session?.angle, style || session?.style, companyContext);
    const cached = promptCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < PROMPT_CACHE_TTL) {
      console.log(`[Prompt Enhancer] Using cached prompt for ${cacheKey}`);
      return cached.prompt;
    }
    
    // Build context for prompt enhancement
    let contextInfo = "";
    
    // Company/Brand context
    if (companyContext) {
      contextInfo += `BRAND CONTEXT:\n`;
      if (companyContext.name) contextInfo += `- Brand Name: ${companyContext.name}\n`;
      if (companyContext.industry) contextInfo += `- Industry: ${companyContext.industry}\n`;
      if (companyContext.brandValues) contextInfo += `- Brand Values: ${companyContext.brandValues}\n`;
      if (companyContext.targetAudience) contextInfo += `- Target Audience: ${companyContext.targetAudience}\n`;
      if (companyContext.campaignGoals) contextInfo += `- Campaign Goals: ${companyContext.campaignGoals}\n`;
    }
    
    // Product context
    if (product) {
      contextInfo += `\nPRODUCT CONTEXT:\n`;
      if (product.name) contextInfo += `- Product Name: ${product.name}\n`;
      if (product.description) {
        const desc = product.description.substring(0, 300);
        contextInfo += `- Description: ${desc}\n`;
      }
      if (product.short_description) {
        const shortDesc = product.short_description.substring(0, 200);
        contextInfo += `- Key Points: ${shortDesc}\n`;
      }
      if (product.categories && product.categories.length > 0) {
        const cats = product.categories.map(c => c.name || c).join(", ");
        contextInfo += `- Categories: ${cats}\n`;
      }
    }
    
    // Style/Angle context
    if (angle || session?.angle) {
      const selectedAngle = angle || session.angle;
      contextInfo += `\nPHOTOGRAPHY STYLE:\n`;
      contextInfo += `- Angle: ${ANGLE_PRESETS[selectedAngle] || selectedAngle}\n`;
    }
    
    if (style || session?.style) {
      const selectedStyle = style || session.style;
      contextInfo += `- Style: ${selectedStyle}\n`;
    }
    
    // Build enhancement prompt
    const enhancementPrompt = `You are an expert product photography prompt engineer specializing in e-commerce and advertising imagery.

Your task: Transform a basic user request into a highly detailed, professional product photography prompt that will generate stunning, brand-aligned images.

${contextInfo}

USER REQUEST: "${userPrompt}"

Create an enhanced, detailed prompt that:
1. Incorporates the brand's values and target audience preferences
2. Highlights the product's key features and benefits
3. Uses professional photography terminology (lighting, composition, depth of field, etc.)
4. Includes specific visual details (surfaces, backgrounds, props if appropriate)
5. Ensures the image aligns with the brand's aesthetic and campaign goals
6. Is optimized for e-commerce and social media advertising
7. Avoids text overlays or price tags (product photography only)
8. Creates a premium, professional look

Return ONLY the enhanced prompt text (no explanations, no markdown, just the prompt). Keep it concise but detailed (2-4 sentences max).`;

    // Try primary model first, with fallback
    let response;
    try {
      response = await openaiWithFallback({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: "You are an expert product photography prompt engineer. Create detailed, professional prompts optimized for AI image generation."
          },
          {
            role: "user",
            content: enhancementPrompt
          }
        ],
        temperature: 0.8,
        max_tokens: 300
      });
    } catch (err) {
      // If both models fail, use template builder
      console.warn("[Prompt Enhancer] Both models failed, using template builder");
      return buildEnhancedPromptFallback(userPrompt, product, companyContext, session, angle, style);
    }
    
    const enhancedPrompt = response.choices[0].message.content.trim();
    console.log(`[Prompt Enhancer] Enhanced: "${userPrompt}" → "${enhancedPrompt}"`);
    
    // Cache the result
    promptCache.set(cacheKey, { prompt: enhancedPrompt, timestamp: Date.now() });
    
    return enhancedPrompt;
    
  } catch (err) {
    console.error("[Prompt Enhancer] Error:", err.message);
    
    // Final fallback to template builder
    return buildEnhancedPromptFallback(userPrompt, product, companyContext, session, angle, style);
  }
}

// Fallback prompt builder (no AI, uses templates)
function buildEnhancedPromptFallback(userPrompt, product, companyContext, session, angle = null, style = null) {
  const selectedAngle = angle || session?.angle || "front";
  const selectedStyle = style || session?.style || "clean studio, premium cosmetics look";
  const brandName = companyContext?.name || "MAROM";
  const productName = product?.name || "product";
  
  let prompt = `Professional product photography of ${brandName} ${productName}`;
  
  // Add angle description
  if (ANGLE_PRESETS[selectedAngle]) {
    prompt += `, ${ANGLE_PRESETS[selectedAngle]}`;
  }
  
  // Add style
  prompt += `, ${selectedStyle}`;
  
  // Add product context if available
  if (product?.description) {
    const desc = product.description.substring(0, 100).replace(/<[^>]*>/g, '');
    prompt += `. Product features: ${desc}`;
  }
  
  // Add brand context
  if (companyContext?.brandValues) {
    prompt += `. Brand aesthetic: ${companyContext.brandValues.substring(0, 100)}`;
  }
  
  // Add quality keywords
  prompt += `. Premium e-commerce photography, high quality, sharp focus, professional lighting, clean background, no text, no watermarks`;
  
  return prompt;
}

// Build base image prompt (simple version)
function buildImagePrompt(product, session, companyContext, styleOverride = null) {
  const style = styleOverride || session.style;
  const angleDesc = ANGLE_PRESETS[session.angle] || ANGLE_PRESETS["front"];
  
  let prompt = `${companyContext.name || "MAROM"} ${product.name || "product"}, `;
  prompt += `${angleDesc}, `;
  prompt += `${style}, `;
  
  if (product.description) {
    prompt += `${product.description.substring(0, 200)}, `;
  }
  
  prompt += `professional product photography, high quality, sharp focus, `;
  prompt += `no text, no price tags, no watermarks, clean background`;
  
  return prompt;
}

// Build enhanced image prompt using AI (recommended)
async function buildEnhancedImagePrompt(product, session, companyContext, styleOverride = null, userRequest = null) {
  // Build base prompt first
  const basePrompt = buildImagePrompt(product, session, companyContext, styleOverride);
  
  // If user provided a specific request, use that; otherwise use base prompt
  const userPrompt = userRequest || basePrompt;
  
  // Enhance with AI using brand/product data
  const enhancedPrompt = await enhanceImagePrompt(
    userPrompt,
    product,
    companyContext,
    session,
    session.angle,
    styleOverride || session.style
  );
  
  return enhancedPrompt;
}

// Command handlers for image generation
async function handleAngle(from, text) {
  const session = getSession(from);
  const matchedAngle = matchAngle(text);
  
  if (matchedAngle) {
    session.angle = matchedAngle;
    await sendWhatsAppMessage(from, `📐 Angle set to: ${matchedAngle}`);
  } else {
    await sendWhatsAppMessage(from, 
      `⚠️ Unknown angle. Available: front, 45, side, top, macro, lifestyle\n\n` +
      `Or say: "make it flatlay", "angle 45", "side view", etc.`
    );
  }
}

async function handleStyle(from, text) {
  if (!text) {
    await sendWhatsAppMessage(from, "⚠️ Usage: /style <description>\n\nExample: /style warm wood table, soft daylight");
    return;
  }
  
  const session = getSession(from);
  session.style = text;
  await sendWhatsAppMessage(from, `🎨 Style set to: ${text}`);
}

async function handleImage(from, params) {
  try {
    if (params.length === 0) {
      await sendWhatsAppMessage(from, "⚠️ Usage: /image <product> [| style]\n\nExample: /image shampoo | warm lighting");
      return;
    }
    
    const input = params.join(" ");
    const parts = input.split("|");
    const productQuery = parts[0].trim();
    const styleOverride = parts[1] ? parts[1].trim() : null;
    
    // Find product
    const product = await findProductByName(productQuery);
    if (!product) {
      await sendWhatsAppMessage(from, 
        `⚠️ Product not found: ${productQuery}\n\n` +
        `Use /products to see all products.`
      );
      return;
    }
    
    await sendWhatsAppMessage(from, "🎨 Creating optimized prompt...");
    
    const session = getSession(from);
    const companyContext = loadCompanyContext();
    
    // Build enhanced prompt using AI with brand/product data
    let prompt;
    try {
      prompt = await buildEnhancedImagePrompt(product, session, companyContext, styleOverride);
    } catch (err) {
      console.error("[Image] Error building prompt:", err.message);
      // Use fallback prompt if AI fails
      prompt = buildEnhancedPromptFallback(
        `create image for ${product.name}`,
        product,
        companyContext,
        session,
        session.angle,
        styleOverride || session.style
      );
    }
    
    await sendWhatsAppMessage(from, "✨ Generating image with enhanced prompt...");
    
    // Generate image using Vertex AI
    let imageBuffer;
    try {
      imageBuffer = await generateImageWithEngine(prompt, "1:1", 1024, 1024);
    } catch (err) {
      console.error("[Image] Error generating image:", err.message || err);
      console.error("[Image] Error details:", JSON.stringify(err, null, 2));
      
      // Check if error has status/message structure
      const errorMessage = err.message || (typeof err === 'string' ? err : JSON.stringify(err));
      const errorStatus = err.status;
      
      throw err; // Re-throw all errors
    }
    
    // Upload to WhatsApp
    const mediaId = await uploadWhatsAppMedia(imageBuffer);
    
    // Send image
    const productName = product.name || productQuery;
    const caption = `${productName} • angle: ${session.angle}`;
    await sendWhatsAppImage(from, mediaId, caption);
    
    // Save to history
    addToHistory(from, mediaId, caption, productName, session.angle, styleOverride || session.style);
    
    console.log(`[Image] Generated for ${from}: ${productName}, angle: ${session.angle}, media_id: ${mediaId}`);
    
  } catch (err) {
    console.error("[Image] Error:", err);
    
    let errorMsg = "⚠️ Image generation failed.";
    if (err.status === 503) {
      errorMsg = "⚠️ Image engine not configured. Set GOOGLE_CLOUD_PROJECT and GOOGLE_APPLICATION_CREDENTIALS for Vertex AI.";
    } else if (err.status === 502) {
      errorMsg = `⚠️ Image engine unreachable (${err.details || "connection error"}).\n\nCheck your Vertex AI configuration.`;
    } else if (err.message) {
      errorMsg = `⚠️ ${err.message}`;
    }
    
    await sendWhatsAppMessage(from, errorMsg);
  }
}

async function handleImages(from, params) {
  try {
    if (params.length === 0) {
      await sendWhatsAppMessage(from, "⚠️ Usage: /images <product>");
      return;
    }
    
    const productQuery = params.join(" ");
    const product = await findProductByName(productQuery);
    if (!product) {
      await sendWhatsAppMessage(from, 
        `⚠️ Product not found: ${productQuery}\n\n` +
        `Use /products to see all products.`
      );
      return;
    }
    
    await sendWhatsAppMessage(from, "🎞️ Creating optimized prompt for image pack...");
    
    const session = getSession(from);
    const companyContext = loadCompanyContext();
    
    // Build enhanced prompt using AI with brand/product data
    const prompt = await buildEnhancedImagePrompt(product, session, companyContext);
    
    await sendWhatsAppMessage(from, "✨ Generating image pack (3 sizes) with enhanced prompt...");
    
    // Generate base image at 1024x1024 using Vertex AI
    const baseImage = await generateImageWithEngine(prompt, "1:1", 1024, 1024);
    
    // Resize to different aspects
    const square = baseImage; // Already 1024x1024
    const portrait = await sharp(baseImage).resize(1080, 1350, { fit: "cover" }).jpeg({ quality: 87 }).toBuffer();
    const story = await sharp(baseImage).resize(1080, 1920, { fit: "cover" }).jpeg({ quality: 87 }).toBuffer();
    
    const productName = product.name || productQuery;
    
    // Upload and send square
    const squareMediaId = await uploadWhatsAppMedia(square);
    await sendWhatsAppImage(from, squareMediaId, `${productName} • Square (1:1) • angle: ${session.angle}`);
    addToHistory(from, squareMediaId, `${productName} • Square`, productName, session.angle, session.style);
    
    // Small delay between uploads
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Upload and send portrait
    const portraitMediaId = await uploadWhatsAppMedia(portrait);
    await sendWhatsAppImage(from, portraitMediaId, `${productName} • Portrait (4:5) • angle: ${session.angle}`);
    
    // Small delay
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Upload and send story
    const storyMediaId = await uploadWhatsAppMedia(story);
    await sendWhatsAppImage(from, storyMediaId, `${productName} • Story (9:16) • angle: ${session.angle}`);
    
    console.log(`[Images] Generated pack for ${from}: ${productName}, media_ids: ${squareMediaId}, ${portraitMediaId}, ${storyMediaId}`);
    
  } catch (err) {
    console.error("[Images] Error:", err);
    
    let errorMsg = "⚠️ Image generation failed.";
    if (err.status === 503) {
      errorMsg = "⚠️ Image engine not configured. Set GOOGLE_CLOUD_PROJECT and GOOGLE_APPLICATION_CREDENTIALS for Vertex AI.";
    } else if (err.status === 502) {
      errorMsg = `⚠️ Image engine unreachable (${err.details || "connection error"}).\n\nCheck your Vertex AI configuration.`;
    } else if (err.message) {
      errorMsg = `⚠️ ${err.message}`;
    }
    
    await sendWhatsAppMessage(from, errorMsg);
  }
}

async function handleLast(from) {
  const last = getLastCreative(from);
  if (!last) {
    await sendWhatsAppMessage(from, "⚠️ No recent creative found.\n\nUse /image <product> to generate one.");
    return;
  }
  
  try {
    await sendWhatsAppImage(from, last.mediaId, last.caption);
  } catch (err) {
    await sendWhatsAppMessage(from, `⚠️ Could not resend image. ${err.message}`);
  }
}

async function handleRedo(from) {
  const last = getLastCreative(from);
  if (!last) {
    await sendWhatsAppMessage(from, "⚠️ No recent creative found.\n\nUse /image <product> to generate one.");
    return;
  }
  
  try {
    await sendWhatsAppMessage(from, "🔄 Creating optimized prompt for regeneration...");
    
    const product = await findProductByName(last.product);
    if (!product) {
      await sendWhatsAppMessage(from, `⚠️ Product "${last.product}" not found. Use /image <product> to generate.`);
      return;
    }
    
    const session = getSession(from);
    // Restore angle/style from last generation
    session.angle = last.angle;
    session.style = last.style;
    
    const companyContext = loadCompanyContext();
    
    // Build enhanced prompt using AI with brand/product data
    const prompt = await buildEnhancedImagePrompt(product, session, companyContext);
    
    await sendWhatsAppMessage(from, "✨ Regenerating with enhanced prompt...");
    
    // Generate new image using Vertex AI
    const imageBuffer = await generateImageWithEngine(prompt, "1:1", 1024, 1024);
    const mediaId = await uploadWhatsAppMedia(imageBuffer);
    
    await sendWhatsAppImage(from, mediaId, last.caption);
    addToHistory(from, mediaId, last.caption, last.product, last.angle, last.style);
    
    console.log(`[Redo] Regenerated for ${from}: ${last.product}, media_id: ${mediaId}`);
    
  } catch (err) {
    console.error("[Redo] Error:", err);
    
    let errorMsg = "⚠️ Regeneration failed.";
    if (err.status === 503) {
      errorMsg = "⚠️ Image engine not configured. Set GOOGLE_CLOUD_PROJECT and GOOGLE_APPLICATION_CREDENTIALS for Vertex AI.";
    } else if (err.status === 502) {
      errorMsg = `⚠️ Image engine unreachable (${err.details || "connection error"}).\n\nCheck your Vertex AI configuration.`;
    } else if (err.message) {
      errorMsg = `⚠️ ${err.message}`;
    }
    
    await sendWhatsAppMessage(from, errorMsg);
  }
}

// 1) List ad accounts
app.get("/api/adaccounts", async (_,res) => {
  try { res.json(await fb(`/me/adaccounts`, "GET", { fields: "id,account_id,name,currency,status" })); }
  catch(e){ res.status(500).json(e.response?.data || { error:String(e) }); }
});

// Get campaigns for a specific ad account
app.get("/api/adaccounts/:actId/campaigns", async (req, res) => {
  try {
    const accountId = req.params.actId;
    const campaigns = await fb(`/${accountId}/campaigns`, "GET", {
      fields: "id,name,status,objective,created_time,updated_time",
      limit: 100
    });
    res.json({
      success: true,
      campaigns: campaigns.data || [],
      count: campaigns.data ? campaigns.data.length : 0
    });
  } catch (e) {
    res.status(500).json(e.response?.data || { error: String(e) });
  }
});

// Get account details with campaigns
app.get("/api/adaccounts/:actId/details", async (req, res) => {
  try {
    const accountId = req.params.actId;
    
    if (!accountId) {
      return res.status(400).json({ success: false, error: "Account ID is required" });
    }
    
    // Get account info
    let account = null;
    try {
      account = await fb(`/${accountId}`, "GET", {
        fields: "id,account_id,name,currency,status,timezone_name"
      });
    } catch (accountErr) {
      console.error(`[Account Details] Error fetching account ${accountId}:`, accountErr.message);
      // If account fetch fails, try to get basic info from adaccounts list
      try {
        const accounts = await fb(`/me/adaccounts`, "GET", { fields: "id,account_id,name,currency,status" });
        const foundAccount = accounts.data?.find(a => (a.id || a.account_id) === accountId);
        if (foundAccount) {
          account = foundAccount;
        } else {
          throw accountErr; // Re-throw if not found
        }
      } catch (fallbackErr) {
        return res.status(404).json({ 
          success: false, 
          error: `Account not found: ${accountId}`,
          details: accountErr.message || fallbackErr.message
        });
      }
    }
    
    // Get campaigns
    let campaigns = [];
    try {
      const campaignsResponse = await fb(`/${accountId}/campaigns`, "GET", {
        fields: "id,name,status,objective,created_time,updated_time",
        limit: 100
      });
      campaigns = campaignsResponse.data || [];
    } catch (campaignErr) {
      console.error(`[Campaigns] Error fetching campaigns for ${accountId}:`, campaignErr.message);
      // Don't fail the whole request if campaigns can't be fetched
    }
    
    // Get insights if available
    let insights = null;
    try {
      const insightsResponse = await fb(`/${accountId}/insights`, "GET", {
        date_preset: "last_7d",
        fields: "spend,impressions,clicks,ctr,cpc,cpm"
      });
      insights = insightsResponse.data && insightsResponse.data[0] ? insightsResponse.data[0] : null;
    } catch (insightsErr) {
      console.error(`[Insights] Error fetching insights for ${accountId}:`, insightsErr.message);
      // Don't fail the whole request if insights can't be fetched
    }
    
    res.json({
      success: true,
      account: account,
      campaigns: campaigns,
      campaignCount: campaigns.length,
      activeCampaigns: campaigns.filter(c => c.status === "ACTIVE").length,
      pausedCampaigns: campaigns.filter(c => c.status === "PAUSED").length,
      insights: insights
    });
  } catch (e) {
    console.error(`[Account Details] Error for account ${req.params.actId}:`, e);
    const status = e.response?.status || 500;
    const errorData = e.response?.data || {};
    const errorMessage = errorData.error?.message || errorData.error || e.message || String(e);
    
    res.status(status).json({ 
      success: false,
      error: errorMessage,
      details: errorData.error?.error_subcode || errorData.error_subcode || null
    });
  }
});

// 2) Insights (last 7d)
app.get("/api/adaccounts/:actId/insights", async (req,res) => {
  try { res.json(await fb(`/${req.params.actId}/insights`, "GET", { date_preset:"last_7d", fields:"spend,impressions,clicks,ctr,cpc,cpm" })); }
  catch(e){ res.status(500).json(e.response?.data || { error:String(e) }); }
});

// Scrape website endpoint for company profile
app.post("/api/company/scrape-website", async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) {
      return res.status(400).json({ error: "URL is required" });
    }
    
    const websiteData = await scrapeWebsite(url);
    res.json({ success: true, data: websiteData });
  } catch (err) {
    console.error("[Website Scraping] Error:", err);
    res.status(500).json({ error: err.message || "Failed to scrape website" });
  }
});

// Get Meta ad image specifications
app.get("/api/meta/ad-image-specs", async (req, res) => {
  try {
    const { objective, format, accountId } = req.query;
    
    // Try to fetch real-time specs from Meta API first
    let metaSpecs = null;
    if (accountId) {
      try {
        // Try to get ad account's available placements and their specs
        // Meta doesn't have a direct specs endpoint, but we can infer from available placements
        const account = await fb(`/${accountId}`, "GET", {
          fields: "id,account_id,name,currency"
        });
        
        // Try to get creative specs by attempting a validation call
        // This will give us error messages that include requirements
        try {
          const testCreative = {
            name: "test_specs_check",
            object_story_spec: {
              page_id: account.id, // This will fail but give us validation errors
              link_data: {
                image_url: "https://example.com/test.jpg"
              }
            }
          };
          
          // This will fail but the error might contain spec info
          await fb(`/${accountId}/adcreatives`, "POST", testCreative);
        } catch (validationError) {
          // Extract any spec info from error if available
          const errorMsg = validationError.response?.data?.error?.message || "";
          if (errorMsg.includes("dimension") || errorMsg.includes("size") || errorMsg.includes("ratio")) {
            console.log("[Meta Specs] Validation error hints:", errorMsg);
          }
        }
      } catch (apiErr) {
        console.log("[Meta Specs] Could not fetch from Meta API, using documented specs:", apiErr.message);
      }
    }
    
    // Standard Meta ad image specifications (from Meta's official documentation)
    // These are the current requirements as of 2024 - updated regularly
    // Meta's official specs: https://www.facebook.com/business/help/120325381656392
    const imageSpecs = {
      single_image: {
        name: "Single Image",
        description: "A single image ad displayed in Facebook and Instagram feeds",
        sizes: [
          { 
            name: "Square (Recommended)", 
            width: 1080, 
            height: 1080, 
            ratio: "1:1", 
            minWidth: 600, 
            minHeight: 600,
            placement: "All placements",
            note: "Best performance across mobile and desktop"
          },
          { 
            name: "Landscape", 
            width: 1200, 
            height: 628, 
            ratio: "1.91:1", 
            minWidth: 600, 
            minHeight: 315,
            placement: "Desktop feed",
            note: "Not optimized for mobile feed"
          },
          { 
            name: "Portrait", 
            width: 1080, 
            height: 1350, 
            ratio: "4:5", 
            minWidth: 600, 
            minHeight: 750,
            placement: "Instagram feed",
            note: "Best for Instagram, works on Facebook"
          }
        ],
        formats: ["JPG", "PNG"],
        maxSize: "30MB",
        minCount: 1,
        maxCount: 1,
        requirements: [
          "Image must be at least 600px wide",
          "Recommended: 1080px × 1080px for best quality",
          "File size must not exceed 30MB"
        ],
        tips: [
          "Use square format for maximum reach across all placements",
          "Keep text overlay to less than 20% of image area",
          "Use high-quality images (at least 1080px) for best results"
        ]
      },
      feed: {
        name: "Feed (Facebook & Instagram)",
        sizes: [
          { name: "Square", width: 1080, height: 1080, ratio: "1:1", minWidth: 600, minHeight: 600 },
          { name: "Landscape", width: 1200, height: 628, ratio: "1.91:1", minWidth: 600, minHeight: 315 },
          { name: "Portrait", width: 1080, height: 1350, ratio: "4:5", minWidth: 600, minHeight: 750 }
        ],
        formats: ["JPG", "PNG"],
        maxSize: "30MB"
      },
      stories: {
        name: "Stories (Facebook & Instagram)",
        sizes: [
          { name: "Stories", width: 1080, height: 1920, ratio: "9:16", minWidth: 500, minHeight: 889 }
        ],
        formats: ["JPG", "PNG"],
        maxSize: "30MB"
      },
      reels: {
        name: "Reels",
        sizes: [
          { name: "Reels", width: 1080, height: 1920, ratio: "9:16", minWidth: 500, minHeight: 889 }
        ],
        formats: ["JPG", "PNG", "MP4", "MOV"],
        maxSize: "4GB"
      },
      carousel: {
        name: "Carousel",
        description: "Multi-image carousel ads that users can swipe through",
        sizes: [
          { 
            name: "Square (Recommended)", 
            width: 1080, 
            height: 1080, 
            ratio: "1:1", 
            minWidth: 600, 
            minHeight: 600,
            placement: "All placements",
            note: "Best for mobile and desktop feed"
          },
          { 
            name: "Landscape", 
            width: 1200, 
            height: 628, 
            ratio: "1.91:1", 
            minWidth: 600, 
            minHeight: 315,
            placement: "Desktop feed only",
            note: "Not available for mobile feed"
          }
        ],
        formats: ["JPG", "PNG"],
        maxSize: "30MB per image",
        minCount: 2,
        maxCount: 10,
        requirements: [
          "All images must have the same aspect ratio",
          "All images must be the same size",
          "Minimum 2 images, maximum 10 images",
          "Each image can have its own link and headline"
        ],
        tips: [
          "Use square format (1:1) for best performance across all placements",
          "Keep images consistent in style and color",
          "First image is most important - make it eye-catching"
        ]
      },
      video: {
        name: "Video",
        description: "Video ads for Facebook and Instagram feeds",
        sizes: [
          { 
            name: "Square Video (Recommended)", 
            width: 1080, 
            height: 1080, 
            ratio: "1:1", 
            minWidth: 600, 
            minHeight: 600,
            placement: "All placements",
            note: "Best for mobile and desktop"
          },
          { 
            name: "Landscape Video", 
            width: 1920, 
            height: 1080, 
            ratio: "16:9", 
            minWidth: 600, 
            minHeight: 315,
            placement: "Desktop feed",
            note: "Standard widescreen format"
          },
          { 
            name: "Portrait Video", 
            width: 1080, 
            height: 1920, 
            ratio: "9:16", 
            minWidth: 500, 
            minHeight: 889,
            placement: "Mobile feed, Stories",
            note: "Optimized for mobile viewing"
          }
        ],
        formats: ["MP4", "MOV"],
        maxSize: "4GB",
        minCount: 1,
        maxCount: 1,
        duration: { min: 1, max: 240, recommended: 15 },
        requirements: [
          "Video must be between 1-240 seconds long",
          "Recommended duration: 15 seconds for best engagement",
          "File size must not exceed 4GB",
          "Video codec: H.264 recommended"
        ],
        tips: [
          "First 3 seconds are crucial - capture attention immediately",
          "Add captions for better engagement (85% watch without sound)",
          "Keep videos under 15 seconds for highest completion rates"
        ]
      },
      stories: {
        name: "Stories",
        description: "Full-screen vertical ads for Facebook and Instagram Stories",
        sizes: [
          { 
            name: "Stories", 
            width: 1080, 
            height: 1920, 
            ratio: "9:16", 
            minWidth: 500, 
            minHeight: 889,
            placement: "Stories only",
            note: "Full-screen vertical format"
          }
        ],
        formats: ["JPG", "PNG", "MP4", "MOV"],
        maxSize: "30MB (images) / 4GB (videos)",
        minCount: 1,
        maxCount: 1,
        requirements: [
          "Must be vertical format (9:16 aspect ratio)",
          "Minimum size: 500 × 889px",
          "Recommended: 1080 × 1920px for best quality",
          "Images: Max 30MB, Videos: Max 4GB"
        ],
        tips: [
          "Stories are viewed on mobile - design for vertical viewing",
          "Keep important content in center (top and bottom may be cropped)",
          "Stories disappear after 24 hours - create urgency"
        ]
      },
      reels: {
        name: "Reels",
        description: "Short-form video ads for Instagram Reels",
        sizes: [
          { 
            name: "Reels", 
            width: 1080, 
            height: 1920, 
            ratio: "9:16", 
            minWidth: 500, 
            minHeight: 889,
            placement: "Instagram Reels",
            note: "Full-screen vertical video"
          }
        ],
        formats: ["MP4", "MOV"],
        maxSize: "4GB",
        minCount: 1,
        maxCount: 1,
        duration: { min: 15, max: 90, recommended: 30 },
        requirements: [
          "Video must be between 15-90 seconds",
          "Recommended duration: 30 seconds",
          "Must be vertical format (9:16)",
          "File size must not exceed 4GB"
        ],
        tips: [
          "Reels perform best at 30 seconds",
          "Use trending audio/music for better reach",
          "Start with a hook in first 3 seconds",
          "Add text overlays for better engagement"
        ]
      }
    };
    
    // If format is specified, return that format's specs with enhanced details
    if (format && imageSpecs[format]) {
      const spec = imageSpecs[format];
      
      // Add timestamp to indicate when specs were fetched
      return res.json({
        success: true,
        format: format,
        spec: {
          ...spec,
          fetchedAt: new Date().toISOString(),
          source: metaSpecs ? "Meta API" : "Meta Documentation",
          lastUpdated: "2024"
        },
        objective: objective || "GENERAL"
      });
    }
    
    // Otherwise return recommended specs based on objective
    let recommendedSpecs = [];
    if (objective === "VIDEO_VIEWS" || objective === "ENGAGEMENT") {
      recommendedSpecs = [imageSpecs.single_image, imageSpecs.stories, imageSpecs.reels];
    } else if (objective === "CONVERSIONS" || objective === "TRAFFIC") {
      recommendedSpecs = [imageSpecs.single_image, imageSpecs.carousel];
    } else {
      recommendedSpecs = [imageSpecs.single_image, imageSpecs.stories];
    }
    
    res.json({
      success: true,
      specs: imageSpecs,
      recommended: recommendedSpecs,
      objective: objective || "GENERAL"
    });
  } catch (e) {
    console.error("[Meta Specs] Error:", e);
    res.status(500).json({
      success: false,
      error: e.message || "Failed to fetch image specifications"
    });
  }
});

// Create campaign endpoint
app.post("/api/campaigns/create", requireAdminKey, async (req, res) => {
  try {
    const { accountId, name, objective, budget, audience, startDate, endDate } = req.body;
    
    console.log('[Campaign Creation] Audience data:', audience);
    
    if (!accountId) {
      return res.status(400).json({ success: false, error: "Account ID is required" });
    }
    if (!name) {
      return res.status(400).json({ success: false, error: "Campaign name is required" });
    }
    if (!budget || budget <= 0) {
      return res.status(400).json({ success: false, error: "Valid budget is required" });
    }
    
    const campaignData = {
      name,
      objective: objective || "CONVERSIONS",
      budget: parseFloat(budget),
      audience: audience || {},
      startTime: startDate ? new Date(startDate).toISOString() : null,
      endTime: endDate ? new Date(endDate).toISOString() : null
    };
    
    const result = await createCampaignStructure(accountId, campaignData);
    
    res.json({
      success: true,
      campaign: {
        id: result.campaignId,
        name,
        accountId,
        adSetId: result.adSetId,
        adId: result.adId
      }
    });
  } catch (e) {
    console.error("[Campaign Creation] Error:", e);
    const status = e.response?.status || 500;
    const errorData = e.response?.data || {};
    const errorMessage = errorData.error?.message || errorData.error || e.message || String(e);
    
    res.status(status).json({
      success: false,
      error: errorMessage,
      details: errorData.error?.error_subcode || null
    });
  }
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

// WooCommerce Products CRUD endpoints

// GET /api/products - List products
app.get("/api/products", async (req, res) => {
  try {
    const perPage = parseInt(req.query.per_page) || 50;
    const page = parseInt(req.query.page) || 1;
    const search = req.query.search || "";
    
    let endpoint = `/products?per_page=${perPage}&page=${page}`;
    if (search) {
      endpoint += `&search=${encodeURIComponent(search)}`;
    }
    
    const products = await wooFetch("GET", endpoint);
    const normalized = Array.isArray(products) ? products.map(normalizeProduct) : [];
    
    res.json({
      source: "woo",
      success: true,
      products: normalized,
      count: normalized.length,
      page,
      per_page: perPage
    });
  } catch (err) {
    console.error("[WooCommerce] Error fetching products:", err.message);
    res.status(500).json({
      source: "woo",
      success: false,
      error: err.message || "Failed to fetch products"
    });
  }
});

// GET /api/products/:id - Get single product (fresh from WooCommerce)
app.get("/api/products/:id", async (req, res) => {
  try {
    const product = await wooFetch("GET", `/products/${req.params.id}`);
    
    res.json({
      source: "woo",
      success: true,
      product: product // Return fresh WooCommerce object, not normalized
    });
  } catch (err) {
    console.error("[WooCommerce] Error fetching product:", err.message);
    const status = err.response?.status || 500;
    const errorData = err.response?.data || { error: err.message || "Failed to fetch product" };
    
    res.status(status).json({
      source: "woo",
      success: false,
      ...errorData
    });
  }
});

// GET /api/categories - List categories
app.get("/api/categories", async (req, res) => {
  try {
    const categories = await wooFetch("GET", "/products/categories?per_page=100");
    const normalized = Array.isArray(categories) ? categories.map(cat => ({
      id: cat.id,
      name: cat.name,
      slug: cat.slug,
      count: cat.count || 0
    })) : [];
    
    res.json({
      source: "woo",
      success: true,
      categories: normalized,
      count: normalized.length
    });
  } catch (err) {
    console.error("[WooCommerce] Error fetching categories:", err.message);
    res.status(500).json({
      source: "woo",
      success: false,
      error: err.message || "Failed to fetch categories"
    });
  }
});

// POST /api/products - Create product (admin only)
app.post("/api/products", requireAdminKey, async (req, res) => {
  try {
    const productData = req.body;
    const product = await wooFetch("POST", "/products", productData);
    const normalized = normalizeProduct(product);
    
    console.log(`[WooCommerce] Product created: ${normalized.name} (ID: ${normalized.id})`);
    
    res.json({
      source: "woo",
      success: true,
      product: normalized
    });
  } catch (err) {
    console.error("[WooCommerce] Error creating product:", err.message);
    res.status(err.response?.status || 500).json({
      source: "woo",
      success: false,
      error: err.message || "Failed to create product"
    });
  }
});

// PUT /api/products/:id - Update product (admin only)
app.put("/api/products/:id", requireAdminKey, async (req, res) => {
  try {
    const { 
      name, 
      description, 
      short_description, 
      regular_price, 
      sale_price, 
      sku, 
      stock_status, 
      stock_quantity, 
      status, 
      categories, 
      images, 
      attributes, 
      meta_data,
      variation_id,
      type
    } = req.body;
    
    // Build WooCommerce payload with only provided fields
    const wooPayload = {};
    
    if (name !== undefined) wooPayload.name = name;
    if (description !== undefined) wooPayload.description = description;
    if (short_description !== undefined) wooPayload.short_description = short_description;
    if (regular_price !== undefined) wooPayload.regular_price = String(regular_price);
    if (sale_price !== undefined) wooPayload.sale_price = String(sale_price);
    if (sku !== undefined) wooPayload.sku = sku;
    if (stock_status !== undefined) wooPayload.stock_status = stock_status;
    if (stock_quantity !== undefined) wooPayload.stock_quantity = stock_quantity;
    if (status !== undefined) wooPayload.status = status;
    if (categories !== undefined) {
      wooPayload.categories = Array.isArray(categories) 
        ? categories.map(id => ({ id: Number(id) }))
        : [];
    }
    if (images !== undefined) {
      wooPayload.images = Array.isArray(images)
        ? images.map(src => ({ src: String(src) }))
        : [];
    }
    if (attributes !== undefined) wooPayload.attributes = attributes;
    if (meta_data !== undefined) wooPayload.meta_data = meta_data;
    
    // Determine endpoint: variable products with variation_id use variations endpoint
    let endpoint;
    if (type === "variable" && variation_id) {
      endpoint = `/products/${req.params.id}/variations/${variation_id}`;
    } else {
      endpoint = `/products/${req.params.id}`;
    }
    
    // Use WC_API_URL directly (it ends with /products)
    const baseUrl = WC_API_URL.replace(/\/products.*$/, ""); // Remove /products suffix
    const fullUrl = `${baseUrl}${endpoint}`;
    
    // Build query params for authentication
    const params = new URLSearchParams();
    params.append("consumer_key", WC_API_KEY || "");
    params.append("consumer_secret", WC_API_SECRET || "");
    
    const urlWithAuth = `${fullUrl}${fullUrl.includes("?") ? "&" : "?"}${params.toString()}`;
    
    const response = await axios.put(urlWithAuth, wooPayload, {
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      timeout: 15000
    });
    
    // Check for non-2xx responses
    if (response.status < 200 || response.status >= 300) {
      return res.status(response.status).json({
        source: "woo",
        success: false,
        ...response.data
      });
    }
    
    console.log(`[WooCommerce] Product updated: ${response.data.name || req.params.id} (ID: ${req.params.id})`);
    
    res.json({
      ok: true,
      source: "woo",
      product: response.data
    });
    
  } catch (err) {
    console.error("[WooCommerce] Error updating product:", err.message);
    
    // Bubble up WooCommerce errors - don't swallow
    if (err.response) {
      const status = err.response.status;
      const errorData = err.response.data || { error: err.message };
      
      return res.status(status).json({
        source: "woo",
        success: false,
        ...errorData
      });
    }
    
    // Connection/timeout errors
    res.status(502).json({
      source: "woo",
      success: false,
      error: err.message || "Failed to update product",
      code: err.code
    });
  }
});

// DELETE /api/products/:id - Delete product (admin only)
app.delete("/api/products/:id", requireAdminKey, async (req, res) => {
  try {
    const force = req.query.force === "true";
    const endpoint = `/products/${req.params.id}${force ? "?force=true" : ""}`;
    
    const product = await wooFetch("DELETE", endpoint);
    const normalized = normalizeProduct(product);
    
    console.log(`[WooCommerce] Product deleted: ${normalized.name} (ID: ${normalized.id})`);
    
    res.json({
      source: "woo",
      success: true,
      product: normalized,
      deleted: true
    });
  } catch (err) {
    console.error("[WooCommerce] Error deleting product:", err.message);
    res.status(err.response?.status || 500).json({
      source: "woo",
      success: false,
      error: err.message || "Failed to delete product"
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
    
    const completion = await openaiWithFallback({
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
    
    const completion = await openaiWithFallback({
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

// AI Audience Suggestions endpoint
app.post("/api/ai/audience-suggestions", requireAdminKey, async (req, res) => {
  try {
    console.log("[AI Audience] Request received");
    const companyContext = loadCompanyContext();
    console.log("[AI Audience] Company context loaded:", companyContext.name || "N/A");
    
    // Build comprehensive company profile context
    let contextPrompt = `Company: ${companyContext.name || "MAROM"}\n`;
    
    if (companyContext.industry) {
      contextPrompt += `Industry: ${companyContext.industry}\n`;
    }
    
    if (companyContext.description) {
      contextPrompt += `Description: ${companyContext.description}\n`;
    }
    
    if (companyContext.mission) {
      contextPrompt += `Mission: ${companyContext.mission}\n`;
    }
    
    if (companyContext.targetAudience) {
      contextPrompt += `Current Target Audience: ${companyContext.targetAudience}\n`;
    }
    
    if (companyContext.brandValues) {
      contextPrompt += `Brand Values: ${companyContext.brandValues}\n`;
    }
    
    if (companyContext.brandUSP) {
      contextPrompt += `Unique Selling Points: ${companyContext.brandUSP}\n`;
    }
    
    if (companyContext.brandPersonality) {
      contextPrompt += `Brand Personality: ${companyContext.brandPersonality}\n`;
    }
    
    if (companyContext.brandTone) {
      contextPrompt += `Brand Tone: ${companyContext.brandTone}\n`;
    }
    
    // Get product categories for context
    try {
      const products = await getProductsCache();
      if (products && products.length > 0) {
        const categories = new Set();
        products.forEach(p => {
          if (p.categories && Array.isArray(p.categories)) {
            p.categories.forEach(cat => categories.add(cat.name || cat));
          }
        });
        if (categories.size > 0) {
          contextPrompt += `Product Categories: ${Array.from(categories).join(", ")}\n`;
        }
      }
    } catch (err) {
      console.warn("[AI Audience] Could not load products:", err.message);
    }
    
    const systemPrompt = `You are a Facebook and Instagram advertising expert specializing in audience targeting. Based on a company's profile, suggest optimal audience targeting parameters for their ad campaigns.

You should suggest:
1. Age range (min and max, typically 18-65)
2. Gender targeting (1=Men, 2=Women, or leave empty for all)
3. Top 3-5 countries (use ISO country codes like TH, US, GB, etc.)
4. 5-10 relevant interests/keywords (comma-separated)
5. 2-3 relevant behaviors (optional, comma-separated)

Consider:
- The company's industry and products
- Their target audience description
- Brand values and personality
- Geographic markets they likely serve
- Interests that align with their products/services

Return your response as JSON with this exact structure:
{
  "name": "Suggested audience name (e.g., 'Women 25-45, Beauty Enthusiasts')",
  "ageMin": 25,
  "ageMax": 45,
  "gender": "2",
  "locations": ["TH", "US"],
  "interests": ["Beauty", "Skincare", "Natural products", "Cosmetics", "Wellness"],
  "behaviors": ["Online shoppers", "Mobile device users"],
  "reasoning": "Brief explanation of why this audience is a good fit"
}`;

    const userPrompt = `Based on this company profile, suggest an optimal Facebook/Instagram ad audience:

${contextPrompt}

Provide a well-targeted audience suggestion that would perform well for their campaigns.`;

    console.log("[AI Audience] Calling OpenAI API...");
    const completion = await openaiWithFallback({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      response_format: { type: "json_object" },
      temperature: 0.7,
      max_tokens: 500
    });
    
    console.log("[AI Audience] OpenAI response received");
    
    if (!completion || !completion.choices || !completion.choices[0] || !completion.choices[0].message) {
      throw new Error("Invalid response from OpenAI API");
    }
    
    const content = completion.choices[0].message.content;
    if (!content) {
      throw new Error("Empty response from OpenAI API");
    }
    
    console.log("[AI Audience] Parsing JSON response...");
    let suggestion;
    try {
      suggestion = JSON.parse(content);
    } catch (parseErr) {
      console.error("[AI Audience] JSON parse error:", parseErr);
      console.error("[AI Audience] Raw content:", content);
      throw new Error(`Failed to parse AI response: ${parseErr.message}`);
    }
    
    // Validate and normalize the response
    const normalized = {
      name: suggestion.name || "AI Suggested Audience",
      ageMin: suggestion.ageMin || null,
      ageMax: suggestion.ageMax || null,
      gender: suggestion.gender || "",
      locations: Array.isArray(suggestion.locations) ? suggestion.locations : 
                 (suggestion.locations ? suggestion.locations.split(",").map(l => l.trim()) : []),
      interests: Array.isArray(suggestion.interests) ? suggestion.interests.join(", ") :
                 (suggestion.interests || ""),
      behaviors: Array.isArray(suggestion.behaviors) ? suggestion.behaviors.join(", ") :
                (suggestion.behaviors || ""),
      reasoning: suggestion.reasoning || "AI-generated suggestion based on company profile"
    };
    
    console.log(`[AI Audience] Generated suggestion for ${companyContext.name || "company"}:`, normalized.name);
    
    res.json({
      success: true,
      suggestion: normalized
    });
  } catch (err) {
    console.error("[AI Audience] Error:", err);
    console.error("[AI Audience] Error stack:", err.stack);
    res.status(500).json({
      success: false,
      error: err.message || "Failed to generate audience suggestions",
      details: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
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
    
    const completion = await openaiWithFallback({
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
    const lowerMessage = message.toLowerCase();
    
    // Detect intents and fetch real data
    let dataContext = "";
    let actions = [];
    let detectedIntent = null;
    
    // Check for campaign/stats queries
    if (lowerMessage.includes("stat") || lowerMessage.includes("performance") || 
        lowerMessage.includes("spend") || lowerMessage.includes("impression") ||
        lowerMessage.includes("click") || lowerMessage.includes("ctr") ||
        (lowerMessage.includes("campaign") && !lowerMessage.includes("create"))) {
      detectedIntent = "stats";
      try {
        if (TOKEN) {
          const accounts = await fb(`/me/adaccounts`, "GET", { fields: "id,account_id,name" });
          if (accounts.data && accounts.data.length > 0) {
            let totalSpend = 0, totalImpressions = 0, totalClicks = 0;
            for (const account of accounts.data) {
              try {
                const insights = await fb(`/${account.id}/insights`, "GET", {
                  date_preset: "last_7d",
                  fields: "spend,impressions,clicks,ctr,cpc,cpm"
                });
                if (insights.data && insights.data[0]) {
                  const d = insights.data[0];
                  totalSpend += parseFloat(d.spend || 0);
                  totalImpressions += parseInt(d.impressions || 0);
                  totalClicks += parseInt(d.clicks || 0);
                }
              } catch (e) {
                // Continue
              }
            }
            const ctr = totalImpressions > 0 ? ((totalClicks / totalImpressions) * 100).toFixed(2) : "0.00";
            const cpc = totalClicks > 0 ? (totalSpend / totalClicks).toFixed(2) : "0.00";
            dataContext += `\n\nCURRENT CAMPAIGN DATA (Last 7 days):\n- Total Spend: $${totalSpend.toFixed(2)}\n- Impressions: ${totalImpressions.toLocaleString()}\n- Clicks: ${totalClicks.toLocaleString()}\n- CTR: ${ctr}%\n- CPC: $${cpc}`;
            actions.push({ type: "navigate", tab: "campaigns" });
          }
        }
      } catch (err) {
        dataContext += `\n\nNote: Could not fetch campaign stats. Error: ${err.message}`;
      }
    }
    
    // Check for campaign list queries
    if (lowerMessage.includes("list campaign") || lowerMessage.includes("show campaign") ||
        lowerMessage.includes("my campaign") || lowerMessage.includes("all campaign")) {
      detectedIntent = "campaigns";
      try {
        if (TOKEN) {
          const accounts = await fb(`/me/adaccounts`, "GET", { fields: "id" });
          if (accounts.data && accounts.data.length > 0) {
            const campaigns = [];
            for (const account of accounts.data) {
              try {
                const result = await fb(`/${account.id}/campaigns`, "GET", {
                  fields: "id,name,status",
                  limit: 20
                });
                if (result.data) campaigns.push(...result.data);
              } catch (e) {
                // Continue
              }
            }
            if (campaigns.length > 0) {
              const activeCount = campaigns.filter(c => c.status === "ACTIVE").length;
              const pausedCount = campaigns.filter(c => c.status === "PAUSED").length;
              dataContext += `\n\nCURRENT CAMPAIGNS:\n- Total: ${campaigns.length}\n- Active: ${activeCount}\n- Paused: ${pausedCount}\n\nRecent campaigns: ${campaigns.slice(0, 5).map(c => `${c.name} (${c.status})`).join(", ")}`;
              actions.push({ type: "navigate", tab: "campaigns" });
            }
          }
        }
      } catch (err) {
        dataContext += `\n\nNote: Could not fetch campaigns. Error: ${err.message}`;
      }
    }
    
    // Check for product queries
    if (lowerMessage.includes("product") && !lowerMessage.includes("create")) {
      detectedIntent = "products";
      try {
        const products = await wooFetch("GET", "/products?per_page=10");
        if (products && products.length > 0) {
          dataContext += `\n\nAVAILABLE PRODUCTS (${products.length}):\n`;
          products.slice(0, 5).forEach((p, i) => {
            const normalized = normalizeProduct(p);
            const name = normalized.name || "Unnamed";
            const price = normalized.price ? `$${normalized.price}` : "N/A";
            dataContext += `${i + 1}. ${name} - ${price}\n`;
          });
          actions.push({ type: "navigate", tab: "products" });
          
          // Try to find specific product mentioned
          const productMatch = message.match(/\b(shampoo|hair|treatment|product|cream|serum|oil|mask)\b/i);
          if (productMatch) {
            const foundProduct = await findProductByName(productMatch[0]);
            if (foundProduct) {
              dataContext += `\n\nMATCHED PRODUCT DETAILS:\n- Name: ${foundProduct.name}\n- Price: ${foundProduct.price ? `$${foundProduct.price}` : "N/A"}\n- Description: ${(foundProduct.description || foundProduct.short_description || "").substring(0, 200)}`;
            }
          }
        } else {
          dataContext += `\n\nNote: No products found in WooCommerce.`;
        }
      } catch (err) {
        dataContext += `\n\nNote: Could not fetch products from WooCommerce. Error: ${err.message}`;
      }
    }
    
    // Check for audience queries
    if (lowerMessage.includes("audience") || lowerMessage.includes("target")) {
      detectedIntent = "audiences";
      actions.push({ type: "navigate", tab: "audiences" });
    }
    
    // Check for AI studio queries
    if (lowerMessage.includes("generate") || lowerMessage.includes("create image") || 
        lowerMessage.includes("create video") || lowerMessage.includes("ai studio")) {
      detectedIntent = "ai_studio";
      actions.push({ type: "navigate", tab: "ai-studio" });
    }
    
    // Build system prompt with detected data
    const systemPrompt = buildSystemPrompt(companyContext);
    const enhancedSystemPrompt = systemPrompt + 
      " You are a powerful AI assistant that can CONTROL the dashboard. " +
      "When users ask about campaigns, products, audiences, or want to create content, you have access to REAL DATA. " +
      "Use the data provided to give accurate, helpful responses. " +
      "You can navigate users to different tabs, fetch real-time data, and perform actions. " +
      "Be proactive and helpful - if they ask about something, fetch the data and show it to them.";
    
    // Build messages array for OpenAI
    const messages = [
      {
        role: "system",
        content: enhancedSystemPrompt + (dataContext ? `\n\nREAL-TIME DATA:\n${dataContext}` : "")
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

    const completion = await openaiWithFallback({
      model: "gpt-4o-mini",
      messages: messages,
      temperature: 0.8,
      max_tokens: 800,
      presence_penalty: 0.3,
      frequency_penalty: 0.2
    });

    const aiResponse = completion.choices[0].message.content;
    
    // Save conversation to memory
    saveConversation(message, aiResponse);
    
    // Return response with actions
    res.json({ 
      message: aiResponse,
      actions: actions,
      intent: detectedIntent,
      data: dataContext ? { summary: dataContext.substring(0, 500) } : null
    });
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

// Creatives API endpoints
app.post("/api/creatives/session", requireAdminKey, (req, res) => {
  try {
    const { phone = "dashboard", angle, style } = req.body;
    const session = getSession(phone);
    
    if (angle) {
      const matchedAngle = matchAngle(angle);
      if (matchedAngle) {
        session.angle = matchedAngle;
      } else {
        return res.status(400).json({ ok: false, error: `Invalid angle. Available: ${Object.keys(ANGLE_PRESETS).join(", ")}` });
      }
    }
    
    if (style) {
      session.style = style;
    }
    
    res.json({ ok: true, angle: session.angle, style: session.style });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/creatives/generate", requireAdminKey, async (req, res) => {
  try {
    const { productQuery, angle, style, pack = false, phone = "dashboard" } = req.body;
    
    if (!productQuery) {
      return res.status(400).json({ ok: false, error: "productQuery is required" });
    }
    
    // Find product
    const product = await findProductByName(productQuery);
    if (!product) {
      return res.status(404).json({ ok: false, error: `Product not found: ${productQuery}` });
    }
    
    const session = getSession(phone);
    const companyContext = loadCompanyContext();
    
    // Override session angle/style if provided
    const finalAngle = angle ? (matchAngle(angle) || session.angle) : session.angle;
    const finalStyle = style || session.style;
    
    const tempSession = { ...session, angle: finalAngle, style: finalStyle };
    const prompt = buildImagePrompt(product, tempSession, companyContext);
    
    // Generate base image using Vertex AI
    let baseImage;
    try {
      baseImage = await generateImageWithEngine(prompt, "1:1", 1024, 1024);
    } catch (err) {
      // Handle structured errors from image generation
      const status = err.status || 500;
      const error = err.message || err.toString();
      const details = err.details;
      
      return res.status(status).json({ 
        ok: false, 
        error: error,
        ...(details && { details })
      });
    }
    
    const productName = product.name || productQuery;
    const items = [];
    
    if (pack) {
      // Generate pack: square, portrait, story
      const square = baseImage;
      const portrait = await sharp(baseImage).resize(1080, 1350, { fit: "cover" }).jpeg({ quality: 87 }).toBuffer();
      const story = await sharp(baseImage).resize(1080, 1920, { fit: "cover" }).jpeg({ quality: 87 }).toBuffer();
      
      // Upload to WhatsApp and get media IDs
      const squareMediaId = await uploadWhatsAppMedia(square);
      const portraitMediaId = await uploadWhatsAppMedia(portrait);
      const storyMediaId = await uploadWhatsAppMedia(story);
      
      // Create base64 previews for dashboard
      const squarePreview = imageToDataURL(square);
      const portraitPreview = imageToDataURL(portrait);
      const storyPreview = imageToDataURL(story);
      
      items.push(
        {
          mediaId: squareMediaId,
          caption: `${productName} • Square (1:1) • angle: ${finalAngle}`,
          aspect: "1:1",
          previewUrl: squarePreview
        },
        {
          mediaId: portraitMediaId,
          caption: `${productName} • Portrait (4:5) • angle: ${finalAngle}`,
          aspect: "4:5",
          previewUrl: portraitPreview
        },
        {
          mediaId: storyMediaId,
          caption: `${productName} • Story (9:16) • angle: ${finalAngle}`,
          aspect: "9:16",
          previewUrl: storyPreview
        }
      );
      
      // Save to history
      addToHistory(phone, squareMediaId, items[0].caption, productName, finalAngle, finalStyle);
      
      console.log(`[Creatives API] Generated pack for ${phone}: ${productName}, media_ids: ${squareMediaId}, ${portraitMediaId}, ${storyMediaId}`);
      
    } else {
      // Single square image
      const mediaId = await uploadWhatsAppMedia(baseImage);
      const caption = `${productName} • angle: ${finalAngle}`;
      const previewUrl = imageToDataURL(baseImage);
      
      items.push({
        mediaId,
        caption,
        aspect: "1:1",
        previewUrl
      });
      
      // Save to history
      addToHistory(phone, mediaId, caption, productName, finalAngle, finalStyle);
      
      console.log(`[Creatives API] Generated single for ${phone}: ${productName}, media_id: ${mediaId}`);
    }
    
    res.json({ ok: true, items });
    
  } catch (err) {
    console.error("[Creatives API] Error:", err);
    const status = err.status || 500;
    const error = err.message || err.toString();
    res.status(status).json({ ok: false, error });
  }
});

app.get("/api/creatives/last", requireAdminKey, (req, res) => {
  try {
    const phone = req.query.phone || "dashboard";
    const history = creativeHistory.get(phone) || [];
    const last = history.slice(-10).reverse(); // Last 10, most recent first
    
    res.json({ ok: true, items: last });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Video generation endpoint
app.post("/api/creatives/video", requireAdminKey, async (req, res) => {
  try {
    const { productQuery, prompt, aspectRatio = "9:16", durationSec = 8, phone = "dashboard" } = req.body;
    
    if (!productQuery && !prompt) {
      return res.status(400).json({ ok: false, error: "productQuery or prompt is required" });
    }
    
    const companyContext = loadCompanyContext();
    let enhancedPrompt = prompt;
    let product = null;
    
    // If productQuery is provided, find product and enhance prompt
    if (productQuery) {
      product = await findProductByName(productQuery);
      if (!product) {
        return res.status(404).json({ ok: false, error: `Product not found: ${productQuery}` });
      }
      
      // Build enhanced prompt with company profile context
      const basePrompt = prompt || `UGC style video showcasing ${product.name}, natural lighting, authentic feel`;
      
      // Enhance with company profile
      const contextParts = [];
      if (companyContext.brandTone) {
        contextParts.push(`Brand tone: ${companyContext.brandTone}`);
      }
      if (companyContext.targetAudience) {
        contextParts.push(`Target audience: ${companyContext.targetAudience}`);
      }
      if (companyContext.description) {
        const brandDesc = companyContext.description.substring(0, 100);
        contextParts.push(`Brand: ${brandDesc}`);
      }
      if (product.name) {
        contextParts.push(`Featuring: ${product.name}`);
      }
      if (product.short_description) {
        const desc = product.short_description.substring(0, 100);
        contextParts.push(`Product highlights: ${desc}`);
      }
      contextParts.push("UGC style, authentic user-generated content feel");
      
      enhancedPrompt = contextParts.join(". ") + ". " + basePrompt;
    } else if (prompt) {
      // Enhance prompt with company profile even without product
      const contextParts = [];
      if (companyContext.brandTone) {
        contextParts.push(`Brand tone: ${companyContext.brandTone}`);
      }
      if (companyContext.targetAudience) {
        contextParts.push(`Target audience: ${companyContext.targetAudience}`);
      }
      if (companyContext.description) {
        const brandDesc = companyContext.description.substring(0, 100);
        contextParts.push(`Brand context: ${brandDesc}`);
      }
      
      if (contextParts.length > 0) {
        enhancedPrompt = contextParts.join(". ") + ". " + prompt;
      }
    }
    
    // Import video generation service
    let generateVideo;
    try {
      const vertexModule = await import("./services/vertexService.js");
      generateVideo = vertexModule.generateVideo;
      if (!generateVideo) {
        throw new Error("generateVideo function not found");
      }
    } catch (importErr) {
      console.error("[Video Generation] Failed to import vertexService:", importErr.message);
      return res.status(503).json({ 
        ok: false, 
        error: "Video generation service not available. Check Vertex AI configuration.",
        details: importErr.message
      });
    }
    
    // Generate video
    const productContext = product ? {
      title: product.name,
      shortDesc: product.description || product.short_description || "",
      permalink: product.permalink || ""
    } : null;
    
    const result = await generateVideo(enhancedPrompt, aspectRatio, durationSec, productContext);
    
    // Convert to base64 for preview
    const videoBase64 = result.buffer.toString('base64');
    const videoDataUrl = `data:${result.mimeType};base64,${videoBase64}`;
    
    // Save to history
    const productName = product?.name || "Custom Video";
    const caption = `${productName} • Video • ${aspectRatio} • ${durationSec}s`;
    addToHistory(phone, "video", caption, productName, null, null);
    
    console.log(`[Creatives API] Generated video for ${phone}: ${productName}, duration: ${durationSec}s`);
    
    res.json({ 
      ok: true, 
      video: {
        dataUrl: videoDataUrl,
        mimeType: result.mimeType,
        aspectRatio,
        durationSec,
        model: result.model
      },
      prompt: enhancedPrompt,
      product: product ? { name: product.name, id: product.id } : null
    });
    
  } catch (err) {
    console.error("[Creatives API] Video generation error:", err);
    const status = err.status || 500;
    const error = err.message || err.toString();
    res.status(status).json({ ok: false, error });
  }
});

// Mount new routes (optional - only if files exist)
async function loadVertexRoutes() {
  try {
    console.log("[Route Loading] Attempting to load media.js...");
    
    // Try root directory first (matches git structure), then routes/ subdirectory
    let mediaRoutes = null;
    const possibleMediaPaths = [
      "./media.js",  // Root directory (matches git)
      "./routes/media.js"  // Routes subdirectory (fallback)
    ];
    
    for (const mediaPath of possibleMediaPaths) {
      const mediaRoutePath = mediaPath.startsWith("./") 
        ? path.join(__dirname, mediaPath.replace("./", ""))
        : path.join(__dirname, mediaPath);
      
      if (fs.existsSync(mediaRoutePath)) {
        try {
          mediaRoutes = (await import(mediaPath)).default;
          console.log(`[Route Loading] Loaded media routes from: ${mediaPath}`);
          break;
        } catch (e) {
          console.warn(`[Route Loading] Failed to load from ${mediaPath}:`, e.message);
        }
      }
    }
    
    if (!mediaRoutes) {
      console.warn("⚠️ media.js not found in root or routes/ directory");
      console.warn("   Routes will be added directly in server.js");
      return false;
    }
    
    // Try to load WhatsApp routes (optional)
    console.log("[Route Loading] Attempting to load whatsapp.js...");
    let whatsappWebhookRoutes = null;
    const possibleWhatsappPaths = [
      "./routes/whatsapp.js",  // Routes subdirectory (preferred - file exists here)
      "./whatsapp.js"  // Root directory (fallback)
    ];
    
    for (const whatsappPath of possibleWhatsappPaths) {
      const whatsappRoutePath = whatsappPath.startsWith("./") 
        ? path.join(__dirname, whatsappPath.replace("./", ""))
        : path.join(__dirname, whatsappPath);
      
      console.log(`[Route Loading] Checking WhatsApp route path: ${whatsappRoutePath}`);
      console.log(`[Route Loading] File exists: ${fs.existsSync(whatsappRoutePath)}`);
      
      if (fs.existsSync(whatsappRoutePath)) {
        try {
          const imported = await import(whatsappPath);
          whatsappWebhookRoutes = imported.default || imported;
          console.log(`[Route Loading] ✅ Loaded WhatsApp routes from: ${whatsappPath}`);
          console.log(`[Route Loading] Router type: ${typeof whatsappWebhookRoutes}`);
          break;
        } catch (e) {
          console.error(`[Route Loading] ❌ Failed to load from ${whatsappPath}:`, e.message);
          console.error(`[Route Loading] Error stack:`, e.stack);
        }
      } else {
        console.log(`[Route Loading] ⚠️ WhatsApp route file not found at: ${whatsappRoutePath}`);
      }
    }
    
    app.use("/api/media", mediaRoutes);
    if (whatsappWebhookRoutes) {
      app.use("/webhooks/whatsapp", whatsappWebhookRoutes);
      console.log("✅ WhatsApp webhook routes registered");
      console.log("   - POST /webhooks/whatsapp");
      console.log("   - GET /webhooks/whatsapp (verification)");
      console.log("   - GET /webhooks/whatsapp/test");
    } else {
      console.warn("⚠️ WhatsApp webhook routes not loaded");
      console.warn("   Check that routes/whatsapp.js exists and exports router correctly");
    }
    
    // Load image generator routes
    let imageGeneratorRoutes = null;
    const possibleImageGeneratorPaths = [
      "./routes/imageGenerator.js",
      "./imageGenerator.js"
    ];
    
    for (const routePath of possibleImageGeneratorPaths) {
      try {
        const routeModule = await import(routePath);
        imageGeneratorRoutes = routeModule.default;
        console.log(`[Route Loading] ✅ Loaded imageGenerator.js from ${routePath}`);
        break;
      } catch (e) {
        // Continue to next path
      }
    }
    
    if (imageGeneratorRoutes) {
      app.use("/api/image-generator", imageGeneratorRoutes);
      console.log("✅ Image Generator routes loaded");
      console.log("   - POST /api/image-generator/compose");
      console.log("   - GET /api/image-generator/test");
    } else {
      console.warn("⚠️ Image Generator routes not found");
    }
    
    console.log("✅ Vertex AI Content Creator routes loaded");
    console.log("   - POST /api/media/create");
    console.log("   - GET /api/media/test");
    if (whatsappWebhookRoutes) {
      console.log("   - POST /webhooks/whatsapp");
    }
    return true;
  } catch (err) {
    console.error("❌ Error loading Vertex AI Content Creator routes:", err);
    console.error("   Error details:", err.message);
    console.error("   Stack:", err.stack);
    console.warn("   Make sure media.js and whatsapp.js are deployed (in root or routes/ directory).");
    return false;
  }
}

// Audience Management Functions
function loadAudiences() {
  try {
    if (fs.existsSync(AUDIENCES_FILE)) {
      const data = fs.readFileSync(AUDIENCES_FILE, "utf8");
      return JSON.parse(data);
    }
  } catch (err) {
    console.error("[Audiences] Error loading audiences:", err);
  }
  return [];
}

function saveAudiences(audiences) {
  try {
    fs.writeFileSync(AUDIENCES_FILE, JSON.stringify(audiences, null, 2), "utf8");
    return true;
  } catch (err) {
    console.error("[Audiences] Error saving audiences:", err);
    return false;
  }
}

// Audience CRUD Endpoints
app.get("/api/audiences", requireAdminKey, (req, res) => {
  try {
    const audiences = loadAudiences();
    res.json(audiences);
  } catch (err) {
    console.error("[Audiences] GET error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/audiences", requireAdminKey, (req, res) => {
  try {
    const { name, ageMin, ageMax, gender, locationData, locations, interests, behaviors } = req.body;
    
    if (!name || name.trim() === '') {
      return res.status(400).json({ error: "Audience name is required" });
    }
    
    const audiences = loadAudiences();
    const newId = Date.now().toString();
    
    const newAudience = {
      id: newId,
      name: name.trim(),
      ageMin: ageMin || null,
      ageMax: ageMax || null,
      gender: gender || "",
      locationData: locationData || (locations ? { type: 'countries', countries: locations } : null),
      // Legacy support
      locations: locations || "",
      interests: interests || "",
      behaviors: behaviors || "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    
    audiences.push(newAudience);
    saveAudiences(audiences);
    
    console.log(`[Audiences] Created audience: ${newAudience.name} (ID: ${newId})`);
    res.json(newAudience);
  } catch (err) {
    console.error("[Audiences] POST error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/audiences/:id", requireAdminKey, (req, res) => {
  try {
    const { id } = req.params;
    const { name, ageMin, ageMax, gender, locationData, locations, interests, behaviors } = req.body;
    
    if (!name || name.trim() === '') {
      return res.status(400).json({ error: "Audience name is required" });
    }
    
    const audiences = loadAudiences();
    const index = audiences.findIndex(a => a.id === id);
    
    if (index === -1) {
      return res.status(404).json({ error: "Audience not found" });
    }
    
    audiences[index] = {
      ...audiences[index],
      name: name.trim(),
      ageMin: ageMin || null,
      ageMax: ageMax || null,
      gender: gender || "",
      locationData: locationData || (locations ? { type: 'countries', countries: locations } : audiences[index].locationData),
      // Legacy support
      locations: locations || audiences[index].locations || "",
      interests: interests || "",
      behaviors: behaviors || "",
      updatedAt: new Date().toISOString()
    };
    
    saveAudiences(audiences);
    
    console.log(`[Audiences] Updated audience: ${audiences[index].name} (ID: ${id})`);
    res.json(audiences[index]);
  } catch (err) {
    console.error("[Audiences] PUT error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/audiences/:id", requireAdminKey, (req, res) => {
  try {
    const { id } = req.params;
    const audiences = loadAudiences();
    const index = audiences.findIndex(a => a.id === id);
    
    if (index === -1) {
      return res.status(404).json({ error: "Audience not found" });
    }
    
    const deleted = audiences.splice(index, 1)[0];
    saveAudiences(audiences);
    
    console.log(`[Audiences] Deleted audience: ${deleted.name} (ID: ${id})`);
    res.json({ success: true, deleted });
  } catch (err) {
    console.error("[Audiences] DELETE error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Geocoding proxy endpoint (to avoid CORS issues)
app.get("/api/geocode/search", async (req, res) => {
  try {
    const { q, limit = 5 } = req.query;
    
    if (!q || q.trim() === '') {
      return res.status(400).json({ error: "Query parameter 'q' is required" });
    }
    
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=${limit}&accept-language=en&addressdetails=1&namedetails=1`;
    
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'MAROM Dashboard',
        'Accept': 'application/json',
        'Accept-Language': 'en'
      },
      timeout: 10000
    });
    
    res.json(response.data);
  } catch (err) {
    console.error("[Geocode] Error:", err.message);
    res.status(500).json({ error: err.message || "Geocoding failed" });
  }
});

// Vertex AI Diagnostic Endpoint
app.get("/api/vertex/diagnostic", requireAdminKey, async (req, res) => {
  const diagnostic = {
    timestamp: new Date().toISOString(),
    environment: {},
    credentials: {},
    authentication: {},
    api: {}
  };
  
  try {
    // Check environment variables
    diagnostic.environment = {
      GOOGLE_CLOUD_PROJECT: process.env.GOOGLE_CLOUD_PROJECT ? "✓ SET" : "✗ NOT SET",
      GOOGLE_CLOUD_LOCATION: process.env.GOOGLE_CLOUD_LOCATION || "us-central1 (default)",
      GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS ? "✓ SET" : "✗ NOT SET",
      GOOGLE_PRIVATE_KEY: process.env.GOOGLE_PRIVATE_KEY ? "✓ SET" : "✗ NOT SET",
      GOOGLE_CLIENT_EMAIL: process.env.GOOGLE_CLIENT_EMAIL ? "✓ SET" : "✗ NOT SET"
    };
    
    // Check credentials file
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      const credsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
      const fileExists = fs.existsSync(credsPath);
      let readable = "N/A";
      if (fileExists) {
        try {
          fs.accessSync(credsPath, fs.constants.R_OK);
          readable = "✓ READABLE";
        } catch {
          readable = "✗ NOT READABLE";
        }
      }
      
      diagnostic.credentials = {
        filePath: credsPath,
        fileExists: fileExists ? "✓ EXISTS" : "✗ NOT FOUND",
        readable: readable
      };
      
      if (fileExists) {
        try {
          const credsContent = fs.readFileSync(credsPath, "utf8");
          const creds = JSON.parse(credsContent);
          diagnostic.credentials.projectId = creds.project_id || "NOT FOUND";
          diagnostic.credentials.clientEmail = creds.client_email || "NOT FOUND";
          diagnostic.credentials.hasPrivateKey = creds.private_key ? "✓ PRESENT" : "✗ MISSING";
        } catch (err) {
          diagnostic.credentials.parseError = err.message;
        }
      }
    }
    
    // Test authentication
    try {
      const { GoogleAuth } = await import("google-auth-library");
      const authConfig = {
        scopes: ["https://www.googleapis.com/auth/cloud-platform"]
      };
      
      if (process.env.GOOGLE_APPLICATION_CREDENTIALS && fs.existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS)) {
        authConfig.keyFilename = process.env.GOOGLE_APPLICATION_CREDENTIALS;
      } else if (process.env.GOOGLE_PRIVATE_KEY && process.env.GOOGLE_CLIENT_EMAIL) {
        authConfig.credentials = {
          type: "service_account",
          project_id: process.env.GOOGLE_CLOUD_PROJECT,
          private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
          client_email: process.env.GOOGLE_CLIENT_EMAIL
        };
      }
      
      const auth = new GoogleAuth(authConfig);
      const client = await auth.getClient();
      const accessToken = await client.getAccessToken();
      
      diagnostic.authentication = {
        status: "✓ SUCCESS",
        tokenPreview: accessToken.token ? `${accessToken.token.substring(0, 20)}...` : "NO TOKEN"
      };
      
      // Test API endpoint
      const projectId = process.env.GOOGLE_CLOUD_PROJECT;
      let location = (process.env.GOOGLE_CLOUD_LOCATION || "us-central1").trim().toLowerCase();
      
      // Validate location - Vertex AI doesn't support "global"
      const VALID_LOCATIONS = [
        "us-central1", "us-east1", "us-east4", "us-west1", "us-west2", "us-west3", "us-west4",
        "europe-west1", "europe-west2", "europe-west3", "europe-west4", "europe-west6", "europe-west8", "europe-west9",
        "asia-east1", "asia-northeast1", "asia-northeast2", "asia-northeast3", "asia-south1", "asia-southeast1",
        "australia-southeast1", "northamerica-northeast1", "southamerica-east1"
      ];
      
      if (location === "global" || !VALID_LOCATIONS.includes(location)) {
        diagnostic.api = {
          status: "✗ FAILED",
          endpoint: `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}`,
          error: "Invalid location: 'global' is not supported",
          details: {
            providedLocation: location,
            validLocations: VALID_LOCATIONS,
            suggestion: "Set GOOGLE_CLOUD_LOCATION to a valid region like 'us-central1', 'us-east1', 'europe-west1', or 'asia-southeast1'"
          },
          suggestions: [
            "Location 'global' is not valid for Vertex AI",
            "Set GOOGLE_CLOUD_LOCATION to a specific region (e.g., us-central1, us-east1, europe-west1, asia-southeast1)",
            "Common regions: us-central1 (US), europe-west1 (EU), asia-southeast1 (Asia)"
          ]
        };
        res.json(diagnostic);
        return;
      }
      
      const testEndpoint = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}`;
      
      try {
        const response = await axios.get(testEndpoint, {
          headers: {
            "Authorization": `Bearer ${accessToken.token}`,
            "Content-Type": "application/json"
          },
          timeout: 10000
        });
        
        diagnostic.api = {
          status: "✓ ACCESSIBLE",
          endpoint: testEndpoint,
          httpStatus: response.status
        };
      } catch (apiErr) {
        diagnostic.api = {
          status: "✗ FAILED",
          endpoint: testEndpoint,
          error: apiErr.response ? `${apiErr.response.status} ${apiErr.response.statusText}` : apiErr.message,
          details: apiErr.response?.data || null,
          suggestions: []
        };
        
        if (apiErr.response?.status === 403) {
          diagnostic.api.suggestions = [
            "Vertex AI API may not be enabled in Google Cloud Console",
            "Service account may not have 'Vertex AI User' role",
            "Project billing may not be enabled"
          ];
        } else if (apiErr.response?.status === 404) {
          diagnostic.api.suggestions = [
            "Project ID may be incorrect",
            "Location/region may be incorrect",
            "Vertex AI API may not be enabled"
          ];
        }
      }
    } catch (authErr) {
      diagnostic.authentication = {
        status: "✗ FAILED",
        error: authErr.message,
        stack: authErr.stack
      };
    }
    
    res.json(diagnostic);
  } catch (err) {
    res.status(500).json({
      error: err.message,
      diagnostic: diagnostic
    });
  }
});

// Always add media routes directly (fallback if route file doesn't load)
function addMediaRoutesDirectly() {
  console.log("[Route Loading] Adding media routes directly in server.js...");
  
  // Test endpoint
  app.get("/api/media/test", (req, res) => {
    res.json({ 
      success: true, 
      message: "Media API direct route is working", 
      timestamp: new Date().toISOString(),
      source: "server.js direct route"
    });
  });
  
  // Upload image endpoint - accepts base64 or multipart
  app.post("/api/media/upload", requireAdminKey, express.json({ limit: '50mb' }), async (req, res) => {
    try {
      // Check if it's base64 data
      if (req.body.imageData) {
        const base64Data = req.body.imageData.replace(/^data:image\/\w+;base64,/, '');
        const buffer = Buffer.from(base64Data, 'base64');
        
        // Generate unique filename
        const timestamp = Date.now();
        const randomStr = Math.random().toString(36).substring(2, 15);
        const ext = req.body.format || 'jpg';
        const filename = `upload_${timestamp}_${randomStr}.${ext}`;
        
        // Save to uploads directory
        const uploadsDir = path.join(__dirname, 'uploads');
        if (!fs.existsSync(uploadsDir)) {
          fs.mkdirSync(uploadsDir, { recursive: true });
        }
        
        const filepath = path.join(uploadsDir, filename);
        fs.writeFileSync(filepath, buffer);
        
        // Return URL
        const baseUrl = process.env.API_URL || `https://marom-meta-backend.onrender.com`;
        const imageUrl = `${baseUrl}/uploads/${filename}`;
        
        return res.json({
          success: true,
          url: imageUrl,
          imageUrl: imageUrl,
          filename: filename
        });
      }
      
      // If no base64 data, return error
      res.status(400).json({
        success: false,
        error: "Please send image as base64 in imageData field"
      });
    } catch (error) {
      console.error("[Media Upload] Error:", error);
      res.status(500).json({
        success: false,
        error: error.message || "Upload failed"
      });
    }
  });
  
  // Serve uploaded files
  const uploadsDir = path.join(__dirname, 'uploads');
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }
  app.use('/uploads', express.static(uploadsDir));
  
  // Image generation endpoint
  app.post("/api/media/create", requireAdminKey, async (req, res) => {
    console.log("[Media API] Direct route handler called");
    try {
      // Try multiple import paths (check root directory first, then services/)
      let generateImage;
      const possiblePaths = [
        "./vertexService.js",  // Root directory (matches git structure)
        "./services/vertexService.js",  // Services subdirectory (if exists)
        path.join(__dirname, "vertexService.js"),  // Root absolute path
        path.join(__dirname, "services", "vertexService.js"),  // Services absolute path
        path.join(process.cwd(), "vertexService.js"),  // Root from cwd
        path.join(process.cwd(), "services", "vertexService.js")  // Services from cwd
      ];
      
      let importError = null;
      for (const importPath of possiblePaths) {
        try {
          // For ES modules, use file:// protocol for absolute paths
          const normalizedPath = importPath.startsWith(".") 
            ? importPath 
            : `file://${importPath}`;
          const vertexModule = await import(normalizedPath);
          generateImage = vertexModule.generateImage;
          if (generateImage) {
            console.log(`[Media API] Successfully imported vertexService from: ${importPath}`);
            break;
          }
        } catch (err) {
          importError = err;
          console.warn(`[Media API] Failed to import from ${importPath}:`, err.message);
          continue;
        }
      }
      
      if (!generateImage) {
        // Check if file exists in both root and services directory
        const rootPath = path.join(__dirname, "vertexService.js");
        const servicesPath = path.join(__dirname, "services", "vertexService.js");
        const rootExists = fs.existsSync(rootPath);
        const servicesExists = fs.existsSync(servicesPath);
        
        // List files in root directory
        let rootFiles = [];
        try {
          rootFiles = fs.readdirSync(__dirname).filter(f => f.endsWith('.js'));
        } catch (e) {
          rootFiles = [`Error reading directory: ${e.message}`];
        }
        
        // List files in services directory if it exists
        let servicesFiles = [];
        const servicesDir = path.join(__dirname, "services");
        if (fs.existsSync(servicesDir)) {
          try {
            servicesFiles = fs.readdirSync(servicesDir);
          } catch (e) {
            servicesFiles = [`Error reading directory: ${e.message}`];
          }
        }
        
        console.error(`[Media API] vertexService.js not found.`);
        console.error(`  Root path: ${rootPath}, Exists: ${rootExists}`);
        console.error(`  Services path: ${servicesPath}, Exists: ${servicesExists}`);
        console.error(`  Available JS files in root: ${rootFiles.join(", ")}`);
        console.error(`  Available files in services/: ${servicesFiles.join(", ")}`);
        console.error(`  Import error:`, importError?.message);
        console.error(`  __dirname: ${__dirname}`);
        console.error(`  process.cwd(): ${process.cwd()}`);
        
        return res.status(503).json({ 
          success: false, 
          error: "Vertex AI service not available. Please ensure vertexService.js is deployed (either in root or services/ directory).",
          details: importError?.message || "File not found",
          debug: {
            rootPath: rootPath,
            rootExists: rootExists,
            servicesPath: servicesPath,
            servicesExists: servicesExists,
            rootFiles: rootFiles,
            servicesFiles: servicesFiles,
            __dirname: __dirname,
            cwd: process.cwd()
          }
        });
      }
      
      const { mode, prompt, aspectRatio, productId, productQuery } = req.body;
      
      if (!mode || !prompt) {
        return res.status(400).json({ success: false, error: "Missing mode or prompt" });
      }
      
      if (mode !== "image") {
        return res.status(400).json({ success: false, error: "Only image mode supported in direct route" });
      }
      
      // Optional: Load product context if productId provided
      let productContext = null;
      if (productId || productQuery) {
        try {
          // Try both root and services directory for wooService
          let wooModule;
          try {
            wooModule = await import("./wooService.js");
          } catch (e) {
            wooModule = await import("./services/wooService.js");
          }
          
          const { findProduct, getProductSummary, isWooCommerceConfigured } = wooModule;
          if (isWooCommerceConfigured()) {
            const product = await findProduct(productId || productQuery);
            if (product) {
              productContext = getProductSummary(product);
            }
          }
        } catch (productErr) {
          console.warn("[Media API] Could not load product context:", productErr.message);
        }
      }
      
      const result = await generateImage(prompt, aspectRatio || "1:1", productContext);
      res.set({
        "Content-Type": result.mimeType,
        "Content-Length": result.buffer.length,
        "X-Model": result.model,
        "X-Mode": mode,
        "X-Source": "server.js-direct"
      });
      res.send(result.buffer);
    } catch (err) {
      console.error("[Media API] Direct route error:", err);
      console.error("[Media API] Error stack:", err.stack);
      res.status(500).json({ 
        success: false, 
        error: err.message || "Image generation failed",
        details: process.env.NODE_ENV === 'development' ? err.stack : undefined
      });
    }
  });
  
  console.log("✅ Media routes added directly");
  console.log("   - GET /api/media/test");
  console.log("   - POST /api/media/create");
}

// Load routes before starting server
const routesLoaded = await loadVertexRoutes();
if (!routesLoaded) {
  console.log("⚠️ Route file loading failed, using direct routes");
  addMediaRoutesDirectly();
} else {
  // Still add direct routes as backup (they won't conflict)
  console.log("✅ Route files loaded successfully");
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Backend on http://localhost:${PORT}`));
