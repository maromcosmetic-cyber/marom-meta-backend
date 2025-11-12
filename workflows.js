// Workflow handlers for conversational menu-driven campaign creation
import axios from "axios";
import FormData from "form-data";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Workflow types
export const WORKFLOWS = {
  MAIN_MENU: "main_menu",
  CREATE_CAMPAIGN: "create_campaign",
  GENERATE_MEDIA: "generate_media",
  MANAGE_CAMPAIGNS: "manage_campaigns",
  ANALYZE_PERFORMANCE: "analyze_performance",
  MANAGE_PRODUCTS: "manage_products"
};

// Workflow state helpers (will be passed from server.js)
let userWorkflows = null;
let sendWhatsAppMessage = null;
let wooFetch = null;
let normalizeProduct = null;
let findProductByName = null;
let getSession = null;
let ANGLE_PRESETS = null;
let loadCompanyContext = null;
let fb = null;
let GRAPH = null;
let TOKEN = null;

export function initWorkflows(dependencies) {
  userWorkflows = dependencies.userWorkflows;
  sendWhatsAppMessage = dependencies.sendWhatsAppMessage;
  wooFetch = dependencies.wooFetch;
  normalizeProduct = dependencies.normalizeProduct;
  findProductByName = dependencies.findProductByName;
  getSession = dependencies.getSession;
  ANGLE_PRESETS = dependencies.ANGLE_PRESETS;
  loadCompanyContext = dependencies.loadCompanyContext;
  fb = dependencies.fb;
  GRAPH = dependencies.GRAPH;
  TOKEN = dependencies.TOKEN;
}

function setUserWorkflow(from, workflow) {
  userWorkflows.set(from, { ...workflow, timestamp: Date.now() });
}

function getUserWorkflow(from) {
  return userWorkflows.get(from) || null;
}

function clearWorkflow(from) {
  userWorkflows.delete(from);
}

function updateWorkflowData(from, data) {
  const workflow = getUserWorkflow(from);
  if (workflow) {
    workflow.data = { ...workflow.data, ...data };
    setUserWorkflow(from, workflow);
  }
}

// Check if message is a menu trigger
export function isMenuTrigger(text) {
  const lower = text.toLowerCase().trim();
  return lower === "menu" || lower === "hi" || lower === "hello" || 
         lower === "start" || lower === "help" || lower === "/menu" ||
         lower === "/start" || lower === "/help";
}

// Check if message is workflow navigation
export function isWorkflowNavigation(text) {
  const lower = text.toLowerCase().trim();
  return lower === "back" || lower === "cancel" || lower === "menu" ||
         lower.startsWith("/back") || lower.startsWith("/cancel") || lower.startsWith("/menu");
}

// Show main menu
export async function showMainMenu(from) {
  const menu = `👋 *Hello! I'm your Campaign Assistant for MAROM.*

*What would you like to do today?*

*📋 MAIN OPTIONS:*

*1️⃣ CREATE CAMPAIGN*
   Generate media → Create campaign → Launch

*2️⃣ GENERATE MEDIA*
   Images/Videos for your products

*3️⃣ MANAGE CAMPAIGNS*
   View, pause, optimize existing campaigns

*4️⃣ ANALYZE PERFORMANCE*
   Stats, insights, recommendations

*5️⃣ MANAGE PRODUCTS*
   Edit products, check inventory

*6️⃣ QUICK ACTIONS*
   Common shortcuts

Reply with the number (1-6) or describe what you want to do!`;
  
  await sendWhatsAppMessage(from, menu);
  setUserWorkflow(from, { workflow: WORKFLOWS.MAIN_MENU, step: 0, data: {} });
}

