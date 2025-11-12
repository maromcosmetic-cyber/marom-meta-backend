import express from "express";
import { generateImage, editImage, generateVideo } from "../services/vertexService.js";

const router = express.Router();

/**
 * POST /api/media/create
 * Create media (image/video) using Vertex AI
 * 
 * Request body:
 * {
 *   "mode": "image" | "edit" | "video",
 *   "prompt": "string",
 *   "productImageUrl"?: "string",
 *   "maskPngUrl"?: "string",
 *   "aspectRatio"?: "1:1" | "16:9" | "9:16",
 *   "durationSec"?: number,
 *   "sessionId"?: "string"
 * }
 */
router.post("/create", async (req, res) => {
  try {
    const { mode, prompt, productImageUrl, maskPngUrl, aspectRatio, durationSec, sessionId } = req.body;
    
    // Validation
    if (!mode || !prompt) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields: mode and prompt"
      });
    }
    
    if (!["image", "edit", "video"].includes(mode)) {
      return res.status(400).json({
        success: false,
        error: "Invalid mode. Must be 'image', 'edit', or 'video'"
      });
    }
    
    console.log(`[Media API] Request received: mode=${mode}, sessionId=${sessionId || "none"}`);
    
    let result;
    
    try {
      switch (mode) {
        case "image":
          result = await generateImage(prompt, aspectRatio || "1:1");
          break;
          
        case "edit":
          if (!productImageUrl) {
            return res.status(400).json({
              success: false,
              error: "productImageUrl is required for edit mode"
            });
          }
          result = await editImage(prompt, productImageUrl, maskPngUrl);
          break;
          
        case "video":
          result = await generateVideo(prompt, aspectRatio || "16:9", durationSec || 5);
          break;
          
        default:
          return res.status(400).json({
            success: false,
            error: "Invalid mode"
          });
      }
      
      // Return binary buffer with metadata
      res.set({
        "Content-Type": result.mimeType,
        "Content-Length": result.buffer.length,
        "X-Model": result.model,
        "X-Mode": mode
      });
      
      res.send(result.buffer);
      
    } catch (err) {
      console.error(`[Media API] Generation error (${mode}):`, err.message);
      return res.status(500).json({
        success: false,
        error: err.message || "Media generation failed"
      });
    }
    
  } catch (err) {
    console.error("[Media API] Request error:", err);
    return res.status(500).json({
      success: false,
      error: "Internal server error"
    });
  }
});

export default router;

