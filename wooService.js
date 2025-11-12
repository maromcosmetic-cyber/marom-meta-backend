import axios from "axios";

/**
 * WooCommerce Service
 * Wraps WooCommerce REST API (v3) for product data access
 */

// Use existing environment variables (WC_API_URL may include /wp-json/wc/v3/products or just base URL)
const WC_API_URL = process.env.WC_API_URL || "";
const WC_API_KEY = process.env.WC_API_KEY || "";
const WC_API_SECRET = process.env.WC_API_SECRET || "";

// Build WooCommerce API base URL
// If WC_API_URL already includes /wp-json/wc/v3, use it as-is; otherwise append it
let WC_API_BASE = "";
if (WC_API_URL) {
  if (WC_API_URL.includes("/wp-json/wc/v3")) {
    WC_API_BASE = WC_API_URL.replace(/\/products.*$/, "").replace(/\/$/, "");
  } else {
    WC_API_BASE = `${WC_API_URL.replace(/\/$/, "")}/wp-json/wc/v3`;
  }
}

/**
 * Make authenticated WooCommerce API request
 * @param {string} method - HTTP method
 * @param {string} endpoint - API endpoint (e.g., "/products/123")
 * @param {object} params - Query parameters
 * @returns {Promise<*>}
 */
async function wooApiRequest(method, endpoint, params = {}) {
  if (!WC_API_BASE || !WC_API_KEY || !WC_API_SECRET) {
    throw new Error("WooCommerce not configured. Set WC_API_URL, WC_API_KEY, and WC_API_SECRET.");
  }
  
  const url = `${WC_API_BASE}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`;
  
  // Build query params with authentication
  const queryParams = new URLSearchParams();
  queryParams.append("consumer_key", WC_API_KEY);
  queryParams.append("consumer_secret", WC_API_SECRET);
  
  // Add other params
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      queryParams.append(key, String(value));
    }
  });
  
  const fullUrl = `${url}?${queryParams.toString()}`;
  
  try {
    const response = await axios({
      method,
      url: fullUrl,
      timeout: 15000,
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json"
      }
    });
    
    return response.data;
  } catch (err) {
    if (err.response) {
      const status = err.response.status;
      const errorData = err.response.data || {};
      const errorMsg = errorData.message || errorData.error || `HTTP ${status}`;
      throw new Error(`WooCommerce API error (${status}): ${errorMsg}`);
    }
    throw new Error(`WooCommerce request failed: ${err.message}`);
  }
}

/**
 * Get product by ID
 * @param {number} id - Product ID
 * @returns {Promise<object>}
 */
export async function getProductById(id) {
  try {
    const product = await wooApiRequest("GET", `/products/${id}`);
    return product;
  } catch (err) {
    console.error(`[WooCommerce] Error fetching product ${id}:`, err.message);
    throw err;
  }
}

/**
 * Search products by text (name, SKU, description)
 * @param {string} query - Search query
 * @param {number} limit - Maximum results (default 5)
 * @returns {Promise<Array>}
 */
export async function searchProductsByText(query, limit = 5) {
  try {
    const products = await wooApiRequest("GET", "/products", {
      search: query,
      per_page: limit,
      status: "publish"
    });
    
    return Array.isArray(products) ? products : [];
  } catch (err) {
    console.error(`[WooCommerce] Error searching products:`, err.message);
    return [];
  }
}

/**
 * Get primary product image URL (largest size available)
 * @param {object} product - WooCommerce product object
 * @returns {string|null}
 */
export function getProductPrimaryImage(product) {
  if (!product) return null;
  
  // Check images array
  if (product.images && Array.isArray(product.images) && product.images.length > 0) {
    const image = product.images[0];
    // Prefer full size, fallback to src
    return image.src || image.url || null;
  }
  
  // Fallback to featured image meta
  if (product.featured_image) {
    return product.featured_image;
  }
  
  return null;
}

/**
 * Get product gallery images
 * @param {object} product - WooCommerce product object
 * @returns {Array<string>}
 */
export function getProductGallery(product) {
  if (!product || !product.images || !Array.isArray(product.images)) {
    return [];
  }
  
  return product.images
    .map(img => img.src || img.url)
    .filter(Boolean);
}

/**
 * Get product summary (sanitized, plain text)
 * @param {object} product - WooCommerce product object
 * @returns {object}
 */
export function getProductSummary(product) {
  if (!product) {
    return { title: "", price: "", shortDesc: "", permalink: "" };
  }
  
  // Sanitize HTML from description
  const stripHtml = (html) => {
    if (!html) return "";
    return String(html)
      .replace(/<[^>]*>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .trim();
  };
  
  const title = product.name || "";
  const price = product.regular_price || product.price || "";
  const shortDesc = stripHtml(product.short_description || product.description || "");
  const permalink = product.permalink || product.link || "";
  
  // Extract key ingredients from meta if available
  let ingredients = "";
  if (product.meta_data && Array.isArray(product.meta_data)) {
    const ingredientsMeta = product.meta_data.find(m => 
      m.key && (m.key.toLowerCase().includes("ingredient") || m.key.toLowerCase().includes("ingredient"))
    );
    if (ingredientsMeta && ingredientsMeta.value) {
      ingredients = stripHtml(String(ingredientsMeta.value));
    }
  }
  
  return {
    title,
    price,
    shortDesc: shortDesc.substring(0, 500), // Limit length
    permalink,
    ingredients: ingredients.substring(0, 200) // Limit ingredients
  };
}

/**
 * Find best matching product by query
 * @param {string|number} query - Product ID or search query
 * @returns {Promise<object|null>}
 */
export async function findProduct(query) {
  try {
    // If numeric, try as ID first
    if (!isNaN(query) && parseInt(query) > 0) {
      try {
        return await getProductById(parseInt(query));
      } catch (err) {
        // Not found by ID, continue to search
      }
    }
    
    // Search by text
    const results = await searchProductsByText(String(query), 1);
    return results.length > 0 ? results[0] : null;
  } catch (err) {
    console.error(`[WooCommerce] Error finding product:`, err.message);
    return null;
  }
}

/**
 * Check if WooCommerce is configured
 * @returns {boolean}
 */
export function isWooCommerceConfigured() {
  return !!(WC_API_URL && WC_API_KEY && WC_API_SECRET);
}