// Handle workflow navigation (back, cancel, menu)
export async function handleWorkflowNavigation(from, messageText) {
  const lower = messageText.toLowerCase().trim();
  
  if (lower === "back" || lower.startsWith("/back")) {
    const workflow = getUserWorkflow(from);
    if (workflow && workflow.step > 1) {
      workflow.step--;
      setUserWorkflow(from, workflow);
      await sendWhatsAppMessage(from, "⬅️ Going back...");
      // Re-trigger current step handler
      await handleWorkflowStep(from, "", workflow);
    } else {
      await sendWhatsAppMessage(from, "⚠️ Can't go back further. Say 'menu' to return to main menu.");
    }
  } else if (lower === "cancel" || lower.startsWith("/cancel")) {
    clearWorkflow(from);
    await sendWhatsAppMessage(from, "❌ Cancelled. Say 'menu' to start over.");
  } else if (lower === "menu" || lower.startsWith("/menu")) {
    clearWorkflow(from);
    await showMainMenu(from);
  }
}

// Handle workflow step
export async function handleWorkflowStep(from, messageText, workflow) {
  switch (workflow.workflow) {
    case WORKFLOWS.MAIN_MENU:
      await handleMainMenuSelection(from, messageText);
      break;
    case WORKFLOWS.CREATE_CAMPAIGN:
      await handleCampaignWorkflowStep(from, messageText, workflow);
      break;
    case WORKFLOWS.GENERATE_MEDIA:
      await handleMediaWorkflowStep(from, messageText, workflow);
      break;
    case WORKFLOWS.MANAGE_CAMPAIGNS:
      await handleManageCampaignsWorkflow(from, messageText, workflow);
      break;
    case WORKFLOWS.ANALYZE_PERFORMANCE:
      await handleAnalyzePerformanceWorkflow(from, messageText, workflow);
      break;
    case WORKFLOWS.MANAGE_PRODUCTS:
      await handleManageProductsWorkflow(from, messageText, workflow);
      break;
    default:
      await showMainMenu(from);
  }
}

// Handle main menu selection
async function handleMainMenuSelection(from, messageText) {
  const lower = messageText.toLowerCase().trim();
  const numMatch = messageText.match(/^(\d)/);
  const num = numMatch ? parseInt(numMatch[1]) : null;
  
  if (num === 1 || lower.includes("create campaign") || lower.includes("new campaign")) {
    await startCampaignWorkflow(from);
  } else if (num === 2 || lower.includes("generate media") || lower.includes("create image") || lower.includes("create video")) {
    await startMediaWorkflow(from);
  } else if (num === 3 || lower.includes("manage campaign") || lower.includes("campaigns")) {
    await startManageCampaignsWorkflow(from);
  } else if (num === 4 || lower.includes("analyze") || lower.includes("performance") || lower.includes("stats")) {
    await startAnalyzePerformanceWorkflow(from);
  } else if (num === 5 || lower.includes("manage product") || lower.includes("product")) {
    await startManageProductsWorkflow(from);
  } else if (num === 6 || lower.includes("quick")) {
    await showQuickActions(from);
  } else {
    await sendWhatsAppMessage(from, "⚠️ Please reply with a number (1-6) or say 'menu' to see options again.");
  }
}

// Start campaign creation workflow
async function startCampaignWorkflow(from, productName = null) {
  setUserWorkflow(from, {
    workflow: WORKFLOWS.CREATE_CAMPAIGN,
    step: 1,
    data: { productName }
  });
  
  let msg = `🚀 *CREATE CAMPAIGN*\n\nLet's build your campaign step by step!\n\n`;
  msg += `*Step 1/5: Which product are you promoting?*\n`;
  msg += `📦 Type product name or say "list products"\n\n`;
  
  if (productName) {
    msg += `Detected: "${productName}"\n\n`;
    msg += `Is this correct? Reply "yes" to continue, or type a different product name.`;
  } else {
    msg += `Examples:\n• "shampoo"\n• "moringa conditioner"\n• "list products"`;
  }
  
  await sendWhatsAppMessage(from, msg);
}

// Handle campaign workflow steps
async function handleCampaignWorkflowStep(from, messageText, workflow) {
  const step = workflow.step;
  
  switch (step) {
    case 1: // Product selection
      await handleCampaignProductSelection(from, messageText, workflow);
      break;
    case 2: // Media generation
      await handleCampaignMediaSelection(from, messageText, workflow);
      break;
    case 3: // Objective selection
      await handleCampaignObjectiveSelection(from, messageText, workflow);
      break;
    case 4: // Budget & schedule
      await handleCampaignBudgetSchedule(from, messageText, workflow);
      break;
    case 5: // Review & create
      await handleCampaignReviewCreate(from, messageText, workflow);
      break;
  }
}

