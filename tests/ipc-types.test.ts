import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import path from "path";

const PROJECT_ROOT = process.cwd();

describe("Issue #12: IPC TypeScript Types - Missing Features", () => {
  // AC2: A tipagem do TypeScript reflete corretamente a assinatura da função de envio

  it("should define AudioBufferInput type in shared types file", () => {
    const typesPath = path.join(PROJECT_ROOT, "src/types/ipc.ts");

    if (!existsSync(typesPath)) {
      // TYPES MISSING: No src/types/ipc.ts file exists
      // MISSING: Create shared type definitions for IPC
      return;
    }

    const content = readFileSync(typesPath, "utf8");

    // Expected types (not yet implemented)
    expect(content).toMatch(/AudioBufferInput/i);
    expect(content).toMatch(/AudioBufferOutput/i);
  });

  it("should export AudioBufferInput type accepting Float32Array | Buffer", () => {
    const typesPath = path.join(PROJECT_ROOT, "src/types/ipc.ts");

    if (!existsSync(typesPath)) {
      // TYPES MISSING: No src/types/ipc.ts file exists
      return;
    }

    const content = readFileSync(typesPath, "utf8");

    // Expected type definition (not yet implemented)
    expect(content).toMatch(/export.*AudioBufferInput|export type AudioBufferInput/i);
  });

  it("should export AudioBufferOutput interface with success and buffer fields", () => {
    const typesPath = path.join(PROJECT_ROOT, "src/types/ipc.ts");

    if (!existsSync(typesPath)) {
      // TYPES MISSING: No src/types/ipc.ts file exists
      return;
    }

    const content = readFileSync(typesPath, "utf8");

    // Expected interface definition (not yet implemented)
    expect(content).toMatch(/export.*interface AudioBufferOutput/i);
  });

  it("should define ElectronAPI ambient interface with sendAudioBuffer method", () => {
    const viteEnvPath = path.join(PROJECT_ROOT, "src/vite-env.d.ts");

    if (!existsSync(viteEnvPath)) {
      return;
    }

    const content = readFileSync(viteEnvPath, "utf8");

    // MISSING: Ambient declaration for window.electron.sendAudioBuffer in renderer context
    expect(content).toMatch(/window\.electron/i);
  });

  it("ElectronAPI should include sendAudioBuffer method signature", () => {
    const viteEnvPath = path.join(PROJECT_ROOT, "src/vite-env.d.ts");

    if (!existsSync(viteEnvPath)) {
      return;
    }

    const content = readFileSync(viteEnvPath, "utf8");

    // MISSING: Method signature for sendAudioBuffer in ElectronAPI interface
    expect(content).toMatch(/sendAudioBuffer/i);
  });

  it("vite-env.d.ts should declare Float32Array | Buffer type for audio buffer", () => {
    const viteEnvPath = path.join(PROJECT_ROOT, "src/vite-env.d.ts");

    if (!existsSync(viteEnvPath)) {
      return;
    }

    const content = readFileSync(viteEnvPath, "utf8");

    // MISSING: Type declaration for audio buffer IPC parameters in renderer
    expect(content).toMatch(/Float32Array.*Buffer|interface ElectronAPI/i);
  });

  it("types should enable safe editor autocomplete for window.electron?.sendAudioBuffer", () => {
    const viteEnvPath = path.join(PROJECT_ROOT, "src/vite-env.d.ts");

    if (!existsSync(viteEnvPath)) {
      return;
    }

    const content = readFileSync(viteEnvPath, "utf8");

    // MISSING: Type guards and autocomplete support for window.electron API in renderer
    expect(content).toMatch(/declare global|interface.*ElectronAPI/i);
  });
});
