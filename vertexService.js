import axios from "axios";
import { GoogleAuth } from "google-auth-library";

/**
 * Vertex AI Service for Image and Video Generation
 * Uses Imagen 3 for images and Veo 3 for videos
 */

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || "marom-api";

// Validate location - Vertex AI requires a specific region, not "global"
let LOCATION = process.env.GOOGLE_CLOUD_LOCATION || "us-central1";
const VALID_LOCATIONS = [
  "us-central1", "us-east1", "us-east4", "us-west1", "us-west2", "us-west3", "us-west4",
  "europe-west1", "europe-west2", "europe-west3", "europe-west4", "europe-west6", "europe-west8", "europe-west9",
  "asia-east1", "asia-northeast1", "asia-northeast2", "asia-northeast3", "asia-south1", "asia-southeast1",
  "australia-southeast1", "northamerica-northeast1", "southamerica-east1"
];

// Normalize location (remove trailing slashes, convert to lowercase)
LOCATION = LOCATION.trim().toLowerCase().replace(/\/$/, "");

// Check if location is invalid
if (LOCATION === "global" || !VALID_LOCATIONS.includes(LOCATION)) {
  console.warn(`[Vertex] Invalid location "${LOCATION}". Using default "us-central1". Valid locations: ${VALID_LOCATIONS.join(", ")}`);
  LOCATION = "us-central1";
}

const VERTEX_API_BASE = `https://${LOCATION}-aiplatform.googleapis.com/v1`;

/**
 * Generate image using Imagen 3
 * @param {string} prompt - Text prompt for image generation
 * @param {string} aspectRatio - Aspect ratio (1:1, 16:9, 9:16)
 * @param {object} productContext - Optional product context {title, shortDesc, ingredients}
 * @returns {Promise<{buffer: Buffer, mimeType: string, model: string}>}
 */
