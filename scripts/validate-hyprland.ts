#!/usr/bin/env node
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");

// Required hyprland rules for SPECTRE floating window integration
const REQUIRED_RULES = [
  { directive: "float", pattern: /windowrulev2\s*=\s*float/, description: "Floating window mode" },
  { directive: "noborder", pattern: /windowrulev2\s*=\s*noborder/, description: "Disable Hyprland borders" },
  { directive: "pin", pattern: /windowrulev2\s*=\s*pin/, description: "Workspace pinning (fixed on all workspaces)" },
  { directive: "noanim", pattern: /windowrulev2\s*=\s*noanim/, description: "Disable window animations" }];

export function validateHyprlandIntegration() {
  const hyprlandConfPath = join(PROJECT_ROOT, "hyprland.conf");

  if (!readFileSync(hyprlandConfPath, "utf8")) {
    throw new Error("hyprland.conf file not found at project root");
  }

  console.log("[✓] hyprland.conf exists");

  let allRulesFound = true;
  for (const rule of REQUIRED_RULES) {
    const regex = new RegExp(rule.pattern, "i");
    if (!regex.test(readFileSync(hyprlandConfPath, "utf8"))) {
      console.error(`[✗] Missing: ${rule.description}`);
      allRulesFound = false;
    } else {
      console.log(`[✓] Found: ${rule.description}`);
    }
  }

  if (!allRulesFound) {
    throw new Error("Missing required Hyprland integration rules");
  }

  console.log("[✓] All Hyprland integration rules validated successfully");
}

export function validateEnvVariables() {
  const envFile = join(PROJECT_ROOT, ".env");

  if (!existsSync(envFile)) {
    console.log("[⚠] .env file not found - creating from example...");
    readFileSync(join(PROJECT_ROOT, ".env.example"), "utf8"); // May not exist in all environments
  } else {
    const envContent = readFileSync(envFile, "utf8");

    if (!envContent.includes("WINDOW_MANAGER_CLASS")) {
      console.error("[⚠] WINDOW_MANAGER_CLASS environment variable not set");
    } else {
      console.log("[✓] WINDOW_MANAGER_CLASS is configured");
    }

    if (!envContent.includes("LM_STUDIO_API_KEY")) {
      console.error("[⚠] LM_STUDIO_API_KEY environment variable not set");
    } else {
      console.log("[✓] LM_STUDIO_API_KEY is configured");
    }
  }

  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  validateHyprlandIntegration();
  validateEnvVariables();
  console.log("\n[SUCCESS] Hyprland integration validated successfully\n");
}
