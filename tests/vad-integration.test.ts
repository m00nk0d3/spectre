import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { micVadNew } = vi.hoisted(() => ({
  micVadNew: vi.fn(),
}));

vi.mock("@ricky0123/vad-web", () => ({
  MicVAD: { new: micVadNew },
}));

import { createVad } from "../src/renderer/vad";

const PROJECT_ROOT = process.cwd();
const mainSource = readFileSync(
  path.join(PROJECT_ROOT, "src/main/main.ts"),
  "utf8",
);
const preloadSource = readFileSync(
  path.join(PROJECT_ROOT, "src/preload/index.ts"),
  "utf8",
);
const appSource = readFileSync(
  path.join(PROJECT_ROOT, "src/renderer/App.tsx"),
  "utf8",
);

interface CapturedVadOptions {
  processorType: string;
  baseAssetPath: string;
  onnxWASMBasePath: string;
  positiveSpeechThreshold: number;
  negativeSpeechThreshold: number;
  minSpeechMs: number;
  redemptionMs: number;
  onSpeechStart: () => Promise<void>;
  onSpeechEnd: (audio: Float32Array) => Promise<void>;
  onVADMisfire: () => void;
}

describe("VAD integration", () => {
  const instance = {
    start: vi.fn(async () => undefined),
    pause: vi.fn(async () => undefined),
    destroy: vi.fn(async () => undefined),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    micVadNew.mockResolvedValue(instance);
    vi.stubGlobal("window", {
      location: new URL("file:///opt/spectre/out/renderer/index.html"),
    });
  });

  describe("Electron microphone boundary", () => {
    it("enables the audio context and grants only media permission", () => {
      expect(mainSource).toMatch(/audioContext:\s*true/);
      expect(mainSource).toMatch(
        /setPermissionRequestHandler[\s\S]*callback\(permission === "media"\)/,
      );
    });

    it("tracks speech IPC state transitions", () => {
      expect(mainSource).toMatch(/let\s+isSpeechActive\s*=\s*false/);
      expect(mainSource).toMatch(
        /handle\("speech-start"[\s\S]*if\s*\(!isSpeechActive\)/,
      );
      expect(mainSource).toMatch(
        /handle\("speech-end"[\s\S]*isSpeechActive\s*=\s*false/,
      );
    });

    it("preserves transparent always-on-top window behavior", () => {
      expect(mainSource).toMatch(/transparent:\s*true/);
      expect(mainSource).toMatch(/alwaysOnTop:\s*true/);
      expect(mainSource).toMatch(/windowClassName/);
    });

    it("exposes typed speech lifecycle methods through preload", () => {
      expect(preloadSource).toMatch(/notifySpeechStart/);
      expect(preloadSource).toMatch(/notifySpeechEnd/);
    });
  });

  describe("MicVAD lifecycle", () => {
    it("loads the packaged local worklet, ONNX, and WASM assets", async () => {
      const vad = createVad();

      await vad.start();

      expect(micVadNew).toHaveBeenCalledOnce();
      const options = micVadNew.mock.calls[0][0] as CapturedVadOptions;
      expect(options).toMatchObject({
        processorType: "AudioWorklet",
        baseAssetPath: "spectre://renderer/",
        onnxWASMBasePath: "spectre://renderer/",
      });
      expect(instance.start).toHaveBeenCalledOnce();
    });

    it("uses bounded speech and silence thresholds", async () => {
      const vad = createVad({ silenceTimeoutMs: 900 });

      await vad.start();

      const options = micVadNew.mock.calls[0][0] as CapturedVadOptions;
      expect(options.positiveSpeechThreshold).toBe(0.5);
      expect(options.negativeSpeechThreshold).toBe(0.35);
      expect(options.minSpeechMs).toBe(500);
      expect(options.redemptionMs).toBe(900);
    });

    it("updates state and forwards completed microphone audio", async () => {
      const onSpeechStart = vi.fn();
      const onSpeechEnd = vi.fn();
      const vad = createVad({ onSpeechStart, onSpeechEnd });
      const audio = new Float32Array([0.1, -0.2, 0.3]);
      await vad.start();
      const options = micVadNew.mock.calls[0][0] as CapturedVadOptions;

      await options.onSpeechStart();
      expect(vad.state.isSpeaking).toBe(true);
      expect(vad.state.lastSpeechTime).toEqual(expect.any(Number));
      expect(onSpeechStart).toHaveBeenCalledOnce();

      await options.onSpeechEnd(audio);
      expect(vad.state.isSpeaking).toBe(false);
      expect(onSpeechEnd).toHaveBeenCalledWith(audio);
    });

    it("clears speaking state after a VAD misfire", async () => {
      const vad = createVad();
      await vad.start();
      const options = micVadNew.mock.calls[0][0] as CapturedVadOptions;

      await options.onSpeechStart();
      options.onVADMisfire();

      expect(vad.state.isSpeaking).toBe(false);
    });

    it("pauses capture and destroys the VAD instance during cleanup", async () => {
      const vad = createVad();
      await vad.start();

      await vad.stop();
      expect(vad.state.isSpeaking).toBe(false);
      expect(instance.pause).toHaveBeenCalledOnce();

      await vad.cleanup();
      expect(instance.destroy).toHaveBeenCalledOnce();
    });

    it("reports initialization failures without hiding them", async () => {
      const expectedError = new Error("Microphone unavailable");
      const onError = vi.fn();
      micVadNew.mockRejectedValueOnce(expectedError);
      const vad = createVad({ onError });

      await expect(vad.start()).rejects.toThrow("Microphone unavailable");
      expect(onError).toHaveBeenCalledWith(expectedError);
    });
  });

  describe("renderer wiring", () => {
    it("connects VAD callbacks, playback analysis, and cleanup", () => {
      expect(appSource).toMatch(/createVad\(\{/);
      expect(appSource).toMatch(/onSpeechStart/);
      expect(appSource).toMatch(/onSpeechEnd/);
      expect(appSource).toMatch(/notifySpeechStart/);
      expect(appSource).toMatch(/notifySpeechEnd/);
      expect(appSource).toMatch(/vad\.cleanup\(\)/);
      expect(appSource).toMatch(/analysis\.amplitude/);
    });

    it("keeps VAD active during playback and preserves the prior transcript", () => {
      expect(appSource).not.toMatch(
        /onPlaybackStart:[\s\S]{0,120}vad\?\.stop/,
      );
      expect(appSource).toMatch(
        /onSpeechStart:[\s\S]{0,120}queue\.reset\(\)/,
      );
      expect(appSource).toMatch(
        /onSpeechStart:[\s\S]{0,180}cancelConversation\(\)/,
      );
      const speechStartBlock = appSource.match(
        /onSpeechStart:\s*async\s*\(\)\s*=>\s*\{([\s\S]*?)\n\s*\},/,
      )?.[1] ?? "";
      expect(speechStartBlock).not.toContain("setTranscript");
      expect(speechStartBlock).not.toContain("setReply");
    });

    it("waits for the local voice runtime and handles conversation failures", () => {
      expect(appSource).toMatch(
        /pythonStatusRequest\(\)[\s\S]{0,120}vad\?\.start\(\)/,
      );
      expect(appSource).toMatch(
        /onSpeechEnd:[\s\S]{0,260}catch\s*\(conversationError\)/,
      );
      expect(mainSource).toMatch(
        /python-status-request[\s\S]{0,100}serverResult\?\.ready\s*\?\?\s*false/,
      );
    });
  });
});