// Campaign Step 1: Product selection
async function handleCampaignProductSelection(from, messageText, workflow) {
  const lower = messageText.toLowerCase().trim();
  
  if (lower === "list products" || lower === "list") {
    try {
      const products = await wooFetch("GET", "/products?per_page=20&status=publish");
      if (products && products.length > 0) {
        let msg = `📦 *Available Products:*\n\n`;
        products.slice(0, 10).forEach((p, i) => {
          const normalized = normalizeProduct(p);
          msg += `${i + 1}. ${normalized.name}${normalized.price ? ` - $${normalized.price}` : ""}\n`;
        });
        msg += `\nType the product name or number to select.`;
        await sendWhatsAppMessage(from, msg);
        updateWorkflowData(from, { productList: products.slice(0, 10) });
        return;
      }
    } catch (err) {
      await sendWhatsAppMessage(from, `⚠️ Could not fetch products: ${err.message}`);
      return;
    }
  }
  
  // Check if it's a number (from list)
  const numMatch = messageText.match(/^(\d+)/);
  if (numMatch && workflow.data?.productList) {
    const idx = parseInt(numMatch[1]) - 1;
    if (idx >= 0 && idx < workflow.data.productList.length) {
      const product = workflow.data.productList[idx];
      const normalized = normalizeProduct(product);
      updateWorkflowData(from, { product: normalized, productName: normalized.name });
      workflow.step = 2;
      setUserWorkflow(from, workflow);
      await handleCampaignWorkflowStep(from, "", workflow);
      return;
    }
  }
  
  // Try to find product by name
  try {
    const product = await findProductByName(messageText, true);
    if (product) {
      const normalized = normalizeProduct(product);
      updateWorkflowData(from, { product: normalized, productName: normalized.name });
      workflow.step = 2;
      setUserWorkflow(from, workflow);
      
      let msg = `✅ *Product: ${normalized.name}*\n`;
      if (normalized.price) msg += `💰 Price: $${normalized.price}\n`;
      msg += `\n*Step 2/5: Generate media for this campaign?*\n`;
      msg += `🎨 I can create images/videos for this product\n\n`;
      msg += `*Options:*\n`;
      msg += `1️⃣ Generate image pack (Square + Portrait + Story)\n`;
      msg += `2️⃣ Generate single image\n`;
      msg += `3️⃣ Generate video\n`;
      msg += `4️⃣ Skip (use existing media)\n\n`;
      msg += `Reply 1-4 or describe what you want`;
      
      await sendWhatsAppMessage(from, msg);
    } else {
      await sendWhatsAppMessage(from, `❌ Product not found: "${messageText}"\n\nSay "list products" to see all products, or try a different name.`);
    }
  } catch (err) {
    await sendWhatsAppMessage(from, `⚠️ Error finding product: ${err.message}\n\nSay "list products" to see all products.`);
  }
}

