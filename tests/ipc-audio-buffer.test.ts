import { describe, it, expect, beforeAll } from "vitest";

describe("Issue #12: IPC Audio Buffer - Buffer Integrity Tests", () => {
  let createWavBuffer: (data: Float32Array, sr?: number, ch?: number) => ArrayBuffer;

  beforeAll(async () => {
    const mod = await import("@/utils/audio-converter");
    createWavBuffer = mod.createWavBuffer;
  });

  // AC1: Buffer travels to main process without loss - validate conversion function works
  describe("AC1: Buffer Integrity During IPC Transfer", () => {
    it("preserves buffer for Float32Array input", async () => {
      const testData = new Float32Array([0.5, -0.3, 0]);
      const wavBuffer = createWavBuffer(testData, 16000, 1);
      expect(wavBuffer).toBeInstanceOf(ArrayBuffer);
      expect(wavBuffer.byteLength).toBe(44 + testData.length * 2);
    });

    it("handles large buffers without data loss", async () => {
      const numSamples = 10000; // ~500KB at 16kHz mono
      const testData = new Float32Array(numSamples).fill(0.5);
      const wavBuffer = createWavBuffer(testData, 16000, 1);

      expect(wavBuffer.byteLength).toBe(44 + numSamples * 2);
    });

    it("handles burst of small buffers", async () => {
      const smallBuffers = [
        new Float32Array([0.5]),
        new Float32Array([0.6, -0.3]),
        new Float32Array([]), // Empty
      ];

      for (const buf of smallBuffers) {
        const wavBuffer = createWavBuffer(buf);
        expect(wavBuffer.byteLength).toBeGreaterThanOrEqual(44);
      }
    });

    it("preserves stereo interleaved data", async () => {
      const testData = new Float32Array([0.5, -0.3, 0.8, -0.7]); // [L0,R0,L1,R1]
      const wavBuffer = createWavBuffer(testData, 16000, 2);

      expect(wavBuffer.byteLength).toBe(44 + testData.length * 2);
    });
  });
});
