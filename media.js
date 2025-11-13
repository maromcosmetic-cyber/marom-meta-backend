import express from "express";

// Helper function to import with fallback paths
async function importWithFallback(moduleName, paths) {
  for (const modulePath of paths) {
    try {
      return await import(modulePath);
    } catch (e) {
      continue;
    }
  }
  throw new Error(`Could not import ${moduleName} from any path: ${paths.join(", ")}`);
}

// Import vertexService - try root first (matches git structure), then services/
// Note: If this file is in routes/, use ../ to go up. If in root, use ./
const vertexModule = await importWithFallback("vertexService", [
  "../vertexService.js",  // If in routes/ subdirectory
  "./vertexService.js",   // If in root directory
  "../services/vertexService.js",  // If in routes/ and services/ exists
  "./services/vertexService.js"   // If in root and services/ exists
]);
const { generateImage, editImage, generateVideo } = vertexModule;

// Import wooService - try root first, then services/
const wooModule = await importWithFallback("wooService", [
  "../wooService.js",  // If in routes/ subdirectory
  "./wooService.js",  // If in root directory
  "../services/wooService.js",  // If in routes/ and services/ exists
  "./services/wooService.js"   // If in root and services/ exists
]);
const { 
  getProductById, 
  searchProductsByText, 
  getProductPrimaryImage, 
  getProductGallery, 
  getProductSummary,
  findProduct,
  isWooCommerceConfigured
} = wooModule;

const router = express.Router();

// Test route to verify router is working
router.get("/test", (req, res) => {
  res.json({ 
    success: true, 
    message: "Media API router is working",
    timestamp: new Date().toISOString()
  });
});

// Middleware to require admin key (optional - can be added at route level)
const requireAdminKey = (req, res, next) => {
  const ADMIN_DASH_KEY = process.env.ADMIN_DASH_KEY;
  const providedKey = req.headers["x-admin-key"];
  
  if (!ADMIN_DASH_KEY) {
    // If no admin key is configured, allow all requests (for development)
    console.log("[Media API] No ADMIN_DASH_KEY configured, allowing request");
    return next();
  }
  
  if (!providedKey || providedKey !== ADMIN_DASH_KEY) {
    console.log("[Media API] Authentication failed: invalid or missing admin key");
    return res.status(401).json({ 
      success: false,
      error: "Unauthorized. Missing or invalid x-admin-key header." 
    });
  }
  
  console.log("[Media API] Authentication successful");
  next();
};

/**
 * POST /api/media/create
 * Create media (image/video) using Vertex AI with optional WooCommerce product integration
 * 
 * Request body:
 * {
 *   "mode": "image" | "edit" | "video",
 *   "prompt": "string",
 *   "productId"?: number,
 *   "productQuery"?: string,
 *   "useGallery"?: boolean,
 *   "productImageUrl"?: "string",
 *   "maskPngUrl"?: "string",
 *   "aspectRatio"?: "1:1" | "16:9" | "9:16",
 *   "durationSec"?: number,
 *   "sessionId"?: "string"
 * }
 */
router.post("/create", requireAdminKey, async (req, res) => {
  try {
    const { 
      mode, 
      prompt, 
      productId, 
      productQuery, 
      useGallery,
      productImageUrl, 
      maskPngUrl, 
      aspectRatio, 
      durationSec, 
      sessionId 
    } = req.body;
    
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
    
    console.log(`[Media API] Request received: mode=${mode}, productId=${productId || "none"}, productQuery=${productQuery || "none"}, sessionId=${sessionId || "none"}`);
    
    // Fetch product data if productId or productQuery provided
    let product = null;
    let productContext = null;
    let selectedImageUrl = productImageUrl;
    
    if (productId || productQuery) {
      if (!isWooCommerceConfigured()) {
        return res.status(503).json({
          success: false,
          error: "WooCommerce not configured. Set WC_API_URL, WC_API_KEY, and WC_API_SECRET."
        });
      }
      
      try {
        product = await findProduct(productId || productQuery);
        
        if (!product) {
          return res.status(404).json({
            success: false,
            error: `Product not found: ${productId || productQuery}`
          });
        }
        
        // Get product summary for context
        productContext = getProductSummary(product);
        
        // For edit mode, select image source
        if (mode === "edit" && !selectedImageUrl) {
          const primaryImage = getProductPrimaryImage(product);
          if (primaryImage) {
            selectedImageUrl = primaryImage;
          } else if (useGallery) {
            const gallery = getProductGallery(product);
            if (gallery.length > 0) {
              selectedImageUrl = gallery[0];
            }
          }
          
          if (!selectedImageUrl) {
            return res.status(400).json({
              success: false,
              error: "No product image available. Provide productImageUrl or ensure product has images."
            });
          }
        }
        
        console.log(`[Media API] Product loaded: ${productContext.title} (ID: ${product.id})`);
      } catch (err) {
        console.error("[Media API] Error fetching product:", err.message);
        return res.status(500).json({
          success: false,
          error: `Failed to fetch product: ${err.message}`
        });
      }
    }
    
    let result;
    let productInfo = null; // For response metadata
    
    try {
      switch (mode) {
        case "image":
          result = await generateImage(prompt, aspectRatio || "1:1", productContext);
          if (productContext) {
            productInfo = {
              title: productContext.title,
              permalink: productContext.permalink
            };
          }
          break;
          
        case "edit":
          if (!selectedImageUrl) {
            return res.status(400).json({
              success: false,
              error: "productImageUrl is required for edit mode (or provide productId/productQuery with images)"
            });
          }
          result = await editImage(prompt, selectedImageUrl, maskPngUrl);
          if (productContext) {
            productInfo = {
              title: productContext.title,
              permalink: productContext.permalink
            };
          }
          break;
          
        case "video":
          result = await generateVideo(prompt, aspectRatio || "16:9", durationSec || 8, productContext);
          if (productContext) {
            productInfo = {
              title: productContext.title,
              permalink: productContext.permalink
            };
          }
          break;
          
        default:
          return res.status(400).json({
            success: false,
            error: "Invalid mode"
          });
      }
      
      // Return binary buffer with metadata
      const headers = {
        "Content-Type": result.mimeType,
        "Content-Length": result.buffer.length,
        "X-Model": result.model,
        "X-Mode": mode
      };
      
      // Add product info to headers if available
      if (productInfo) {
        headers["X-Product-Title"] = productInfo.title;
        headers["X-Product-Permalink"] = productInfo.permalink;
      }
      
      res.set(headers);
      res.send(result.buffer);
      
    } catch (err) {
      console.error(`[Media API] Generation error (${mode}):`, err);
      console.error(`[Media API] Error stack:`, err.stack);
      const errorMessage = err.response?.data?.error || err.message || "Media generation failed";
      return res.status(500).json({
        success: false,
        error: errorMessage,
        details: process.env.NODE_ENV === 'development' ? err.stack : undefined
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

