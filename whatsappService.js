import axios from "axios";
import FormData from "form-data";

/**
 * WhatsApp Service for Media Upload and Messaging
 */

const GRAPH = "https://graph.facebook.com/v24.0";
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;

/**
 * Upload media buffer to WhatsApp
 * @param {Buffer} mediaBuffer - Media file buffer
 * @param {string} mimeType - MIME type (image/png, video/mp4, etc.)
 * @returns {Promise<string>} - Media ID
 */
export async function uploadWhatsAppMedia(mediaBuffer, mimeType) {
  if (!WHATSAPP_PHONE_NUMBER_ID || !WHATSAPP_ACCESS_TOKEN) {
    throw new Error("WhatsApp credentials not configured");
  }
  
  const form = new FormData();
  const extension = mimeType.includes("video") ? "mp4" : mimeType.includes("png") ? "png" : "jpg";
  const filename = `media.${extension}`;
  
  form.append("file", mediaBuffer, {
    filename: filename,
    contentType: mimeType
  });
  
  form.append("type", mimeType.includes("video") ? "video" : "image");
  form.append("messaging_product", "whatsapp");
  
  try {
    console.log(`[WhatsApp] Uploading media (${mediaBuffer.length} bytes, ${mimeType})`);
    
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
        timeout: 60000
      }
    );
    
    const mediaId = response.data.id;
    console.log(`[WhatsApp] Media uploaded successfully: ${mediaId}`);
    
    return mediaId;
  } catch (err) {
    console.error("[WhatsApp] Media upload error:", err.response?.data || err.message);
    throw new Error(`Failed to upload media to WhatsApp: ${err.message}`);
  }
}

/**
 * Send image message via WhatsApp
 * @param {string} to - Recipient phone number
 * @param {string} mediaId - Media ID from upload
 * @param {string} caption - Optional caption
 * @returns {Promise<object>}
 */
export async function sendWhatsAppImage(to, mediaId, caption = "") {
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
          ...(caption && { caption: caption.substring(0, 1024) })
        }
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );
    
    return response.data;
  } catch (err) {
    console.error("[WhatsApp] Error sending image:", err.response?.data || err.message);
    throw new Error(`Failed to send image: ${err.message}`);
  }
}

/**
 * Send video message via WhatsApp
 * @param {string} to - Recipient phone number
 * @param {string} mediaId - Media ID from upload
 * @param {string} caption - Optional caption
 * @returns {Promise<object>}
 */
export async function sendWhatsAppVideo(to, mediaId, caption = "") {
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
        type: "video",
        video: {
          id: mediaId,
          ...(caption && { caption: caption.substring(0, 1024) })
        }
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );
    
    return response.data;
  } catch (err) {
    console.error("[WhatsApp] Error sending video:", err.response?.data || err.message);
    throw new Error(`Failed to send video: ${err.message}`);
  }
}

/**
 * Send text message via WhatsApp
 * @param {string} to - Recipient phone number
 * @param {string} text - Message text
 * @returns {Promise<object>}
 */
export async function sendWhatsAppText(to, text) {
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
    
    return response.data;
  } catch (err) {
    console.error("[WhatsApp] Error sending text:", err.response?.data || err.message);
    throw new Error(`Failed to send text: ${err.message}`);
  }
}

