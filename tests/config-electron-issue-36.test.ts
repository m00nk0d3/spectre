import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import path from "path";

const PROJECT_ROOT = process.cwd();

describe("Issue #36: Fix Broken Electron Dev/Build Scripts", () => {
  const packageJsonPath = path.join(PROJECT_ROOT, "package.json");
  const viteConfigPath = path.join(PROJECT_ROOT, "vite.config.ts");
  const electronViteConfigPath = path.join(PROJECT_ROOT, "electron.vite.config.ts");
  const vitestConfigPath = path.join(PROJECT_ROOT, "vitest.config.ts");

  it("should use electron-vite dev script", () => {
    if (!existsSync(packageJsonPath)) {
      throw new Error("package.json not found");
    }

    const content = readFileSync(packageJsonPath, "utf8");

    // AC-001: npm run dev must launch Electron window
    // Expected: "dev": "electron-vite dev"
    expect(content).toMatch(/["\']dev["\']:\s*["\']electron-vite dev/i);
  });

  it("should use electron-vite build script", () => {
    if (!existsSync(packageJsonPath)) {
      throw new Error("package.json not found");
    }

    const content = readFileSync(packageJsonPath, "utf8");

    // AC-002 & AC-003: npm run build must compile with electron-vite
    // Expected: "build": "electron-vite build"
    expect(content).toMatch(/["\']build["\']:\s*["\']electron-vite build/i);
  });

  it("should not prefix build:electron with vite build", () => {
    if (!existsSync(packageJsonPath)) {
      throw new Error("package.json not found");
    }

    const content = readFileSync(packageJsonPath, "utf8");

    // AC-003: build:electron should use electron-builder directly (no vite build prefix)
    // Expected to NOT have "vite build &&" at start of build:electron command
    expect(content).not.toMatch(/build:electron.*vite\s+build/i);
  });

  it("should invoke electron-builder for packaging", () => {
    if (!existsSync(packageJsonPath)) {
      throw new Error("package.json not found");
    }

    const content = readFileSync(packageJsonPath, "utf8");

    // AC-003: Build must produce deployable artifacts
    expect(content).toMatch(/build:electron.*electron-builder/i);
  });

  it("should structure vite.config.ts as pure Vite for renderer", () => {
    if (!existsSync(viteConfigPath)) {
      throw new Error("vite.config.ts not found");
    }

    const content = readFileSync(viteConfigPath, "utf8");

    // INF-001: vite.config.ts must be pure Vite, not electron-vite
    expect(content).toMatch(/import\s+\{[^}]*defineConfig[^}]*\}\s+from\s+["\']vite["\']/);
  });

  it("should structure electron.vite.config.ts as electron-vite for main/preload", () => {
    if (!existsSync(electronViteConfigPath)) {
      throw new Error("electron.vite.config.ts not found");
    }

    const content = readFileSync(electronViteConfigPath, "utf8");

    // INF-001: electron.vite.config.ts must use electron-vite.defineConfig
    expect(content).toMatch(/import\s+\{[^}]*defineConfig[^}]*\}\s+from\s+["\']electron-vite["\']/);
  });

  it("should define main entry in electron.vite.config.ts", () => {
    if (!existsSync(electronViteConfigPath)) {
      throw new Error("electron.vite.config.ts not found");
    }

    const content = readFileSync(electronViteConfigPath, "utf8");

    // INF-002: Electron-Vite expects main entry point
    expect(content).toMatch(/main:\s*["\']src\/main\/main\.ts["\']/);
  });

  it("should list preload scripts in electron.vite.config.ts", () => {
    if (!existsSync(electronViteConfigPath)) {
      throw new Error("electron.vite.config.ts not found");
    }

    const content = readFileSync(electronViteConfigPath, "utf8");

    // INF-002: Preload scripts must be explicitly listed
    expect(content).toMatch(/preload:\s*\[[^\]]*["\']src\/preload\/index\.ts["\'][^\]]*\]/);
  });

  it("should not include build.output in electron.vite.config.ts", () => {
    if (!existsSync(electronViteConfigPath)) {
      throw new Error("electron.vite.config.ts not found");
    }

    const content = readFileSync(electronViteConfigPath, "utf8");

    // INF-002: build.rollupOptions.output not needed for electron-vite
    expect(content).not.toMatch(/build:\s*\{[^}]*rollupOptions/i);
  });

  it("should exclude worktrees from vitest", () => {
    if (!existsSync(vitestConfigPath)) {
      throw new Error("vitest.config.ts not found");
    }

    const content = readFileSync(vitestConfigPath, "utf8");

    // INF-004: Tests should not pick up stale .sandcastle/worktrees/ copies
    expect(content).toMatch(/exclude:\s*\[[^\]]*\]\s*,?\s*\}/);
  });

  it("should exclude worktrees path in vitest config", () => {
    if (!existsSync(vitestConfigPath)) {
      throw new Error("vitest.config.ts not found");
    }

    const content = readFileSync(vitestConfigPath, "utf8");

    // INF-004: Pattern to exclude worktrees
    expect(content).toMatch(/\*\*\/worktrees\/\*\*/);
  });

  it("should retain preview script as vite preview", () => {
    if (!existsSync(packageJsonPath)) {
      throw new Error("package.json not found");
    }

    const content = readFileSync(packageJsonPath, "utf8");

    // AC-005: preview command unchanged (still works)
    expect(content).toMatch(/["\']preview["\']:\s*["\']vite preview/i);
  });
});