export async function generateImage(prompt, aspectRatio = "1:1", productContext = null) {
  try {
    // Validate input prompt
    if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
      throw new Error("Prompt cannot be empty");
    }
    
    // Enrich prompt with product context if provided
    let enrichedPrompt = prompt.trim();
    if (productContext) {
      const contextParts = [];
      if (productContext.title) {
        contextParts.push(`Product: ${productContext.title}`);
      }
      if (productContext.shortDesc) {
        const desc = productContext.shortDesc.substring(0, 140);
        contextParts.push(`Key points: ${desc}`);
      }
      if (productContext.ingredients) {
        contextParts.push(`Ingredients: ${productContext.ingredients.substring(0, 100)}`);
      }
      contextParts.push("Brand: Marom");
      
      const contextLine = contextParts.join(". ");
      enrichedPrompt = `${contextLine}. ${enrichedPrompt}`;
    }
    
    // Limit prompt length
    if (enrichedPrompt.length > 4000) {
      console.warn(`[Vertex] Prompt is very long (${enrichedPrompt.length} chars), truncating to 4000`);
      enrichedPrompt = enrichedPrompt.substring(0, 4000);
    }
    
    console.log(`[Vertex] Generating image with Imagen 3: "${enrichedPrompt.substring(0, 100)}..."`);
    console.log(`[Vertex] Prompt length: ${enrichedPrompt.length} characters`);
    
    // Map aspect ratio to Imagen format
    const aspectRatioMap = {
      "1:1": "1:1",
      "16:9": "16:9",
      "9:16": "9:16"
    };
    const ratio = aspectRatioMap[aspectRatio] || "1:1";
    
    // Use Vertex AI Imagen 3 endpoint (REST API)
    const endpoint = `${VERTEX_API_BASE}/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/imagegeneration@006:predict`;
    
    // Build request body - Vertex AI Imagen API format
    // Note: The API format may vary - try different structures if 400 error occurs
    const requestBody = {
      instances: [{
        prompt: enrichedPrompt
      }],
      parameters: {
        sampleCount: 1,
        aspectRatio: ratio,
        safetyFilterLevel: "block_some"
        // Note: personGeneration removed - "allow_all" is not available for this project
        // If you need person generation, configure it in Google Cloud Console safety settings
      }
    };
    
    // Log request for debugging
    console.log(`[Vertex] Project: ${PROJECT_ID}, Location: ${LOCATION}`);
    console.log(`[Vertex] Endpoint: ${endpoint}`);
    console.log(`[Vertex] Request body preview:`, JSON.stringify({
      instances: [{
        prompt: enrichedPrompt.substring(0, 100) + "..."
      }],
      parameters: requestBody.parameters
    }, null, 2));
    
    // Get access token for Vertex AI
    const accessToken = await getAccessToken();
    
    console.log(`[Vertex] Full request endpoint: ${endpoint}`);
    console.log(`[Vertex] Full request body:`, JSON.stringify(requestBody, null, 2));
    
    const response = await axios.post(endpoint, requestBody, {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      timeout: 120000, // 2 minutes for image generation
      validateStatus: function (status) {
        return status < 500; // Don't throw on 4xx errors, we'll handle them
      }
    });
    
    // Check for errors in response
    if (response.status >= 400) {
      console.error(`[Vertex] API returned error status: ${response.status}`);
      console.error(`[Vertex] Error response:`, JSON.stringify(response.data, null, 2));
      
      const errorDetails = response.data?.error || response.data;
      let errorMessage = `HTTP ${response.status}: ${response.statusText}`;
      
      if (errorDetails) {
        if (typeof errorDetails === 'string') {
          errorMessage = errorDetails;
        } else if (errorDetails.message) {
          errorMessage = errorDetails.message;
        } else if (errorDetails.details) {
          errorMessage = JSON.stringify(errorDetails.details);
        } else {
          errorMessage = JSON.stringify(errorDetails);
        }
      }
      
      throw new Error(`Vertex AI API error: ${errorMessage}`);
    }
    
    if (!response.data?.predictions || response.data.predictions.length === 0) {
      console.error("[Vertex] No predictions in response:", response.data);
      throw new Error("No image generated from Imagen 3 - empty predictions array");
    }
    
    const imageBase64 = response.data.predictions[0].bytesBase64Encoded;
    if (!imageBase64) {
      console.error("[Vertex] No bytesBase64Encoded in prediction:", response.data.predictions[0]);
      throw new Error("Image data not found in response - missing bytesBase64Encoded");
    }
    
    const imageBuffer = Buffer.from(imageBase64, "base64");
    
    console.log(`[Vertex] Image generated successfully (${imageBuffer.length} bytes)`);
    
    return {
      buffer: imageBuffer,
      mimeType: "image/png",
      model: "imagen-3"
    };
  } catch (err) {
    console.error("[Vertex] Image generation error:", err.message);
    if (err.response) {
      console.error("[Vertex] Response status:", err.response.status);
      console.error("[Vertex] Response headers:", err.response.headers);
      console.error("[Vertex] Response data:", JSON.stringify(err.response.data, null, 2));
      
      const errorDetails = err.response.data?.error || err.response.data;
      let errorMessage = `HTTP ${err.response.status}: ${err.response.statusText}`;
      
      if (errorDetails) {
        if (typeof errorDetails === 'string') {
          errorMessage = errorDetails;
        } else if (errorDetails.message) {
          errorMessage = errorDetails.message;
        } else if (errorDetails.details) {
          errorMessage = JSON.stringify(errorDetails.details);
        } else {
          errorMessage = JSON.stringify(errorDetails);
        }
      }
      
      throw new Error(`Image generation failed: ${errorMessage}`);
    }
    throw new Error(`Image generation failed: ${err.message}`);
  }
}

/**
 * Edit image using Imagen 3 (inpainting or variation)
 * @param {string} prompt - Edit instruction
 * @param {string} productImageUrl - URL of the product image
 * @param {string} maskPngUrl - Optional mask URL for inpainting
 * @returns {Promise<{buffer: Buffer, mimeType: string, model: string}>}
 */
export async function editImage(prompt, productImageUrl, maskPngUrl = null) {
  try {
    console.log(`[Vertex] Editing image: "${prompt.substring(0, 50)}..."`);
    
    // Download product image
    const imageResponse = await axios.get(productImageUrl, { responseType: "arraybuffer" });
    const imageBuffer = Buffer.from(imageResponse.data);
    const imageBase64 = imageBuffer.toString("base64");
    
    let maskBase64 = null;
    if (maskPngUrl) {
      // Download mask if provided
      const maskResponse = await axios.get(maskPngUrl, { responseType: "arraybuffer" });
      const maskBuffer = Buffer.from(maskResponse.data);
      maskBase64 = maskBuffer.toString("base64");
    }
    
    const endpoint = `${VERTEX_API_BASE}/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/imagegeneration@006:predict`;
    
    const requestBody = {
      instances: [{
        prompt: prompt,
        image: {
          bytesBase64Encoded: imageBase64
        },
        ...(maskBase64 && {
          mask: {
            bytesBase64Encoded: maskBase64
          }
        })
      }],
      parameters: {
        sampleCount: 1,
        safetyFilterLevel: "block_some"
        // Note: personGeneration removed - "allow_all" is not available for this project
        // If you need person generation, configure it in Google Cloud Console safety settings
      }
    };
    
    const accessToken = await getAccessToken();
    
    const response = await axios.post(endpoint, requestBody, {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      timeout: 120000
    });
    
    if (!response.data?.predictions || response.data.predictions.length === 0) {
      throw new Error("No edited image generated");
    }
    
    const editedImageBase64 = response.data.predictions[0].bytesBase64Encoded;
    const editedImageBuffer = Buffer.from(editedImageBase64, "base64");
    
    console.log(`[Vertex] Image edited successfully (${editedImageBuffer.length} bytes)`);
    
    return {
      buffer: editedImageBuffer,
      mimeType: "image/png",
      model: "imagen-3"
    };
  } catch (err) {
    console.error("[Vertex] Image editing error:", err.response?.data || err.message);
    throw new Error(`Image editing failed: ${err.message}`);
  }
}

