import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import path from "path";

const PROJECT_ROOT = process.cwd();
const HYPRLAND_CONF_PATH = path.join(PROJECT_ROOT, "hyprland.conf");

describe("Hyprland Integration", () => {
  it("should have hyprland.conf file at project root", () => {
    expect(existsSync(HYPRLAND_CONF_PATH)).toBe(true);
  });

  it("should contain float directive for floating windows", () => {
    const content = readFileSync(HYPRLAND_CONF_PATH, "utf8");
    expect(content).toMatch(/windowrulev2\s*=\s*float/i);
  });

  it("should contain noborder directive to disable Hyprland borders", () => {
    const content = readFileSync(HYPRLAND_CONF_PATH, "utf8");
    expect(content).toMatch(/windowrulev2\s*=\s*noborder/i);
  });

  it("should contain pin directive for workspace pinning", () => {
    const content = readFileSync(HYPRLAND_CONF_PATH, "utf8");
    expect(content).toMatch(/windowrulev2\s*=\s*pin/i);
  });

  it("should contain noanim directive to disable window animations", () => {
    const content = readFileSync(HYPRLAND_CONF_PATH, "utf8");
    expect(content).toMatch(/windowrulev2\s*=\s*noanim/i);
  });
});

describe("Main Process Hyprland Integration", () => {
  it("should define WINDOW_MANAGER_CLASS constant in main.ts", () => {
    const mainPath = path.join(PROJECT_ROOT, "src/main/main.ts");
    const content = readFileSync(mainPath, "utf8");

    // Check that windowClassName is assigned
    expect(content).toMatch(/windowClassName/i);
  });

  it("should use process.env.WINDOW_MANAGER_CLASS or default value", () => {
    const mainPath = path.join(PROJECT_ROOT, "src/main/main.ts");
    const content = readFileSync(mainPath, "utf8");

    // Check that environment variable is used for class name
    expect(content).toMatch(/WINDOW_MANAGER_CLASS/i);
  });
});

describe("Vite Config Security", () => {
  it("should not have server.host=true in production config", () => {
    const viteConfigPath = path.join(PROJECT_ROOT, "vite.config.ts");
    const content = readFileSync(viteConfigPath, "utf8");

    // Server host should only be true if explicitly set for dev mode
    // It should not have server.host: true as a default
    expect(content).not.toMatch(/server:\s*\{[^}]*host:\s*true/);
  });
});
