import express from "express";
import { composeImage } from "../services/imageGeneratorService.js";
import { testGeminiConnection } from "../services/geminiService.js";

const router = express.Router();

// Middleware to require admin key
const requireAdminKey = (req, res, next) => {
  const ADMIN_DASH_KEY = process.env.ADMIN_DASH_KEY;
  const providedKey = req.headers["x-admin-key"];

  if (!ADMIN_DASH_KEY) {
    console.log("[Image Generator] No ADMIN_DASH_KEY configured, allowing request");
    return next();
  }

  if (!providedKey || providedKey !== ADMIN_DASH_KEY) {
    console.log("[Image Generator] Authentication failed: invalid or missing admin key");
    return res.status(401).json({
      success: false,
      error: "Unauthorized. Missing or invalid x-admin-key header."
    });
  }

  console.log("[Image Generator] Authentication successful");
  next();
};

// Test endpoint
router.get("/test", requireAdminKey, async (req, res) => {
  try {
    const testResult = await testGeminiConnection();
    res.json({
      success: testResult.success,
      message: testResult.message,
      apiKeySet: !!process.env.GEMINI_API_KEY,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * POST /api/image-generator/compose
 * Generate image with optional reference images
 * 
 * Request body:
 * {
 *   "shortPrompt": "string (required)",
 *   "imageUrls": ["url1", "url2", "url3?"] (optional, 0-3 images),
 *   "usePromptEnhancer": true/false (optional, default: true),
 *   "aspectRatio": "1:1" | "16:9" | "9:16" (optional, default: "1:1"),
 *   "sessionId": "string (optional)"
 * }
 */
router.post("/compose", requireAdminKey, async (req, res) => {
  try {
    const {
      shortPrompt,
      imageUrls = [],
      usePromptEnhancer = true,
      aspectRatio = "1:1",
      sessionId
    } = req.body;

    // Validation
    if (!shortPrompt || typeof shortPrompt !== "string" || shortPrompt.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: "shortPrompt is required and cannot be empty"
      });
    }

    if (!Array.isArray(imageUrls)) {
      return res.status(400).json({
        success: false,
        error: "imageUrls must be an array"
      });
    }

    if (imageUrls.length > 3) {
      return res.status(400).json({
        success: false,
        error: "Maximum 3 reference images supported"
      });
    }

    // Validate aspect ratio
    const validAspectRatios = ["1:1", "16:9", "9:16"];
    if (!validAspectRatios.includes(aspectRatio)) {
      return res.status(400).json({
        success: false,
        error: `Invalid aspectRatio. Must be one of: ${validAspectRatios.join(", ")}`
      });
    }

    console.log(`[Image Generator API] Request: prompt="${shortPrompt.substring(0, 50)}...", images=${imageUrls.length}, enhancer=${usePromptEnhancer}`);

    // Load company profile for prompt enhancement
    let companyProfile = null;
    if (usePromptEnhancer) {
      try {
        // Load company profile using fs (same way server.js does it)
        const fs = await import("fs");
        const path = await import("path");
        const { fileURLToPath } = await import("url");
        
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = path.dirname(__filename);
        const COMPANY_FILE = path.join(__dirname, "..", "memory", "company.json");
        
        if (fs.existsSync(COMPANY_FILE)) {
          companyProfile = JSON.parse(fs.readFileSync(COMPANY_FILE, "utf8"));
          console.log("[Image Generator API] Company profile loaded");
        } else {
          console.warn("[Image Generator API] Company profile file not found");
        }
      } catch (err) {
        console.warn("[Image Generator API] Failed to load company profile:", err.message);
        // Continue without company profile
      }
    }

    // Compose image
    const result = await composeImage(
      shortPrompt,
      imageUrls,
      companyProfile,
      {
        usePromptEnhancer,
        aspectRatio
      }
    );

    // Convert buffer to base64 data URL
    const base64Image = result.buffer.toString("base64");
    const dataUrl = `data:${result.mimeType};base64,${base64Image}`;

    console.log(`[Image Generator API] Success: ${result.buffer.length} bytes, ${result.metadata.generationTimeMs}ms`);

    res.json({
      success: true,
      image: dataUrl,
      enhancedPrompt: result.enhancedPrompt,
      metadata: result.metadata
    });

  } catch (err) {
    console.error("[Image Generator API] Error:", err.message);
    console.error("[Image Generator API] Stack:", err.stack);

    // Determine status code
    let statusCode = 500;
    if (err.message?.includes("required") || err.message?.includes("Invalid")) {
      statusCode = 400;
    } else if (err.message?.includes("Unauthorized") || err.message?.includes("API key")) {
      statusCode = 401;
    }

    res.status(statusCode).json({
      success: false,
      error: err.message || "Image generation failed",
      details: process.env.NODE_ENV === "development" ? err.stack : undefined
    });
  }
});

export default router;