/**
 * Generate video using Veo 3
 * @param {string} prompt - Text prompt for video generation
 * @param {string} aspectRatio - Aspect ratio (16:9, 9:16)
 * @param {number} durationSec - Duration in seconds
 * @param {object} productContext - Optional product context {title, shortDesc, ingredients}
 * @returns {Promise<{buffer: Buffer, mimeType: string, model: string}>}
 */
export async function generateVideo(prompt, aspectRatio = "16:9", durationSec = 5, productContext = null) {
  try {
    // Enrich prompt with product context for UGC-style videos
    let enrichedPrompt = prompt;
    if (productContext) {
      const contextParts = [];
      if (productContext.title) {
        contextParts.push(`Featuring: ${productContext.title}`);
      }
      if (productContext.shortDesc) {
        const desc = productContext.shortDesc.substring(0, 100);
        contextParts.push(`Product highlights: ${desc}`);
      }
      contextParts.push("Brand: Marom");
      contextParts.push("UGC style, authentic user-generated content feel");
      
      const contextLine = contextParts.join(". ");
      enrichedPrompt = `${contextLine}. ${prompt}`;
    }
    
    console.log(`[Vertex] Generating video with Veo 3: "${enrichedPrompt.substring(0, 50)}..." (${durationSec}s)`);
    
    // Use Veo 3 Fast for shorter videos, Veo 3 for longer
    const modelName = durationSec <= 5 ? "veo-3-fast" : "veo-3";
    
    // Vertex AI Veo API endpoint (correct structure)
    const endpoint = `${VERTEX_API_BASE}/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/${modelName}:predict`;
    
    // Default duration to 8 seconds if not specified
    const finalDuration = durationSec || 8;
    
    const requestBody = {
      instances: [{
        prompt: enrichedPrompt
      }],
      parameters: {
        aspectRatio: aspectRatio,
        durationSeconds: Math.min(Math.max(finalDuration, 5), 60), // Clamp between 5-60 seconds
        safetyFilterLevel: "block_some"
      }
    };
    
    const accessToken = await getAccessToken();
    
    // Start video generation job (Veo uses async job pattern)
    const response = await axios.post(endpoint, requestBody, {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      timeout: 30000
    });
    
    // Check response structure - Veo may return job name or direct response
    let jobName = null;
    
    if (response.data?.name) {
      // Async job pattern
      jobName = response.data.name;
      console.log(`[Vertex] Video generation job started: ${jobName}`);
      
      // Poll for completion
      const videoBuffer = await pollVideoJob(jobName, accessToken);
      
      console.log(`[Vertex] Video generated successfully (${videoBuffer.length} bytes)`);
      
      return {
        buffer: videoBuffer,
        mimeType: "video/mp4",
        model: modelName
      };
    } else if (response.data?.predictions && response.data.predictions[0]?.bytesBase64Encoded) {
      // Direct response (synchronous)
      const videoBase64 = response.data.predictions[0].bytesBase64Encoded;
      const videoBuffer = Buffer.from(videoBase64, "base64");
      
      console.log(`[Vertex] Video generated successfully (${videoBuffer.length} bytes)`);
      
      return {
        buffer: videoBuffer,
        mimeType: "video/mp4",
        model: modelName
      };
    } else if (response.data?.response?.videoUri) {
      // Video URI in response
      const videoUrl = response.data.response.videoUri;
      const videoResponse = await axios.get(videoUrl, { responseType: "arraybuffer" });
      const videoBuffer = Buffer.from(videoResponse.data);
      
      console.log(`[Vertex] Video generated successfully (${videoBuffer.length} bytes)`);
      
      return {
        buffer: videoBuffer,
        mimeType: "video/mp4",
        model: modelName
      };
    } else {
      // Try alternative endpoint structure for Veo
      console.log("[Vertex] Trying alternative Veo endpoint structure...");
      throw new Error("Video generation job not started - unexpected response format");
    }
  } catch (err) {
    console.error("[Vertex] Video generation error:", err.response?.data || err.message);
    
    // Provide more helpful error message
    if (err.response?.status === 404) {
      throw new Error("Veo model not available. Check Vertex AI model availability.");
    } else if (err.response?.status === 403) {
      throw new Error("Permission denied. Check Vertex AI API permissions.");
    }
    
    throw new Error(`Video generation failed: ${err.message}`);
  }
}

