#!/usr/bin/env node
/**
 * Vertex AI Configuration Diagnostic Tool
 * Run: node test-vertex.js
 * 
 * Note: Make sure .env file exists in the same directory
 */

import { GoogleAuth } from "google-auth-library";
import axios from "axios";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Load .env manually if dotenv not available
try {
  const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    envContent.split('\n').forEach(line => {
      const match = line.match(/^([^#=]+)=(.*)$/);
      if (match) {
        const key = match[1].trim();
        const value = match[2].trim().replace(/^["']|["']$/g, '');
        if (key && value) {
          process.env[key] = value;
        }
      }
    });
  }
} catch (err) {
  console.warn('Could not load .env file:', err.message);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log("=".repeat(60));
console.log("VERTEX AI CONFIGURATION DIAGNOSTIC");
console.log("=".repeat(60));
console.log();

// Check environment variables
console.log("1. Checking Environment Variables:");
console.log("-".repeat(60));

const checks = {
  GOOGLE_CLOUD_PROJECT: process.env.GOOGLE_CLOUD_PROJECT,
  GOOGLE_CLOUD_LOCATION: process.env.GOOGLE_CLOUD_LOCATION || "us-central1",
  GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS,
  GOOGLE_PRIVATE_KEY: process.env.GOOGLE_PRIVATE_KEY ? "***SET***" : undefined,
  GOOGLE_CLIENT_EMAIL: process.env.GOOGLE_CLIENT_EMAIL,
  GOOGLE_PRIVATE_KEY_ID: process.env.GOOGLE_PRIVATE_KEY_ID,
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
  GOOGLE_GENAI_USE_VERTEXAI: process.env.GOOGLE_GENAI_USE_VERTEXAI
};

let hasAllRequired = true;
for (const [key, value] of Object.entries(checks)) {
  const status = value ? "✓" : "✗";
  const displayValue = value || "NOT SET";
  console.log(`  ${status} ${key}: ${displayValue}`);
  if (!value && (key === "GOOGLE_CLOUD_PROJECT" || key === "GOOGLE_CLIENT_EMAIL")) {
    hasAllRequired = false;
  }
}

console.log();

// Check credentials file if set
if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.log("2. Checking Credentials File:");
  console.log("-".repeat(60));
  const credsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const fileExists = fs.existsSync(credsPath);
  console.log(`  File path: ${credsPath}`);
  console.log(`  File exists: ${fileExists ? "✓" : "✗"}`);
  
  if (fileExists) {
    try {
      const credsContent = fs.readFileSync(credsPath, "utf8");
      const creds = JSON.parse(credsContent);
      console.log(`  Project ID in file: ${creds.project_id || "NOT FOUND"}`);
      console.log(`  Client email: ${creds.client_email || "NOT FOUND"}`);
      console.log(`  Private key: ${creds.private_key ? "✓ PRESENT" : "✗ MISSING"}`);
    } catch (err) {
      console.log(`  ✗ Error reading file: ${err.message}`);
    }
  }
  console.log();
}

// Test authentication
console.log("3. Testing Authentication:");
console.log("-".repeat(60));

try {
  const authConfig = {
    scopes: ["https://www.googleapis.com/auth/cloud-platform"]
  };
  
  // Determine auth method
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    const credsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (fs.existsSync(credsPath)) {
      authConfig.keyFilename = credsPath;
      console.log(`  Using credentials file: ${credsPath}`);
    } else {
      throw new Error(`Credentials file not found: ${credsPath}`);
    }
  } else if (process.env.GOOGLE_PRIVATE_KEY && process.env.GOOGLE_CLIENT_EMAIL) {
    authConfig.credentials = {
      type: "service_account",
      project_id: process.env.GOOGLE_CLOUD_PROJECT,
      private_key_id: process.env.GOOGLE_PRIVATE_KEY_ID || "",
      private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      client_id: process.env.GOOGLE_CLIENT_ID || "",
      auth_uri: "https://accounts.google.com/o/oauth2/auth",
      token_uri: "https://oauth2.googleapis.com/token",
      auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
      client_x509_cert_url: `https://www.googleapis.com/robot/v1/metadata/x509/${encodeURIComponent(process.env.GOOGLE_CLIENT_EMAIL)}`
    };
    console.log(`  Using environment variables (client_email: ${process.env.GOOGLE_CLIENT_EMAIL})`);
  } else {
    throw new Error("No authentication method configured");
  }
  
  const auth = new GoogleAuth(authConfig);
  const client = await auth.getClient();
  const accessToken = await client.getAccessToken();
  
  if (accessToken.token) {
    console.log(`  ✓ Authentication successful!`);
    console.log(`  Token preview: ${accessToken.token.substring(0, 20)}...`);
  } else {
    throw new Error("No access token received");
  }
} catch (err) {
  console.log(`  ✗ Authentication failed: ${err.message}`);
  console.log(`  Error details: ${err.stack}`);
  process.exit(1);
}

console.log();

// Test Vertex AI API endpoint
console.log("4. Testing Vertex AI API Endpoint:");
console.log("-".repeat(60));

try {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT;
  const location = process.env.GOOGLE_CLOUD_LOCATION || "us-central1";
  const auth = new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    ...(process.env.GOOGLE_APPLICATION_CREDENTIALS && fs.existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS) 
      ? { keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS }
      : process.env.GOOGLE_PRIVATE_KEY && process.env.GOOGLE_CLIENT_EMAIL
      ? {
          credentials: {
            type: "service_account",
            project_id: projectId,
            private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
            client_email: process.env.GOOGLE_CLIENT_EMAIL
          }
        }
      : {})
  });
  
  const client = await auth.getClient();
  const accessToken = await client.getAccessToken();
  
  // Test endpoint: List models or check project access
  const testEndpoint = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}`;
  
  console.log(`  Testing endpoint: ${testEndpoint}`);
  console.log(`  Project ID: ${projectId}`);
  console.log(`  Location: ${location}`);
  
  try {
    const response = await axios.get(testEndpoint, {
      headers: {
        "Authorization": `Bearer ${accessToken.token}`,
        "Content-Type": "application/json"
      },
      timeout: 10000
    });
    
    console.log(`  ✓ Endpoint accessible!`);
    console.log(`  Response status: ${response.status}`);
  } catch (err) {
    if (err.response) {
      console.log(`  ✗ API Error: ${err.response.status} ${err.response.statusText}`);
      console.log(`  Error details: ${JSON.stringify(err.response.data, null, 2)}`);
      
      if (err.response.status === 403) {
        console.log();
        console.log("  ⚠️  PERMISSION DENIED - Common issues:");
        console.log("     - Vertex AI API not enabled in Google Cloud Console");
        console.log("     - Service account doesn't have 'Vertex AI User' role");
        console.log("     - Project billing not enabled");
      } else if (err.response.status === 404) {
        console.log();
        console.log("  ⚠️  NOT FOUND - Common issues:");
        console.log("     - Project ID is incorrect");
        console.log("     - Location/region is incorrect");
        console.log("     - Vertex AI API not enabled");
      }
    } else {
      console.log(`  ✗ Network/Timeout Error: ${err.message}`);
    }
    process.exit(1);
  }
} catch (err) {
  console.log(`  ✗ Test failed: ${err.message}`);
  console.log(`  Error details: ${err.stack}`);
  process.exit(1);
}

console.log();
console.log("=".repeat(60));
console.log("✓ ALL CHECKS PASSED!");
console.log("=".repeat(60));
console.log();
console.log("Next steps:");
console.log("  1. Ensure Vertex AI API is enabled in Google Cloud Console");
console.log("  2. Verify service account has 'Vertex AI User' role");
console.log("  3. Check that billing is enabled for your project");
console.log("  4. Try generating an image/video through your application");

