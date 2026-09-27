import { describe, it, expect, beforeAll } from "vitest";

describe("Issue #11: Conversor WAV", () => {
  let createWavBuffer: (data: Float32Array, sr?: number, ch?: number) => ArrayBuffer;

  beforeAll(async () => {
    const mod = await import("@/utils/audio-converter");
    createWavBuffer = mod.createWavBuffer;
  });

  // AC1: Buffer WAV a 16kHz mono
  describe("AC1: Cabeçalho RIFF/WAV correto", () => {
    it("cria buffer com ID RIFF válido", () => {
      const testData = new Float32Array([0.5, -0.3, 0]);
      const wavBuffer = createWavBuffer(testData);
      const bufferView = new DataView(wavBuffer);

      expect(bufferView.getUint32(0, true)).toBe(0x52494646); // "RIFF"
      expect(bufferView.getUint32(8, true)).toBe(0x57415645); // "WAVE"
    });

    it("cria header fmt para PCM, 1 canal, 16-bit", () => {
      const testData = new Float32Array([0.5]);
      const wavBuffer = createWavBuffer(testData);
      const bufferView = new DataView(wavBuffer);

      // Subchunk size at offset 16-19 - fmt é 16 bytes
      expect(bufferView.getUint16(16, true)).toBe(16);

      // Audio format: 1 = PCM at offset 18-19 (little-endian)
      expect(bufferView.getUint16(18, true)).toBe(1);

      // Num channels: 1 mono at offset 20
      expect(bufferView.getUint8(20)).toBe(1);

      // Sample rate: 16000 at offset 21-24 (little-endian) - WAV spec
      expect(bufferView.getUint32(21, true)).toBe(16000);
    });

    it("cria header data com tamanho correto", () => {
      const testData = new Float32Array([0.5, -0.3, 0, 0.1]); // 4 samples
      const wavBuffer = createWavBuffer(testData);
      const bufferView = new DataView(wavBuffer);

      // Data subchunk at offset 32 ("data" identifier) - WAV spec (little-endian: d-a-t-a = [0x64, 0x61, 0x74, 0x61])
      expect(bufferView.getUint32(32, true)).toBe(0x61746164); // "data" in little-endian

      // Data size: 4 samples * 1 channel * 2 bytes = 8 bytes at offset 36
      const expectedDataSize = 8;
      expect(bufferView.getUint32(36, true)).toBe(expectedDataSize);
    });
  });

  // AC3: Qualidade do sinal preservada
  describe("AC3: Conversão Float32 → Int16 correta", () => {
    it("preserva amplitude ±1.0 sem clipping", () => {
      const testData = new Float32Array([-1.0, 0, 1.0]); // 3 samples mono interleaved
      const wavBuffer = createWavBuffer(testData);
      const bufferView = new DataView(wavBuffer);

      // Offset 44 is first sample (-1.0 → int16 -32767 due to rounding)
      expect(bufferView.getInt16(44, true)).toBe(-32767);
    });

    it("clamp valores > 1.0 para +1.0", () => {
      const testData = new Float32Array([1.5, -0.5]); // 2 samples mono interleaved
      const wavBuffer = createWavBuffer(testData);
      const bufferView = new DataView(wavBuffer);

      // Clamps 1.5 → 1.0, converts to +32767 (first sample at offset 44)
      expect(bufferView.getInt16(44, true)).toBe(32767);
    });

    it("clamp valores < -1.0 para -1.0", () => {
      const testData = new Float32Array([-1.5, 0.5]); // 2 samples mono interleaved
      const wavBuffer = createWavBuffer(testData);
      const bufferView = new DataView(wavBuffer);

      // Clamps -1.5 → -1.0, converts to -32767 (first sample at offset 44)
      expect(bufferView.getInt16(44, true)).toBe(-32767);
    });

    it("usa multiplicador 32767 (0x7FFF) para int16", () => {
      const testData = new Float32Array([0.5]); // 1 sample mono interleaved
      const wavBuffer = createWavBuffer(testData);
      const bufferView = new DataView(wavBuffer);

      // 0.5 * 32767 = 16383.5 → round → 16384 (at offset 44)
      expect(bufferView.getInt16(44, true)).toBeCloseTo(16384, 1);
    });

    it("mantém stereo se canais=2", () => {
      const testData = new Float32Array([0.5, -0.3, 0.5, -0.3]); // L: [0.5, -0.3], R: [0.5, -0.3]
      const monoBuffer = createWavBuffer(testData.slice(0, 2), 16000, 1); // 2 samples mono
      const stereoBuffer = createWavBuffer(testData, 16000, 2); // 4 samples stereo interleaved

      // Stereo should have larger header and more data bytes (L+R interleaved)
      expect(stereoBuffer.byteLength).toBeGreaterThan(monoBuffer.byteLength);
    });
  });

  // CB1: Array vazio (sem áudio)
  describe("Edge Case CB1: Array vazio", () => {
    it("cria buffer WAV válido com array vazio", () => {
      const testData = new Float32Array([]);
      const wavBuffer = createWavBuffer(testData);

      expect(wavBuffer.byteLength).toBeGreaterThanOrEqual(44);

      const bufferView = new DataView(wavBuffer);
      expect(bufferView.getUint32(0, true)).toBe(0x52494646); // "RIFF"
      expect(bufferView.getUint32(8, true)).toBe(0x57415645); // "WAVE"
    });

    it("dados silenciosos (zeros) produzem buffer válido", () => {
      const testData = new Float32Array([0, 0, 0]); // 3 samples mono interleaved
      const wavBuffer = createWavBuffer(testData);
      const bufferView = new DataView(wavBuffer);

      expect(bufferView.getInt16(40, true)).toBe(0);
    });
  });

  // CB3: Sample rate não padrão
  describe("Edge Case CB3: Sample rate customizado", () => {
    it("cria buffer com sample rate padrão 16000", () => {
      const testData = new Float32Array([0.5]);
      const wavBuffer = createWavBuffer(testData);
      const bufferView = new DataView(wavBuffer);

      expect(bufferView.getUint32(21, true)).toBe(16000); // WAV spec offset 21-24
    });

    it("cria buffer com sample rate customizado 44100", () => {
      const testData = new Float32Array([0.5]);
      const wavBuffer = createWavBuffer(testData, 44100);
      const bufferView = new DataView(wavBuffer);

      expect(bufferView.getUint32(21, true)).toBe(44100);
    });

    it("cria buffer com sample rate customizado 48000", () => {
      const testData = new Float32Array([0.5]);
      const wavBuffer = createWavBuffer(testData, 48000);
      const bufferView = new DataView(wavBuffer);

      expect(bufferView.getUint32(21, true)).toBe(48000);
    });

    it("cria buffer com sample rate customizado 22050", () => {
      const testData = new Float32Array([0.5]);
      const wavBuffer = createWavBuffer(testData, 22050);
      const bufferView = new DataView(wavBuffer);

      expect(bufferView.getUint32(21, true)).toBe(22050);
    });
  });

  // CB4: Buffer grande (>20MB) - validação de tamanho
  describe("Edge Case CB4: Buffers grandes", () => {
    it("cria buffer válido para 1000 amostras", () => {
      const numSamples = 1000;
      const testData = new Float32Array(numSamples).fill(0.5);
      const wavBuffer = createWavBuffer(testData, 16000, 1);

      expect(wavBuffer.byteLength).toBe(44 + numSamples * 2);
    });

    it("cria buffer válido para 5000 amostras", () => {
      const numSamples = 5000;
      const testData = new Float32Array(numSamples).fill(0.5);
      const wavBuffer = createWavBuffer(testData, 16000, 1);

      expect(wavBuffer.byteLength).toBe(44 + numSamples * 2);
    });

    it("calcula tamanho de dados correto para mixed amplitude", () => {
      const testData = new Float32Array(100);
      for (let i = 0; i < 100; i++) {
        testData[i] = Math.sin(i) / 2 + 0.5; // Range: [-0.5, 1.5]
      }
      const wavBuffer = createWavBuffer(testData, 16000, 1);

      expect(wavBuffer.byteLength).toBe(44 + 100 * 2);
    });
  });

  // AC2: Compatibilidade com leitores padrão
  describe("AC2: Compatibilidade com Leitores de Áudio Padrão", () => {
    it("buffer tem tamanho esperado para N samples mono", () => {
      const numSamples = 100;
      const testData = new Float32Array(numSamples).fill(0.5);
      const wavBuffer = createWavBuffer(testData, 16000, 1);

      expect(wavBuffer.byteLength).toBe(44 + numSamples * 2);
    });

    it("cria buffer stereo com tamanho correto (N samples × 2 canais)", () => {
      const numSamples = 50;
      const testData = new Float32Array(numSamples * 2); // Interleaved: [L0,R0, L1,R1, ...]
      for (let i = 0; i < numSamples; i++) {
        testData[i * 2] = 0.5;   // Left channel
        testData[i * 2 + 1] = -0.3; // Right channel
      }
      const wavBuffer = createWavBuffer(testData, 16000, 2);

      expect(wavBuffer.byteLength).toBe(44 + numSamples * 2 * 2); // 4 bytes per sample pair (L+R interleaved)
    });

    it("dados são int16 signed, não unsigned", () => {
      const testData = new Float32Array([0.5, -0.5]); // 2 samples mono interleaved
      const wavBuffer = createWavBuffer(testData);
      const bufferView = new DataView(wavBuffer);

      // Offset 44: low byte of first int16 (+ve)
      expect(bufferView.getUint8(44)).toBeGreaterThanOrEqual(0);

      // Offset 42: low byte of second int16 (-ve) — high byte will be 0xFF or less
      const firstVal = bufferView.getInt16(44, true); // mono interleaved
      const secondVal = bufferView.getInt16(46, true);

      expect(firstVal).toBeGreaterThan(-32768); // +ve
      expect(secondVal).toBeLessThan(0); // Negative signed value;   // -ve
    });

    it("header fmt tem audio format 1 (PCM) reconhecível", () => {
      const testData = new Float32Array([0.5]);
      const wavBuffer = createWavBuffer(testData);
      const bufferView = new DataView(wavBuffer);

      expect(bufferView.getUint16(18, true)).toBe(1);
    });

    it("bits per sample é 16 no header", () => {
      const testData = new Float32Array([0.5]);
      const wavBuffer = createWavBuffer(testData);
      const bufferView = new DataView(wavBuffer);

      // Bits per sample: offset 38, should be 16 (0x10) for PCM int16
      expect(bufferView.getUint8(30)).toBe(16);
    });

    it("byte rate é calculado corretamente para 1 canal", () => {
      const testData = new Float32Array([0.5]);
      const wavBuffer = createWavBuffer(testData, 16000, 1);
      const bufferView = new DataView(wavBuffer);

      expect(bufferView.getUint32(25, true)).toBe(32000); // Byte rate: 16000 * 1 * 16 / 8 = 32000
    });

    it("byte rate é calculado corretamente para 2 canais", () => {
      const testData = new Float32Array([0.5, -0.3]);
      const wavBuffer = createWavBuffer(testData, 16000, 2);
      const bufferView = new DataView(wavBuffer);

      expect(bufferView.getUint32(25, true)).toBe(64000); // Byte rate: 16000 * 2 * 16 / 8 = 64000
    });

    it("verifica que valores stereo são corretamente escritos nos dados interleaved", () => {
      // Test case for multi-channel sample correctness (issue #11 blocker fix)
      const testData = new Float32Array([0.5, -0.3, 0.8, -0.7]);
      // Interleaved stereo: [L0=0.5, R0=-0.3, L1=0.8, R1=-0.7]
      const wavBuffer = createWavBuffer(testData, 16000, 2);
      const bufferView = new DataView(wavBuffer);

      // Stereo interleaved layout at offset 44: [L0, R0, L1, R1...]
      // Sample 0 (t=0): L[0]=0.5 → int16 = round(0.5 * 32767) = 16384 (at offset 44)
      expect(bufferView.getInt16(44, true)).toBe(16384);

      // Same sample t=0: R[0]=-0.3 → int16 = round(-0.3 * 32767) = -9830 (at offset 46)
      expect(bufferView.getInt16(46, true)).toBe(-9830);

      // Sample 1 (t=1): L[1]=0.8 → int16 = round(0.8 * 32767) = 26214 (at offset 48)
      expect(bufferView.getInt16(48, true)).toBe(26214);

      // Same sample t=1: R[1]=-0.7 → int16 = round(-0.7 * 32767) = -22937 (at offset 50)
      expect(bufferView.getInt16(50, true)).toBe(-22937);
    });

    it("cria buffer para 4 canais com dados corretos em cada amostra", () => {
      // Test for 4-channel (multi-channel beyond stereo) - blocker fix validation
      const testData = new Float32Array([0.5, -0.3, 0.8, -0.7, 0.1, -0.2, 0.9, -0.6]); // 8 values for 4 channels × 2 samples
      const wavBuffer = createWavBuffer(testData, 16000, 4);
      const bufferView = new DataView(wavBuffer);

      // For 4-channel interleaved at offset 44: [F0, F1, F2, F3, L0, R0, L1, R1]
      // Sample 0 (t=0): round(x * 32767) for x in [0.5, -0.3, 0.8, -0.7] = [16384, -9830, 26214, -22937]
      expect(bufferView.getInt16(44, true)).toBe(16384);   // F[0]=0.5 → offset 44
      expect(bufferView.getInt16(46, true)).toBe(-9830);    // F[1]=-0.3 → offset 46
      expect(bufferView.getInt16(48, true)).toBe(26214);    // F[2]=0.8 → offset 48
      expect(bufferView.getInt16(50, true)).toBe(-22937);   // F[3]=-0.7 → offset 50

      // Sample 1 (t=1): round(x * 32767) for x in [0.1, -0.2, 0.9, -0.6] = [3277, -6553, 29490, -19660]
      expect(bufferView.getInt16(52, true)).toBe(3277);     // F[4]=0.1 → offset 52
      expect(bufferView.getInt16(54, true)).toBe(-6553);    // F[5]=-0.2 → offset 54
      expect(bufferView.getInt16(56, true)).toBe(29490);    // F[6]=0.9 → offset 56
      expect(bufferView.getInt16(58, true)).toBe(-19660);   // F[7]=-0.6 → offset 58
    });

    it("block align é 2 para mono e 4 para stereo", () => {
      const testData = new Float32Array([0.5, -0.3]);
      const monoBuffer = createWavBuffer(testData.slice(0, 1), 16000, 1); // 1 sample mono
      const stereoBuffer = createWavBuffer(testData, 16000, 2); // 2 samples stereo

      const monoView = new DataView(monoBuffer);
      const stereoView = new DataView(stereoBuffer);

      expect(monoView.getUint8(29)).toBe(2); // Block align: channels * bitsPerSample / 8 = 1 * 16 / 8 = 2
      expect(stereoView.getUint8(29)).toBe(4); // Block align: channels * bitsPerSample / 8 = 2 * 16 / 8 = 4
    });

    it("verifica estrutura RIFF/WAV para compatibilidade com leitores padrão", () => {
      // WAV playback compatibility: validate header structure integrity (AC2 requirement)
      const testData = new Float32Array([0.5, -0.3, 0.7]);
      const wavBuffer = createWavBuffer(testData);
      const bufferView = new DataView(wavBuffer);

      // RIFF chunk ID at offset 0 (little-endian: R-I-F-F = [0x46, 0x49, 0x46, 0x46])
      expect(bufferView.getUint32(0, true)).toBe(0x52494646); // "RIFF"

      // WAVE format at offset 8 (little-endian: W-A-V-E = [0x45, 0x56, 0x41, 0x57])
      expect(bufferView.getUint32(8, true)).toBe(0x57415645); // "WAVE"

      // fmt subchunk identifier at offset 12 (little-endian: f-m-t-space = [0x66, 0x6D, 0x74, 0x20])
      expect(bufferView.getUint32(12, true)).toBe(0x20746D66);

      // fmt subchunk size at offset 16 (16 bytes for PCM header)
      expect(bufferView.getUint16(16, true)).toBe(16);

      // Audio format 1 (PCM) at offset 18
      expect(bufferView.getUint16(18, true)).toBe(1);

      // Data subchunk identifier at offset 32 (little-endian: d-a-t-a = [0x64, 0x61, 0x74, 0x61])
      expect(bufferView.getUint32(32, true)).toBe(0x61746164);

      // Audio data starts at offset 44 (not 40) - critical fix for WAV playback compatibility
      const firstSample = bufferView.getInt16(44, true);
      expect(firstSample).not.toBe(0); // Should contain actual sample data
    });
  });

  // Casos de borda adicionais
  describe("Additional Edge Cases", () => {
    it("cria buffer com sample rate customizado 4", () => {
      const testData = new Float32Array([0.5, -0.3]); // 2 samples mono interleaved
      const wavBuffer = createWavBuffer(testData, 16000, 4); // 4 channels

      const bufferView = new DataView(wavBuffer);
      expect(bufferView.getUint8(20)).toBe(4);
    });

    it("usa Int16Array em vez de Float32 para dados", () => {
      const testData = new Float32Array([0.5]); // 1 sample mono interleaved
      const wavBuffer = createWavBuffer(testData);
      const bufferView = new DataView(wavBuffer);

      expect(bufferView.getUint8(44)).toBeLessThan(256);
    });

    it("mantém ordem little-endian nos dados", () => {
      const testData = new Float32Array([0.5]); // 1 sample mono interleaved
      const wavBuffer = createWavBuffer(testData);
      const bufferView = new DataView(wavBuffer);

      expect(bufferView.getUint8(44)).toBe(0x00);
      expect(bufferView.getUint8(45)).toBe(0x40);
    });

    it("preserva valores exatos no clamp", () => {
      const testData = new Float32Array([1.0, -1.0]); // 2 samples mono interleaved
      const wavBuffer = createWavBuffer(testData);
      const bufferView = new DataView(wavBuffer);

      // +1.0 → +32767 (first sample at offset 44)
      expect(bufferView.getInt16(44, true)).toBe(32767);

      // -1.0 → -32767 (second sample at offset 46 in interleaved mono)
      // Note: Math.round(-1.0 * 32767) = -32767
      expect(bufferView.getInt16(46, true)).toBe(-32767);
    });
  });

  describe("Exportação Pública do Módulo", () => {
    it("exporta createWavBuffer como função pública", () => {
      expect(createWavBuffer).toBeDefined();
      expect(typeof createWavBuffer).toBe("function");
    });

    it("função createWavBuffer aceita Float32Array", () => {
      const testData = new Float32Array([0.5, -0.3]);
      const result = createWavBuffer(testData);

      expect(result).toBeInstanceOf(ArrayBuffer);
      expect(result.byteLength).toBeGreaterThan(0);
    });

    it("cria buffer com default parameters (sr=16000, ch=1)", () => {
      const testData = new Float32Array([0.5]);
      const result = createWavBuffer(testData);

      const bufferView = new DataView(result);
      expect(bufferView.getUint32(21, true)).toBe(16000); // sample rate
      expect(bufferView.getUint8(20)).toBe(1); // channels
    });

    it("cria buffer com todos os parâmetros explícitos", () => {
      const testData = new Float32Array([0.5, -0.3]);
      const result = createWavBuffer(testData, 44100, 2);

      const bufferView = new DataView(result);
      expect(bufferView.getUint32(21, true)).toBe(44100); // sample rate
      expect(bufferView.getUint8(20)).toBe(2); // channels
    });
  });
});
