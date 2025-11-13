import axios from "axios";

/**
 * Gemini Service - Google AI Studio API wrapper
 * Uses gemini-2.5-flash-image model for image generation
 */

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const MODEL_NAME = "gemini-2.5-flash-image";
const MAX_IMAGE_SIZE_MB = 10;
const TIMEOUT_MS = 120000; // 2 minutes

/**
 * Test Gemini API connection
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function testGeminiConnection() {
  if (!GEMINI_API_KEY) {
    return {
      success: false,
      message: "GEMINI_API_KEY not configured"
    };
  }

  try {
    // Simple test call
    const response = await axios.get(
      `${GEMINI_API_BASE}/models/${MODEL_NAME}`,
      {
        headers: {
          "x-goog-api-key": GEMINI_API_KEY
        },
        timeout: 5000
      }
    );

    return {
      success: true,
      message: "Gemini API connection successful",
      model: MODEL_NAME
    };
  } catch (err) {
    console.error("[Gemini] Connection test failed:", err.message);
    return {
      success: false,
      message: `Connection failed: ${err.message}`
    };
  }
}

/**
 * Download image from URL to buffer
 * @param {string} url - Image URL
 * @returns {Promise<Buffer>}
 */
async function downloadImage(url) {
  try {
    const response = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 30000,
      maxContentLength: MAX_IMAGE_SIZE_MB * 1024 * 1024
    });
    return Buffer.from(response.data);
  } catch (err) {
    throw new Error(`Failed to download image from ${url}: ${err.message}`);
  }
}

/**
 * Convert image buffer to base64
 * @param {Buffer} buffer - Image buffer
 * @param {string} mimeType - MIME type (image/jpeg, image/png, etc.)
 * @returns {string} Base64 encoded image
 */
function bufferToBase64(buffer, mimeType = "image/jpeg") {
  return buffer.toString("base64");
}

/**
 * Validate image buffer
 * @param {Buffer} buffer - Image buffer
 * @returns {object} {valid: boolean, mimeType: string, size: number}
 */
function validateImage(buffer) {
  if (!buffer || buffer.length === 0) {
    throw new Error("Image buffer is empty");
  }

  const sizeMB = buffer.length / (1024 * 1024);
  if (sizeMB > MAX_IMAGE_SIZE_MB) {
    throw new Error(`Image too large: ${sizeMB.toFixed(2)}MB (max ${MAX_IMAGE_SIZE_MB}MB)`);
  }

  // Detect MIME type from buffer header
  let mimeType = "image/jpeg";
  if (buffer[0] === 0x89 && buffer[1] === 0x50) {
    mimeType = "image/png";
  } else if (buffer[0] === 0x47 && buffer[1] === 0x49) {
    mimeType = "image/gif";
  } else if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) {
    mimeType = "image/webp";
  }

  return { valid: true, mimeType, size: buffer.length };
}

/**
 * Prepare images for Gemini API
 * @param {Array<string|Buffer>} images - Array of image URLs or Buffers
 * @returns {Promise<Array<{inlineData: {mimeType: string, data: string}}>>}
 */
async function prepareImages(images) {
  if (!images || images.length === 0) {
    return [];
  }

  const prepared = [];

  for (let i = 0; i < images.length; i++) {
    const image = images[i];
    let buffer;

    if (Buffer.isBuffer(image)) {
      buffer = image;
    } else if (typeof image === "string") {
      // It's a URL, download it
      buffer = await downloadImage(image);
    } else {
      throw new Error(`Invalid image format at index ${i}`);
    }

    const validation = validateImage(buffer);
    const base64 = bufferToBase64(buffer, validation.mimeType);

    prepared.push({
      inlineData: {
        mimeType: validation.mimeType,
        data: base64
      }
    });
  }

  return prepared;
}

/**
 * Generate image using Gemini API with optional reference images
 * @param {string} prompt - Text prompt for image generation
 * @param {Array<string|Buffer>} referenceImages - Array of 0-3 image URLs or Buffers
 * @param {object} config - Configuration options
 * @param {string} config.aspectRatio - "1:1" | "16:9" | "9:16" (default: "1:1")
 * @returns {Promise<{buffer: Buffer, mimeType: string, model: string}>}
 */