// Campaign Step 2: Media generation
async function handleCampaignMediaSelection(from, messageText, workflow) {
  const lower = messageText.toLowerCase().trim();
  const numMatch = messageText.match(/^(\d)/);
  const num = numMatch ? parseInt(numMatch[1]) : null;
  
  if (num === 4 || lower === "skip" || lower === "no") {
    // Skip media generation
    workflow.step = 3;
    setUserWorkflow(from, workflow);
    await handleCampaignWorkflowStep(from, "", workflow);
    return;
  }
  
  const product = workflow.data?.product;
  if (!product) {
    await sendWhatsAppMessage(from, "⚠️ Product not found. Going back to product selection...");
    workflow.step = 1;
    setUserWorkflow(from, workflow);
    await handleCampaignWorkflowStep(from, "", workflow);
    return;
  }
  
  // Generate media based on selection
  try {
    await sendWhatsAppMessage(from, `🎨 Generating media... Please wait!`);
    
    let mediaType = "single";
    if (num === 1 || lower.includes("pack")) {
      mediaType = "pack";
    } else if (num === 3 || lower.includes("video")) {
      mediaType = "video";
    }
    
    // Use existing image generation logic
    const session = getSession(from);
    const companyContext = await loadCompanyContext();
    
    let result;
    if (mediaType === "video") {
      // Generate video
      const { generateVideo } = await import("./services/vertexService.js");
      const prompt = `UGC style video showcasing ${product.name}, natural lighting, authentic feel`;
      result = await generateVideo(prompt, "9:16", 8, {
        title: product.name,
        shortDesc: product.description || product.short_description || "",
        permalink: product.permalink || ""
      });
    } else {
      // Generate image(s)
      const { generateImage } = await import("./services/vertexService.js");
      const prompt = `Professional product photography of ${product.name}, ${ANGLE_PRESETS[session.angle]}, ${session.style}`;
      result = await generateImage(prompt, "1:1", {
        title: product.name,
        shortDesc: product.description || product.short_description || "",
        permalink: product.permalink || ""
      });
      
      if (mediaType === "pack") {
        result.pack = true;
      }
    }
    
    // Store media in workflow data
    updateWorkflowData(from, { 
      media: {
        buffer: result.buffer,
        mimeType: result.mimeType,
        type: mediaType
      }
    });
    
    // Upload to WhatsApp to show preview
    const { uploadWhatsAppMedia, sendWhatsAppImage, sendWhatsAppVideo } = await import("./services/whatsappService.js");
    const mediaId = await uploadWhatsAppMedia(result.buffer, result.mimeType);
    
    if (result.mimeType.includes("video")) {
      await sendWhatsAppVideo(from, mediaId, `✅ Media generated!\n\nStep 3/5: Campaign objective?`);
    } else {
      await sendWhatsAppImage(from, mediaId, `✅ Media generated!\n\nStep 3/5: Campaign objective?`);
    }
    
    // Move to next step
    workflow.step = 3;
    setUserWorkflow(from, workflow);
    
    let msg = `*Step 3/5: Campaign objective?*\n`;
    msg += `What's your goal?\n\n`;
    msg += `1️⃣ Sales (Conversions)\n`;
    msg += `2️⃣ Traffic (Website visits)\n`;
    msg += `3️⃣ Awareness (Brand reach)\n`;
    msg += `4️⃣ Engagement (Likes, comments)\n\n`;
    msg += `Reply 1-4 or describe your goal`;
    
    await sendWhatsAppMessage(from, msg);
    
  } catch (err) {
    console.error("[Campaign Workflow] Media generation error:", err);
    await sendWhatsAppMessage(from, `⚠️ Media generation failed: ${err.message}\n\nSay "skip" to continue without media, or try again.`);
  }
}

// Campaign Step 3: Objective selection
async function handleCampaignObjectiveSelection(from, messageText, workflow) {
  const lower = messageText.toLowerCase().trim();
  const numMatch = messageText.match(/^(\d)/);
  const num = numMatch ? parseInt(numMatch[1]) : null;
  
  let objective = "CONVERSIONS";
  let objectiveName = "Sales (Conversions)";
  
  if (num === 2 || lower.includes("traffic") || lower.includes("website")) {
    objective = "LINK_CLICKS";
    objectiveName = "Traffic (Website visits)";
  } else if (num === 3 || lower.includes("awareness") || lower.includes("reach")) {
    objective = "REACH";
    objectiveName = "Awareness (Brand reach)";
  } else if (num === 4 || lower.includes("engagement") || lower.includes("likes") || lower.includes("comments")) {
    objective = "POST_ENGAGEMENT";
    objectiveName = "Engagement (Likes, comments)";
  }
  
  updateWorkflowData(from, { objective, objectiveName });
  workflow.step = 4;
  setUserWorkflow(from, workflow);
  
  let msg = `✅ *Objective: ${objectiveName}*\n\n`;
  msg += `*Step 4/5: Budget & Schedule*\n`;
  msg += `💰 Daily budget: $___\n`;
  msg += `📅 Duration: [Today] to [Date] or "ongoing"\n\n`;
  msg += `Reply with budget and dates, or say "use defaults"`;
  
  await sendWhatsAppMessage(from, msg);
}

