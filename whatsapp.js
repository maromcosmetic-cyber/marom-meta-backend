import express from "express";
import axios from "axios";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Helper function to import vertexService with fallback paths
async function importVertexService() {
  const vertexPaths = [
    "../services/vertexService.js",
    "./services/vertexService.js",
    path.join(__dirname, "../services/vertexService.js"),
    path.join(__dirname, "../../services/vertexService.js"),
    path.join(process.cwd(), "services/vertexService.js")
  ];

  for (const vertexPath of vertexPaths) {
    try {
      // Check if file exists first
      const checkPath = vertexPath.startsWith(".") 
        ? path.resolve(__dirname, vertexPath)
        : vertexPath;
      
      if (fs.existsSync(checkPath)) {
        const normalizedPath = vertexPath.startsWith(".") 
          ? vertexPath 
          : `file://${vertexPath}`;
        const vertexService = await import(normalizedPath);
        if (vertexService.generateImage) {
          console.log(`[WhatsApp Routes] Loaded vertexService from: ${vertexPath}`);
          return vertexService;
        }
      }
    } catch (err) {
      continue;
    }
  }
  
  console.warn("[WhatsApp Routes] vertexService not found, image/video generation will be disabled");
  return { generateImage: null, editImage: null, generateVideo: null };
}

// Import vertexService (will be resolved when needed)
let vertexServiceModule = null;
const vertexServicePromise = importVertexService().then(module => {
  vertexServiceModule = module;
  return module;
});

// Lazy getters for vertexService functions
function getGenerateImage() {
  return vertexServiceModule?.generateImage || null;
}
function getEditImage() {
  return vertexServiceModule?.editImage || null;
}
function getGenerateVideo() {
  return vertexServiceModule?.generateVideo || null;
}

import { uploadWhatsAppMedia, sendWhatsAppImage, sendWhatsAppVideo, sendWhatsAppText } from "../services/whatsappService.js";
import { findProduct, getProductSummary, getProductPrimaryImage, getProductGallery, isWooCommerceConfigured } from "../services/wooService.js";

const router = express.Router();

/**
 * POST /webhooks/whatsapp
 * Handle incoming WhatsApp messages and process content creation commands
 * 
 * Commands:
 * - "image: <prompt> | ar=1:1" - Generate image
 * - "edit: <prompt> | url=<image_url> | mask=<mask_url>" - Edit image
 * - "video: <prompt> | ar=9:16 | dur=8" - Generate video
 */