export async function generateImageWithReferences(prompt, referenceImages = [], config = {}) {
  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY not configured");
  }

  if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
    throw new Error("Prompt cannot be empty");
  }

  // Validate image count
  if (referenceImages.length > 3) {
    throw new Error("Maximum 3 reference images supported");
  }

  try {
    console.log(`[Gemini] Generating image with ${referenceImages.length} reference image(s)`);
    console.log(`[Gemini] Prompt: "${prompt.substring(0, 100)}..."`);

    // Prepare images
    const imageParts = await prepareImages(referenceImages);
    console.log(`[Gemini] Prepared ${imageParts.length} image(s)`);

    // Build request parts
    const parts = [
      {
        text: prompt
      },
      ...imageParts
    ];

    // Build request body
    const requestBody = {
      contents: [
        {
          parts: parts
        }
      ],
      generationConfig: {
        temperature: 0.4,
        topK: 32,
        topP: 1,
        maxOutputTokens: 8192
      }
    };

    // Add aspect ratio if specified
    if (config.aspectRatio) {
      requestBody.generationConfig.aspectRatio = config.aspectRatio;
    }

    const endpoint = `${GEMINI_API_BASE}/models/${MODEL_NAME}:generateContent`;

    console.log(`[Gemini] Calling API: ${endpoint}`);
    const startTime = Date.now();

    const response = await axios.post(
      endpoint,
      requestBody,
      {
        headers: {
          "x-goog-api-key": GEMINI_API_KEY,
          "Content-Type": "application/json"
        },
        timeout: TIMEOUT_MS
      }
    );

    const duration = Date.now() - startTime;
    console.log(`[Gemini] Request completed in ${duration}ms`);

    // Check response
    if (!response.data || !response.data.candidates || response.data.candidates.length === 0) {
      throw new Error("No image generated - empty response from Gemini API");
    }

    const candidate = response.data.candidates[0];
    
    // Gemini image generation returns image data in the content
    // The exact format depends on Gemini API - may need adjustment
    if (!candidate.content || !candidate.content.parts || candidate.content.parts.length === 0) {
      throw new Error("No image data in response");
    }

    // Extract image data (format may vary - adjust based on actual API response)
    const imagePart = candidate.content.parts.find(part => part.inlineData);
    
    if (!imagePart || !imagePart.inlineData || !imagePart.inlineData.data) {
      // If no inline data, the API might return a different format
      // Log the response structure for debugging
      console.error("[Gemini] Unexpected response structure:", JSON.stringify(candidate, null, 2));
      throw new Error("Image data not found in response - check API response format");
    }

    const imageBase64 = imagePart.inlineData.data;
    const mimeType = imagePart.inlineData.mimeType || "image/png";
    const imageBuffer = Buffer.from(imageBase64, "base64");

    console.log(`[Gemini] Image generated successfully (${imageBuffer.length} bytes, ${mimeType})`);

    return {
      buffer: imageBuffer,
      mimeType: mimeType,
      model: MODEL_NAME
    };

  } catch (err) {
    console.error("[Gemini] Image generation error:", err.message);
    
    if (err.response) {
      console.error("[Gemini] Response status:", err.response.status);
      console.error("[Gemini] Response data:", JSON.stringify(err.response.data, null, 2));
      
      const errorData = err.response.data;
      let errorMessage = `Gemini API error: ${err.response.status}`;
      
      if (errorData?.error?.message) {
        errorMessage = errorData.error.message;
      } else if (errorData?.message) {
        errorMessage = errorData.message;
      }
      
      throw new Error(errorMessage);
    }
    
    if (err.code === "ECONNABORTED" || err.message?.includes("timeout")) {
      throw new Error("Request timed out - Gemini API may be slow or unavailable");
    }
    
    throw new Error(`Image generation failed: ${err.message}`);
  }
}