// Campaign Step 4: Budget & Schedule
async function handleCampaignBudgetSchedule(from, messageText, workflow) {
  const lower = messageText.toLowerCase().trim();
  
  let budget = 50; // Default
  let duration = "ongoing";
  let startTime = null;
  let endTime = null;
  
  // Parse budget
  const budgetMatch = messageText.match(/\$?(\d+(?:\.\d+)?)/);
  if (budgetMatch) {
    budget = parseFloat(budgetMatch[1]);
  }
  
  // Parse dates if provided
  if (lower.includes("ongoing") || lower.includes("default")) {
    duration = "ongoing";
  } else {
    // Try to parse dates (simplified - can be enhanced)
    const dateMatch = messageText.match(/(\d{1,2}\/\d{1,2}\/\d{4})/g);
    if (dateMatch && dateMatch.length >= 2) {
      startTime = dateMatch[0];
      endTime = dateMatch[1];
      duration = `${startTime} to ${endTime}`;
    }
  }
  
  updateWorkflowData(from, { budget, duration, startTime, endTime });
  workflow.step = 5;
  setUserWorkflow(from, workflow);
  
  // Generate AI audience and copy
  try {
    const product = workflow.data?.product;
    const companyContext = await loadCompanyContext();
    
    // Generate audience
    const audiencePrompt = `Generate a Facebook/Instagram ad audience targeting for ${product.name || "our product"}. 
Company: ${companyContext.name || "MAROM"}
Industry: ${companyContext.industry || "Cosmetics"}
Target Audience: ${companyContext.targetAudience || "Women 25-45"}
Return JSON: { "demographics": {...}, "interests": [...], "behaviors": [...] }`;
    
    const audienceResponse = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: audiencePrompt }],
      temperature: 0.7
    });
    
    let audience = {};
    try {
      const audienceText = audienceResponse.choices[0].message.content;
      const jsonMatch = audienceText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        audience = JSON.parse(jsonMatch[0]);
      }
    } catch (err) {
      // Use default audience
      audience = {
        age_min: 25,
        age_max: 45,
        genders: [2], // Female
        interests: ["Hair care", "Beauty", "Skincare"]
      };
    }
    
    // Generate ad copy
    const copyPrompt = `Write compelling Facebook/Instagram ad copy for ${product.name || "our product"}.
Product: ${product.name}
Price: ${product.price ? `$${product.price}` : "Check website"}
Description: ${(product.description || product.short_description || "").substring(0, 200)}
Company: ${companyContext.name || "MAROM"}
Return JSON: { "headline": "...", "text": "...", "call_to_action": "..." }`;
    
    const copyResponse = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: copyPrompt }],
      temperature: 0.8
    });
    
    let copy = { headline: product.name, text: "", call_to_action: "Shop Now" };
    try {
      const copyText = copyResponse.choices[0].message.content;
      const jsonMatch = copyText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        copy = { ...copy, ...JSON.parse(jsonMatch[0]) };
      }
    } catch (err) {
      copy.text = `Discover ${product.name} - ${product.description || "Premium quality product"}`;
    }
    
    updateWorkflowData(from, { audience, copy });
  } catch (err) {
    console.error("[Campaign Workflow] AI generation error:", err);
    // Continue with defaults
    updateWorkflowData(from, {
      audience: { age_min: 25, age_max: 45, genders: [2] },
      copy: { headline: workflow.data?.product?.name || "Campaign", text: "", call_to_action: "Shop Now" }
    });
  }
  
  await handleCampaignWorkflowStep(from, "", workflow);
}

