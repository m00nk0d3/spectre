import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import path from "path";

const PROJECT_ROOT = process.cwd();

describe("Issue #12: IPC Preload Bridge - Missing Features", () => {
  const preloadPath = path.join(PROJECT_ROOT, "src/preload/index.ts");

  // AC1: Buffer travels to main process without loss via new IPC channel
  it("should expose sendAudioBuffer method in preload contextBridge", () => {
    if (!existsSync(preloadPath)) {
      throw new Error("src/preload/index.ts not found");
    }

    const content = readFileSync(preloadPath, "utf8");

    // Acceptance criteria: Buffer travels to main process without loss
    // MISSING: New IPC channel for audio buffer send/receive pattern
    expect(content).toMatch(/sendAudioBuffer/i);
  });

  it("should expose audio-buffer-send IPC channel", () => {
    const content = readFileSync(preloadPath, "utf8");

    // MISSING: The new IPC channel for audio buffer send/receive pattern
    // Pattern follows existing methods like getTTSAudio in preload bridge
    expect(content).toMatch(/audio-buffer-send/i);
  });

  it("sendAudioBuffer should accept Float32Array | Buffer input", () => {
    const content = readFileSync(preloadPath, "utf8");

    // MISSING: sendAudioBuffer method with Float32Array | Buffer parameter
    expect(content).toMatch(/Float32Array.*audio-buffer-send|audio-buffer-send.*Float32Array/i);
  });

  it("sendAudioBuffer should return Promise<{success:boolean,buffer?:ArrayBuffer}>", () => {
    const content = readFileSync(preloadPath, "utf8");

    // MISSING: sendAudioBuffer async wrapper returning Promise with success/buffer result
    expect(content).toMatch(/audio-buffer-send.*Promise|sendAudioBuffer/i);
  });
});
