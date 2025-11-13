import { generateImageWithReferences } from "./geminiService.js";
import { enhancePrompt } from "./promptEnhancerService.js";

/**
 * Image Generator Service
 * Orchestrates image generation with 0-3 reference images and prompt enhancement
 */

/**
 * Compose image from prompt and optional reference images
 * @param {string} shortPrompt - User's short prompt
 * @param {Array<string|Buffer>} images - Array of 0-3 image URLs or Buffers
 * @param {object} companyProfile - Company profile for prompt enhancement
 * @param {object} options - Options
 * @param {boolean} options.usePromptEnhancer - Whether to enhance prompt (default: true)
 * @param {string} options.aspectRatio - Aspect ratio (default: "1:1")
 * @returns {Promise<{buffer: Buffer, mimeType: string, enhancedPrompt: string, metadata: object}>}
 */
export async function composeImage(shortPrompt, images = [], companyProfile = null, options = {}) {
  const {
    usePromptEnhancer = true,
    aspectRatio = "1:1"
  } = options;

  // Validate inputs
  if (!shortPrompt || typeof shortPrompt !== "string" || shortPrompt.trim().length === 0) {
    throw new Error("Prompt cannot be empty");
  }

  if (images.length > 3) {
    throw new Error("Maximum 3 reference images supported");
  }

  const imageCount = images.length;
  console.log(`[Image Generator] Starting composition with ${imageCount} reference image(s)`);

  // Enhance prompt if requested
  let finalPrompt = shortPrompt.trim();
  if (usePromptEnhancer && companyProfile) {
    try {
      finalPrompt = enhancePrompt(shortPrompt, companyProfile, { imageCount });
      console.log(`[Image Generator] Prompt enhanced: ${finalPrompt.length} characters`);
    } catch (err) {
      console.warn(`[Image Generator] Prompt enhancement failed: ${err.message}, using original prompt`);
      // Continue with original prompt
    }
  }

  // Generate image
  const startTime = Date.now();
  
  try {
    const result = await generateImageWithReferences(finalPrompt, images, {
      aspectRatio
    });

    const duration = Date.now() - startTime;

    return {
      buffer: result.buffer,
      mimeType: result.mimeType,
      enhancedPrompt: finalPrompt,
      metadata: {
        model: result.model,
        imageCount: imageCount,
        generationTimeMs: duration,
        aspectRatio: aspectRatio,
        promptEnhanced: usePromptEnhancer && companyProfile !== null
      }
    };
  } catch (err) {
    const duration = Date.now() - startTime;
    console.error(`[Image Generator] Generation failed after ${duration}ms:`, err.message);
    throw err;
  }
}