// Campaign Step 5: Review & Create
async function handleCampaignReviewCreate(from, messageText, workflow) {
  const data = workflow.data || {};
  const product = data.product || {};
  const media = data.media;
  const objective = data.objectiveName || "Sales (Conversions)";
  const budget = data.budget || 50;
  const audience = data.audience || {};
  
  let msg = `✅ *Budget: $${budget}/day | Duration: ${data.duration || "Ongoing"}*\n\n`;
  msg += `*Step 5/5: Review & Create*\n`;
  msg += `📋 *Campaign Summary:*\n\n`;
  msg += `• Product: ${product.name || "N/A"}\n`;
  if (media) {
    msg += `• Media: ${media.type === "pack" ? "3 images" : media.type === "video" ? "1 video" : "1 image"} ✅\n`;
  } else {
    msg += `• Media: None (will need to add later)\n`;
  }
  msg += `• Objective: ${objective}\n`;
  msg += `• Budget: $${budget}/day\n`;
  msg += `• Audience: AI-generated (${audience.age_min || 25}-${audience.age_max || 45}, ${audience.interests?.[0] || "hair care"})\n\n`;
  msg += `Ready to create?\n`;
  msg += `1️⃣ Yes, create campaign (paused)\n`;
  msg += `2️⃣ Edit something\n`;
  msg += `3️⃣ Cancel\n\n`;
  msg += `Reply 1-3`;
  
  await sendWhatsAppMessage(from, msg);
  
  // Wait for confirmation
  const lower = messageText.toLowerCase().trim();
  const numMatch = messageText.match(/^(\d)/);
  const num = numMatch ? parseInt(numMatch[1]) : null;
  
  if (num === 1 || lower === "yes" || lower === "create") {
    await createCampaignFromWorkflow(from, workflow);
  } else if (num === 2 || lower === "edit") {
    await sendWhatsAppMessage(from, `What would you like to edit?\n\n• "product" - Change product\n• "media" - Regenerate media\n• "objective" - Change objective\n• "budget" - Change budget`);
  } else if (num === 3 || lower === "cancel") {
    clearWorkflow(from);
    await sendWhatsAppMessage(from, "❌ Campaign creation cancelled. Say 'menu' to start over.");
  }
}

// Create campaign from workflow data
async function createCampaignFromWorkflow(from, workflow) {
  try {
    await sendWhatsAppMessage(from, `🚀 Creating campaign... Please wait!`);
    
    const data = workflow.data || {};
    const product = data.product || {};
    const media = data.media;
    const objective = data.objective || "CONVERSIONS";
    const budget = data.budget || 50;
    const audience = data.audience || {};
    const copy = data.copy || {};
    
    // Get ad account
    const accounts = await fb("/me/adaccounts", "GET", { fields: "id,name,account_id" });
    if (!accounts.data || accounts.data.length === 0) {
      throw new Error("No ad accounts found. Please set up an ad account in Meta Ads Manager.");
    }
    const adAccountId = `act_${accounts.data[0].account_id}`;
    
    // Upload media if available
    let imageHash = null;
    if (media && media.buffer) {
      imageHash = await uploadImageToMeta(adAccountId, media.buffer, product.name || "Campaign Image");
    }
    
    // Create campaign structure
    const campaignName = `${product.name || "Campaign"} - ${data.objectiveName || "Sales"}`;
    const result = await createCampaignStructure(adAccountId, {
      name: campaignName,
      objective: objective,
      budget: budget,
      media: imageHash ? { imageHash } : null,
      copy: copy,
      audience: audience,
      startTime: data.startTime,
      endTime: data.endTime
    });
    
    let successMsg = `✅ *Campaign Created Successfully!*\n\n`;
    successMsg += `📊 Campaign ID: ${result.campaignId}\n`;
    successMsg += `📝 Name: "${campaignName}"\n`;
    successMsg += `💰 Budget: $${budget}/day\n`;
    successMsg += `⏸️ Status: PAUSED (ready to review)\n\n`;
    successMsg += `*Next steps:*\n`;
    successMsg += `• Review in Meta Ads Manager\n`;
    successMsg += `• Activate when ready\n`;
    successMsg += `• Or say "activate campaign ${result.campaignId}"\n\n`;
    successMsg += `What would you like to do next?`;
    
    await sendWhatsAppMessage(from, successMsg);
    clearWorkflow(from);
    
  } catch (err) {
    console.error("[Campaign Workflow] Creation error:", err);
    await sendWhatsAppMessage(from, `❌ Failed to create campaign: ${err.message}\n\nTry again or say "menu" to start over.`);
  }
}