router.post("/", async (req, res) => {
  try {
    const body = req.body;
    
    // Verify webhook signature (optional but recommended)
    // You can add signature verification here using req.headers['x-hub-signature-256']
    
    if (body.object === "whatsapp_business_account") {
      body.entry?.forEach((entry) => {
        entry.changes?.forEach((change) => {
          if (change.field === "messages") {
            const value = change.value;
            
            // Handle incoming messages
            if (value.messages) {
              value.messages.forEach(async (message) => {
                await handleIncomingMessage(message, value.contacts?.[0]);
              });
            }
            
            // Handle status updates
            if (value.statuses) {
              value.statuses.forEach((status) => {
                console.log(`[WhatsApp Webhook] Message ${status.id} status: ${status.status}`);
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
    console.error("[WhatsApp Webhook] Error:", err);
    res.status(500).send("Internal Server Error");
  }
});

/**
 * GET /webhooks/whatsapp
 * Webhook verification for WhatsApp
 */
router.get("/", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  
  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log("[WhatsApp Webhook] Verified");
    res.status(200).send(challenge);
  } else {
    console.log("[WhatsApp Webhook] Verification failed");
    res.status(403).send("Forbidden");
  }
});

// Store generated media for each user (for campaign use)
const generatedMediaStore = new Map(); // phone -> [{mediaId, buffer, mimeType, prompt, timestamp}]

/**
 * Handle incoming WhatsApp message
 */
async function handleIncomingMessage(message, contact) {
  const from = message.from;
  const messageText = message.text?.body || "";
  const messageType = message.type;
  
  console.log(`[WhatsApp Webhook] Received message from ${from}: ${messageText.substring(0, 100)}`);
  
  // Only process text messages
  if (messageType !== "text") {
    return;
  }
  
  // Check for action buttons (use in campaign, edit, regenerate)
  if (messageText.match(/^(use|edit|regenerate|make video)/i)) {
    await handleMediaAction(from, messageText);
    return false; // Handled, don't process further
  }
  
  // Parse command (both structured and natural language)
  const command = parseContentCommand(messageText);
  
  if (!command) {
    // Not a content creation command, let existing handler process it
    return null; // Return null to let main handler process
  }
  
  try {
    // Fetch product data if productId or productQuery provided
    let product = null;
    let productContext = null;
    let productCaption = "";
    let selectedImageUrl = command.productImageUrl;
    
    if (command.productId || command.productQuery) {
      if (!isWooCommerceConfigured()) {
        await sendWhatsAppText(from, "⚠️ I couldn't access the product catalog yet. Please set WC_API_URL, WC_API_KEY, and WC_API_SECRET.");
        return false;
      }
      
      try {
        product = await findProduct(command.productId || command.productQuery);
        
        if (!product) {
          await sendWhatsAppText(from, `❌ Product not found: ${command.productId || command.productQuery}\n\nTry searching with a different name or ID.`);
          return false;
        }
        
        // Get product summary for context
        productContext = getProductSummary(product);
        
        // Build caption with product info
        productCaption = `✅ Created with ${productContext.title}`;
        if (productContext.permalink) {
          productCaption += ` — ${productContext.permalink}`;
        }
        
        // For edit mode, select image source
        if (command.mode === "edit" && !selectedImageUrl) {
          const primaryImage = getProductPrimaryImage(product);
          if (primaryImage) {
            selectedImageUrl = primaryImage;
          } else if (command.useGallery) {
            const gallery = getProductGallery(product);
            if (gallery.length > 0) {
              selectedImageUrl = gallery[0];
            }
          }
          
          if (!selectedImageUrl) {
            await sendWhatsAppText(from, "❌ No product image available. Please provide url=<image_url> or ensure product has images.");
            return false;
          }
        }
        
        console.log(`[WhatsApp Webhook] Product loaded: ${productContext.title} (ID: ${product.id})`);
      } catch (err) {
        console.error("[WhatsApp Webhook] Error fetching product:", err.message);
        await sendWhatsAppText(from, `❌ Failed to fetch product: ${err.message}`);
        return false;
      }
    }
    
    // Send acknowledgment
    const modeText = command.mode === "video" ? "video (this may take 1-2 minutes)" : command.mode;
    await sendWhatsAppText(from, `🎨 Creating ${modeText}... Please wait!`);
    
    let result;
    
    // Generate media based on command with product context
    switch (command.mode) {
      case "image":
        // Ensure vertexService is loaded
        await vertexServicePromise;
        const generateImage = getGenerateImage();
        if (!generateImage) {
          throw new Error("Image generation not available. vertexService.js not found.");
        }
        result = await generateImage(command.prompt, command.aspectRatio || "1:1", productContext);
        break;
        
      case "edit":
        if (!selectedImageUrl) {
          await sendWhatsAppText(from, "❌ I need an image URL to edit. Please provide: edit: <instruction> | url=<image_url> or | product=<id>");
          return false;
        }
        // Ensure vertexService is loaded
        await vertexServicePromise;
        const editImage = getEditImage();
        if (!editImage) {
          throw new Error("Image editing not available. vertexService.js not found.");
        }
        result = await editImage(command.prompt, selectedImageUrl, command.maskPngUrl);
        break;
        
      case "video":
        // Ensure vertexService is loaded
        await vertexServicePromise;
        const generateVideo = getGenerateVideo();
        if (!generateVideo) {
          throw new Error("Video generation not available. vertexService.js not found.");
        }
        result = await generateVideo(command.prompt, command.aspectRatio || "16:9", command.durationSec || 8, productContext);
        break;
        
      default:
        await sendWhatsAppText(from, `❌ Unknown mode: ${command.mode}`);
        return false;
    }
    
    // Upload to WhatsApp
    const mediaId = await uploadWhatsAppMedia(result.buffer, result.mimeType);
    
    // Store media for later use
    if (!generatedMediaStore.has(from)) {
      generatedMediaStore.set(from, []);
    }
    const mediaStore = generatedMediaStore.get(from);
    mediaStore.push({
      mediaId,
      buffer: result.buffer,
      mimeType: result.mimeType,
      prompt: command.prompt,
      mode: command.mode,
      aspectRatio: command.aspectRatio,
      productContext: productContext,
      timestamp: Date.now()
    });
    // Keep only last 10
    if (mediaStore.length > 10) {
      mediaStore.shift();
    }
    
    // Build caption with product info if available
    let caption = `✨ ${command.mode === "video" ? "Video" : "Image"} generated!`;
    if (productCaption) {
      caption += `\n\n${productCaption}`;
    }
    caption += `\n\n💡 Reply with:\n• "use" - Use in campaign`;
    if (command.mode === "image") {
      caption += `\n• "edit" - Edit this image\n• "make video" - Create video version`;
    }
    caption += `\n• "regenerate" - Create another`;
    
    // Send media message with options
    if (result.mimeType.includes("video")) {
      await sendWhatsAppVideo(from, mediaId, caption);
      // Send product link as follow-up text if available (WhatsApp video caption limits)
      if (productCaption && productContext?.permalink) {
        await sendWhatsAppText(from, productCaption);
      }
    } else {
      await sendWhatsAppImage(from, mediaId, caption);
    }
    
    console.log(`[WhatsApp Webhook] Successfully sent ${command.mode} to ${from}${productContext ? ` (product: ${productContext.title})` : ""}`);
    return false; // Content generated, handled
    
  } catch (err) {
    console.error(`[WhatsApp Webhook] Error processing command:`, err);
    await sendWhatsAppText(from, `❌ Error: ${err.message || "Failed to generate media"}\n\nTry again or use: image: <prompt> | product=123 or video: <prompt> | find="product name"`);
    return false; // Error handled
  }
}

/**
 * Handle media actions (use, edit, regenerate)
 */
async function handleMediaAction(from, actionText) {
  const lowerAction = actionText.toLowerCase();
  const mediaStore = generatedMediaStore.get(from);
  
  if (!mediaStore || mediaStore.length === 0) {
    await sendWhatsAppText(from, "❌ No recent media found. Generate an image or video first!");
    return;
  }
  
  const lastMedia = mediaStore[mediaStore.length - 1];
  
  if (lowerAction.includes("use")) {
    // Use in campaign - store media info for campaign creation
    await sendWhatsAppText(from, `✅ Perfect! I've saved this ${lastMedia.mode} for your campaign.\n\n📦 Media ID: ${lastMedia.mediaId}\n📝 Prompt: "${lastMedia.prompt}"\n📐 Aspect: ${lastMedia.aspectRatio || "default"}\n\n💡 You can now:\n• Create a campaign with this media\n• Use /createad <product> to create an ad\n• Or ask me to help create a campaign!`);
  } else if (lowerAction.includes("edit")) {
    await sendWhatsAppText(from, `✏️ To edit this ${lastMedia.mode}, send:\n\n"edit: <your instruction> | url=<image_url>"\n\nOr describe what you want to change!`);
  } else if (lowerAction.includes("regenerate")) {
    await sendWhatsAppText(from, `🔄 Regenerating...`);
    const command = {
      mode: lastMedia.mode,
      prompt: lastMedia.prompt,
      aspectRatio: lastMedia.aspectRatio || (lastMedia.mode === "video" ? "16:9" : "1:1"),
      durationSec: 5
    };
    await handleIncomingMessage({ from, text: { body: `${command.mode}: ${command.prompt}` }, type: "text" }, null);
  } else if (lowerAction.includes("video") || lowerAction.includes("make video")) {
    // Convert image to video
    await sendWhatsAppText(from, `🎬 Creating video version...`);
    const command = {
      mode: "video",
      prompt: `Animated version of: ${lastMedia.prompt}`,
      aspectRatio: lastMedia.aspectRatio || "16:9",
      durationSec: 5
    };
    await handleIncomingMessage({ from, text: { body: `video: ${command.prompt}` }, type: "text" }, null);
  }
}

/**
 * Parse content creation command from message text (supports both structured and natural language)
 * @param {string} text - Message text
 * @returns {object|null} - Parsed command or null
 */
function parseContentCommand(text) {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  
  // Structured commands (image:, video:, edit:) with product support
  // image: <prompt> | product=123 | ar=1:1
  // image: <prompt> | find="moringa shampoo" | ar=1:1
  const imageMatch = trimmed.match(/^image:\s*(.+?)(?:\s*\|\s*(?:product=(\d+)|find="([^"]+)"|ar=([^\s|]+)))+/i);
  if (imageMatch) {
    const fullMatch = trimmed.match(/^image:\s*(.+?)(?:\s*\|\s*(.+))?$/i);
    if (fullMatch) {
      const prompt = fullMatch[1].trim();
      const params = fullMatch[2] || "";
      
      const productIdMatch = params.match(/product=(\d+)/i);
      const findMatch = params.match(/find="([^"]+)"/i);
      const arMatch = params.match(/ar=([^\s|]+)/i);
      
      return {
        mode: "image",
        prompt: prompt,
        productId: productIdMatch ? parseInt(productIdMatch[1]) : undefined,
        productQuery: findMatch ? findMatch[1] : undefined,
        aspectRatio: arMatch ? arMatch[1] : "1:1"
      };
    }
  }
  
  // edit: <prompt> | product=123 [| mask=<url>]
  // edit: <prompt> | find="moringa shampoo" [| mask=<url>]
  // edit: <prompt> | url=<image_url> [| mask=<url>]
  const editMatch = trimmed.match(/^edit:\s*(.+?)(?:\s*\|\s*(.+))?/i);
  if (editMatch) {
    const prompt = editMatch[1].trim();
    const params = editMatch[2] || "";
    
    const productIdMatch = params.match(/product=(\d+)/i);
    const findMatch = params.match(/find="([^"]+)"/i);
    const urlMatch = params.match(/url=([^\s|]+)/i);
    const maskMatch = params.match(/mask=([^\s|]+)/i);
    
    return {
      mode: "edit",
      prompt: prompt,
      productId: productIdMatch ? parseInt(productIdMatch[1]) : undefined,
      productQuery: findMatch ? findMatch[1] : undefined,
      productImageUrl: urlMatch ? urlMatch[1] : undefined,
      maskPngUrl: maskMatch ? maskMatch[1] : undefined,
      useGallery: !!(productIdMatch || findMatch) // Use gallery if product specified
    };
  }
  
  // video: <prompt> | product=123 | ar=9:16 | dur=6
  // video: <prompt> | find="moringa shampoo" | ar=9:16 | dur=6
  const videoMatch = trimmed.match(/^video:\s*(.+?)(?:\s*\|\s*(.+))?/i);
  if (videoMatch) {
    const prompt = videoMatch[1].trim();
    const params = videoMatch[2] || "";
    
    const productIdMatch = params.match(/product=(\d+)/i);
    const findMatch = params.match(/find="([^"]+)"/i);
    const arMatch = params.match(/ar=([^\s|]+)/i);
    const durMatch = params.match(/dur=(\d+)/i);
    
    return {
      mode: "video",
      prompt: prompt,
      productId: productIdMatch ? parseInt(productIdMatch[1]) : undefined,
      productQuery: findMatch ? findMatch[1] : undefined,
      aspectRatio: arMatch ? arMatch[1] : "16:9",
      durationSec: durMatch ? parseInt(durMatch[1]) : 8
    };
  }
  
  // Natural language detection for image generation
  const imageKeywords = /(create|generate|make|show me|i need|i want).*(image|photo|picture|visual|graphic)/i;
  const videoKeywords = /(create|generate|make|show me|i need|i want).*(video|video clip|motion|animated|moving)/i;
  const editKeywords = /(edit|change|modify|update|adjust|fix|improve).*(image|photo|picture|this|that|it)/i;
  
  if (imageKeywords.test(trimmed) && !videoKeywords.test(trimmed)) {
    // Extract prompt (remove command words)
    const prompt = trimmed
      .replace(/(create|generate|make|show me|i need|i want|an?|the)\s+/gi, "")
      .replace(/\s*(image|photo|picture|visual|graphic|of|for)\s*/gi, " ")
      .trim();
    
    if (prompt.length > 5) {
      // Detect aspect ratio from context
      let aspectRatio = "1:1";
      if (lower.includes("square") || lower.includes("1:1")) aspectRatio = "1:1";
      else if (lower.includes("landscape") || lower.includes("16:9") || lower.includes("wide")) aspectRatio = "16:9";
      else if (lower.includes("portrait") || lower.includes("9:16") || lower.includes("story") || lower.includes("vertical")) aspectRatio = "9:16";
      
      return {
        mode: "image",
        prompt: prompt,
        aspectRatio: aspectRatio
      };
    }
  }
  
  if (videoKeywords.test(trimmed)) {
    const prompt = trimmed
      .replace(/(create|generate|make|show me|i need|i want|an?|the)\s+/gi, "")
      .replace(/\s*(video|video clip|motion|animated|moving|of|for)\s*/gi, " ")
      .trim();
    
    if (prompt.length > 5) {
      let aspectRatio = "16:9";
      let durationSec = 5;
      
      if (lower.includes("portrait") || lower.includes("9:16") || lower.includes("story")) aspectRatio = "9:16";
      if (lower.includes("landscape") || lower.includes("16:9")) aspectRatio = "16:9";
      
      const durationMatch = trimmed.match(/(\d+)\s*(second|sec|s)/i);
      if (durationMatch) {
        durationSec = Math.min(Math.max(parseInt(durationMatch[1]), 5), 60);
      }
      
      return {
        mode: "video",
        prompt: prompt,
        aspectRatio: aspectRatio,
        durationSec: durationSec
      };
    }
  }
  
  if (editKeywords.test(trimmed)) {
    const prompt = trimmed
      .replace(/(edit|change|modify|update|adjust|fix|improve)\s+/gi, "")
      .replace(/\s*(image|photo|picture|this|that|it|the)\s*/gi, " ")
      .trim();
    
    if (prompt.length > 3) {
      return {
        mode: "edit",
        prompt: prompt,
        productImageUrl: null, // Will need to be provided or use last image
        maskPngUrl: null
      };
    }
  }
  
  return null;
}

// Export for use in main server
export { handleIncomingMessage, generatedMediaStore };

export default router;

