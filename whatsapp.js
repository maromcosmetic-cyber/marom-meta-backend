import express from "express";
import axios from "axios";
import { generateImage, editImage, generateVideo } from "../services/vertexService.js";
import { uploadWhatsAppMedia, sendWhatsAppImage, sendWhatsAppVideo, sendWhatsAppText } from "../services/whatsappService.js";

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
  
  // Parse command
  const command = parseContentCommand(messageText);
  
  if (!command) {
    // Not a content creation command, ignore or forward to existing handler
    return;
  }
  
  try {
    // Send acknowledgment
    await sendWhatsAppText(from, `🔄 Creating ${command.mode}... This may take a moment.`);
    
    let result;
    
    // Generate media based on command
    switch (command.mode) {
      case "image":
        result = await generateImage(command.prompt, command.aspectRatio || "1:1");
        break;
        
      case "edit":
        if (!command.productImageUrl) {
          await sendWhatsAppText(from, "❌ Edit command requires an image URL. Use: edit: <prompt> | url=<image_url>");
          return;
        }
        result = await editImage(command.prompt, command.productImageUrl, command.maskPngUrl);
        break;
        
      case "video":
        result = await generateVideo(command.prompt, command.aspectRatio || "16:9", command.durationSec || 5);
        break;
        
      default:
        await sendWhatsAppText(from, `❌ Unknown mode: ${command.mode}`);
        return;
    }
    
    // Upload to WhatsApp
    const mediaId = await uploadWhatsAppMedia(result.buffer, result.mimeType);
    
    // Send media message
    if (result.mimeType.includes("video")) {
      await sendWhatsAppVideo(from, mediaId, `✨ Generated with ${result.model}`);
    } else {
      await sendWhatsAppImage(from, mediaId, `✨ Generated with ${result.model}`);
    }
    
    console.log(`[WhatsApp Webhook] Successfully sent ${command.mode} to ${from}`);
    
  } catch (err) {
    console.error(`[WhatsApp Webhook] Error processing command:`, err);
    await sendWhatsAppText(from, `❌ Error: ${err.message || "Failed to generate media"}`);
  }
}

/**
 * Parse content creation command from message text
 * @param {string} text - Message text
 * @returns {object|null} - Parsed command or null
 */
function parseContentCommand(text) {
  const trimmed = text.trim();
  
  // Match: "image: <prompt> | ar=1:1"
  const imageMatch = trimmed.match(/^image:\s*(.+?)(?:\s*\|\s*ar=([^\s|]+))?$/i);
  if (imageMatch) {
    return {
      mode: "image",
      prompt: imageMatch[1].trim(),
      aspectRatio: imageMatch[2] || "1:1"
    };
  }
  
  // Match: "edit: <prompt> | url=<url> | mask=<mask_url>"
  const editMatch = trimmed.match(/^edit:\s*(.+?)(?:\s*\|\s*(?:url=([^\s|]+)|mask=([^\s|]+)))+/i);
  if (editMatch) {
    const fullMatch = trimmed.match(/^edit:\s*(.+?)(?:\s*\|\s*(?:url=([^\s|]+))?(?:\s*\|\s*mask=([^\s|]+))?)?/i);
    return {
      mode: "edit",
      prompt: fullMatch[1].trim(),
      productImageUrl: fullMatch[2] || null,
      maskPngUrl: fullMatch[3] || null
    };
  }
  
  // Match: "video: <prompt> | ar=9:16 | dur=8"
  const videoMatch = trimmed.match(/^video:\s*(.+?)(?:\s*\|\s*ar=([^\s|]+))?(?:\s*\|\s*dur=(\d+))?/i);
  if (videoMatch) {
    return {
      mode: "video",
      prompt: videoMatch[1].trim(),
      aspectRatio: videoMatch[2] || "16:9",
      durationSec: videoMatch[3] ? parseInt(videoMatch[3]) : 5
    };
  }
  
  return null;
}

export default router;