// Meta Ads API: Upload image to Ad Account
async function uploadImageToMeta(adAccountId, imageBuffer, name) {
  try {
    const form = new FormData();
    form.append("bytes", imageBuffer, { filename: `${name || "image"}.jpg`, contentType: "image/jpeg" });
    form.append("name", name || "Generated Image");
    
    const response = await axios.post(
      `${GRAPH}/${adAccountId}/adimages`,
      form,
      {
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          ...form.getHeaders()
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity
      }
    );
    
    if (response.data?.images && response.data.images.length > 0) {
      return response.data.images[0].hash; // image_hash for Ad Creative
    }
    throw new Error("No image hash returned from Meta");
  } catch (err) {
    console.error("[Meta] Error uploading image:", err.response?.data || err.message);
    throw new Error(`Failed to upload image to Meta: ${err.message}`);
  }
}

// Meta Ads API: Create full campaign structure
async function createCampaignStructure(adAccountId, campaignData) {
  try {
    const { name, objective, budget, media, copy, audience, startTime, endTime } = campaignData;
    
    // 1. Create Campaign
    const campaign = await fb(`/${adAccountId}/campaigns`, "POST", {
      name: name,
      objective: objective || "CONVERSIONS",
      status: "PAUSED", // Create paused by default
      special_ad_categories: []
    });
    const campaignId = campaign.id;
    
    // 2. Create Ad Set
    const adSet = await fb(`/${adAccountId}/adsets`, "POST", {
      name: `${name} - Ad Set`,
      campaign_id: campaignId,
      daily_budget: Math.round(budget * 100), // Convert to cents
      billing_event: "IMPRESSIONS",
      optimization_goal: objective === "CONVERSIONS" ? "OFFSITE_CONVERSIONS" : "REACH",
      targeting: audience || {},
      status: "PAUSED",
      ...(startTime && { start_time: startTime }),
      ...(endTime && { end_time: endTime })
    });
    const adSetId = adSet.id;
    
    // 3. Create Ad Creative (if media provided)
    let creativeId = null;
    if (media && media.imageHash) {
      const pageId = process.env.META_PAGE_ID;
      if (!pageId) {
        throw new Error("PAGE_ID required. Set META_PAGE_ID environment variable.");
      }
      
      const creativeData = {
        name: (copy?.headline || name).substring(0, 50) || "Ad Creative",
        object_story_spec: {
          page_id: pageId,
          link_data: {
            image_hash: media.imageHash,
            link: process.env.SHOP_URL || "https://maromcosmetic.com",
            message: copy?.text || copy?.headline || "",
            name: copy?.headline || name
          }
        }
      };
      
      creativeId = await fb(`/${adAccountId}/adcreatives`, "POST", creativeData);
      creativeId = creativeId.id;
    }
    
    // 4. Create Ad
    const ad = await fb(`/${adAccountId}/ads`, "POST", {
      name: `${name} - Ad`,
      adset_id: adSetId,
      creative: creativeId ? { creative_id: creativeId } : undefined,
      status: "PAUSED"
    });
    
    return {
      campaignId,
      adSetId,
      adId: ad.id,
      creativeId
    };
  } catch (err) {
    console.error("[Meta] Error creating campaign structure:", err.response?.data || err.message);
    throw new Error(`Failed to create campaign: ${err.message}`);
  }
}

// Start media workflow
async function startMediaWorkflow(from) {
  setUserWorkflow(from, {
    workflow: WORKFLOWS.GENERATE_MEDIA,
    step: 1,
    data: {}
  });
  
  let msg = `🎨 *GENERATE MEDIA*\n\n`;
  msg += `*Step 1/3: Which product?*\n`;
  msg += `📦 Type product name or say "list products"\n\n`;
  msg += `Examples:\n• "shampoo"\n• "moringa conditioner"`;
  
  await sendWhatsAppMessage(from, msg);
}