/**
 * Poll video generation job until completion
 * @param {string} jobName - Job name from initial request
 * @param {string} accessToken - OAuth access token
 * @returns {Promise<Buffer>}
 */
async function pollVideoJob(jobName, accessToken, maxAttempts = 60, intervalMs = 5000) {
  const pollEndpoint = `${VERTEX_API_BASE}/${jobName}`;
  
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const response = await axios.get(pollEndpoint, {
        headers: {
          "Authorization": `Bearer ${accessToken}`
        }
      });
      
      const state = response.data?.state;
      
      if (state === "JOB_STATE_SUCCEEDED") {
        // Fetch the video
        const videoUrl = response.data?.response?.videoUri;
        if (!videoUrl) {
          throw new Error("Video URI not found in job response");
        }
        
        const videoResponse = await axios.get(videoUrl, { responseType: "arraybuffer" });
        return Buffer.from(videoResponse.data);
      } else if (state === "JOB_STATE_FAILED") {
        const error = response.data?.error || "Unknown error";
        throw new Error(`Video generation failed: ${JSON.stringify(error)}`);
      } else if (state === "JOB_STATE_CANCELLED") {
        throw new Error("Video generation was cancelled");
      }
      
      // Still processing
      console.log(`[Vertex] Video job ${jobName} state: ${state} (attempt ${attempt + 1}/${maxAttempts})`);
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    } catch (err) {
      if (err.response?.status === 404 && attempt < 2) {
        // Job might not be immediately available, wait a bit
        await new Promise(resolve => setTimeout(resolve, intervalMs));
        continue;
      }
      throw err;
    }
  }
  
  throw new Error(`Video generation timed out after ${maxAttempts} attempts`);
}

/**
 * Get OAuth access token for Vertex AI
 * Uses Application Default Credentials
 * @returns {Promise<string>}
 */
async function getAccessToken() {
  try {
    // For Vertex AI, we need to use Application Default Credentials
    // Supports both file path (GOOGLE_APPLICATION_CREDENTIALS) and env vars (GOOGLE_PRIVATE_KEY + GOOGLE_CLIENT_EMAIL)
    const { GoogleAuth } = await import("google-auth-library");
    
    const authConfig = {
      scopes: ["https://www.googleapis.com/auth/cloud-platform"]
    };
    
    // If GOOGLE_APPLICATION_CREDENTIALS is set (file path), use it
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      authConfig.keyFilename = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    } 
    // If using individual env vars, create credentials object
    else if (process.env.GOOGLE_PRIVATE_KEY && process.env.GOOGLE_CLIENT_EMAIL) {
      authConfig.credentials = {
        type: "service_account",
        project_id: process.env.GOOGLE_CLOUD_PROJECT || PROJECT_ID,
        private_key_id: process.env.GOOGLE_PRIVATE_KEY_ID || "",
        private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        client_id: process.env.GOOGLE_CLIENT_ID || "",
        auth_uri: "https://accounts.google.com/o/oauth2/auth",
        token_uri: "https://oauth2.googleapis.com/token",
        auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
        client_x509_cert_url: `https://www.googleapis.com/robot/v1/metadata/x509/${encodeURIComponent(process.env.GOOGLE_CLIENT_EMAIL)}`
      };
    }
    // Otherwise, GoogleAuth will try to use default credentials
    
    const auth = new GoogleAuth(authConfig);
    const client = await auth.getClient();
    const accessToken = await client.getAccessToken();
    
    return accessToken.token;
  } catch (err) {
    console.error("[Vertex] Error getting access token:", err.message);
    throw new Error(`Failed to authenticate with Vertex AI: ${err.message}`);
  }
}

