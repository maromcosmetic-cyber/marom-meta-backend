/**
 * Prompt Enhancer Service
 * Enhances short user prompts with company profile and brand guidelines
 */

/**
 * Enhance a short prompt with company profile context
 * @param {string} shortPrompt - User's short prompt
 * @param {object} companyProfile - Company profile object
 * @param {object} options - Enhancement options
 * @returns {string} Enhanced prompt
 */
export function enhancePrompt(shortPrompt, companyProfile, options = {}) {
  if (!shortPrompt || typeof shortPrompt !== "string" || shortPrompt.trim().length === 0) {
    return shortPrompt; // Return original if empty
  }

  const prompt = shortPrompt.trim();
  
  // If no company profile, return original prompt
  if (!companyProfile) {
    console.warn("[Prompt Enhancer] No company profile provided, returning original prompt");
    return prompt;
  }

  // Build enhancement parts
  const enhancements = [];

  // 1. Brand context
  if (companyProfile.name) {
    enhancements.push(`Brand: ${companyProfile.name}`);
  }

  if (companyProfile.industry) {
    enhancements.push(`Industry: ${companyProfile.industry}`);
  }

  // 2. Brand values
  if (companyProfile.brandValues) {
    const values = typeof companyProfile.brandValues === "string" 
      ? companyProfile.brandValues 
      : Array.isArray(companyProfile.brandValues) 
        ? companyProfile.brandValues.join(", ")
        : "";
    
    if (values) {
      enhancements.push(`Brand values: ${values}`);
    }
  }

  // 3. Visual style preferences
  if (companyProfile.preferences && companyProfile.preferences.imageStylePreferences) {
    const style = companyProfile.preferences.imageStylePreferences;
    if (typeof style === "string" && style.trim()) {
      enhancements.push(`Visual style: ${style}`);
    } else if (Array.isArray(style) && style.length > 0) {
      enhancements.push(`Visual style: ${style.join(", ")}`);
    }
  }

  // 4. Brand colors (if available)
  if (companyProfile.preferences && companyProfile.preferences.brandColors) {
    const colors = companyProfile.preferences.brandColors;
    if (typeof colors === "string" && colors.trim()) {
      enhancements.push(`Brand colors: ${colors}`);
    } else if (Array.isArray(colors) && colors.length > 0) {
      enhancements.push(`Brand colors: ${colors.join(", ")}`);
    }
  }

  // 5. Target audience alignment
  if (companyProfile.targetAudience) {
    enhancements.push(`Target audience: ${companyProfile.targetAudience}`);
  }

  // 6. Content themes (if available)
  if (companyProfile.preferences && companyProfile.preferences.contentThemes) {
    const themes = companyProfile.preferences.contentThemes;
    if (typeof themes === "string" && themes.trim()) {
      enhancements.push(`Content themes: ${themes}`);
    } else if (Array.isArray(themes) && themes.length > 0) {
      enhancements.push(`Content themes: ${themes.join(", ")}`);
    }
  }

  // Build enhanced prompt
  let enhancedPrompt = prompt;

  if (enhancements.length > 0) {
    const contextLine = enhancements.join(". ");
    
    // Add composition guidance based on whether images are provided
    let compositionGuidance = "";
    if (options.imageCount > 0) {
      if (options.imageCount === 1) {
        compositionGuidance = " Integrate the reference image naturally into the scene.";
      } else if (options.imageCount === 2) {
        compositionGuidance = " Compose the character and product naturally together in the scene.";
      } else if (options.imageCount === 3) {
        compositionGuidance = " Integrate character, product, and background harmoniously.";
      }
    }

    // Add UGC style guidance
    const styleGuidance = " Style: UGC-style photography, authentic moments, natural colors, professional quality.";

    enhancedPrompt = `Create a natural, warm-toned image that reflects ${companyProfile.name || "the brand"}'s values. ${contextLine}. ${prompt}${compositionGuidance}${styleGuidance}`;
  }

  // Limit length (some models have prompt limits)
  const maxLength = 4000;
  if (enhancedPrompt.length > maxLength) {
    console.warn(`[Prompt Enhancer] Prompt too long (${enhancedPrompt.length} chars), truncating`);
    enhancedPrompt = enhancedPrompt.substring(0, maxLength);
  }

  console.log(`[Prompt Enhancer] Enhanced prompt length: ${enhancedPrompt.length} characters`);
  console.log(`[Prompt Enhancer] Original: "${prompt}"`);
  console.log(`[Prompt Enhancer] Enhanced: "${enhancedPrompt.substring(0, 150)}..."`);

  return enhancedPrompt;
}