// Handle media workflow steps
async function handleMediaWorkflowStep(from, messageText, workflow) {
  await sendWhatsAppMessage(from, "Media workflow coming soon! Use /image <product> for now.");
  clearWorkflow(from);
}

// Start manage campaigns workflow
async function startManageCampaignsWorkflow(from) {
  await sendWhatsAppMessage(from, "📊 *MANAGE CAMPAIGNS*\n\nUse /campaigns to list all campaigns, or /stats for performance data.");
  clearWorkflow(from);
}

// Handle manage campaigns workflow
async function handleManageCampaignsWorkflow(from, messageText, workflow) {
  await sendWhatsAppMessage(from, "Use /campaigns, /pause, /resume, or /budget commands.");
  clearWorkflow(from);
}

// Start analyze performance workflow
async function startAnalyzePerformanceWorkflow(from) {
  await sendWhatsAppMessage(from, "📈 *ANALYZE PERFORMANCE*\n\nUse /stats for performance data, or /best for top campaigns.");
  clearWorkflow(from);
}

// Handle analyze performance workflow
async function handleAnalyzePerformanceWorkflow(from, messageText, workflow) {
  await sendWhatsAppMessage(from, "Use /stats, /best, or /campaigns commands.");
  clearWorkflow(from);
}

// Start manage products workflow
async function startManageProductsWorkflow(from) {
  await sendWhatsAppMessage(from, "📦 *MANAGE PRODUCTS*\n\nUse /products to list, /product <name> for details, or /product edit <name> to update.");
  clearWorkflow(from);
}

// Handle manage products workflow
async function handleManageProductsWorkflow(from, messageText, workflow) {
  await sendWhatsAppMessage(from, "Use /products, /product <name>, or /product edit commands.");
  clearWorkflow(from);
}

// Show quick actions
async function showQuickActions(from) {
  let msg = `⚡ *QUICK ACTIONS*\n\n`;
  msg += `• "create campaign for shampoo $50/day"\n`;
  msg += `• "generate image pack for conditioner"\n`;
  msg += `• "show stats"\n`;
  msg += `• "pause campaign X"\n`;
  msg += `• "list products"\n\n`;
  msg += `Or use commands:\n`;
  msg += `• /stats\n`;
  msg += `• /campaigns\n`;
  msg += `• /products\n`;
  msg += `• /image <product>\n`;
  msg += `• /createad <product> <budget>`;
  
  await sendWhatsAppMessage(from, msg);
  clearWorkflow(from);
}

// Check if message is a shortcut
export function isShortcut(text) {
  const lower = text.toLowerCase();
  return lower.includes("create campaign") || lower.includes("generate image") ||
         lower.includes("show stats") || lower.includes("list products");
}

// Handle shortcut
export async function handleShortcut(from, messageText, executeCommand) {
  const lower = messageText.toLowerCase();
  
  if (lower.includes("create campaign")) {
    // Extract product and budget
    const productMatch = lower.match(/for\s+([^$]+)/);
    const budgetMatch = messageText.match(/\$?(\d+(?:\.\d+)?)/);
    
    const productName = productMatch ? productMatch[1].trim() : null;
    const budget = budgetMatch ? parseFloat(budgetMatch[1]) : null;
    
    await startCampaignWorkflow(from, productName);
    if (budget) {
      // Pre-fill budget in workflow
      setTimeout(() => {
        const workflow = getUserWorkflow(from);
        if (workflow && workflow.workflow === WORKFLOWS.CREATE_CAMPAIGN) {
          updateWorkflowData(from, { budget });
        }
      }, 1000);
    }
  } else if (lower.includes("generate image") || lower.includes("create image")) {
    await startMediaWorkflow(from);
  } else if (lower.includes("show stats") || lower.includes("stats")) {
    await executeCommand(from, "/stats", [], false);
  } else if (lower.includes("list products")) {
    await executeCommand(from, "/products", [], false);
  } else {
    await showMainMenu(from);
  }
}

