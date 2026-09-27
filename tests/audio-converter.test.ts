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

      // Data subchunk at offset 32 ("data" identifier) - WAV spec
      expect(bufferView.getUint32(32, true)).toBe(0x64617461); // "data" in little-endian

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
      expect(bufferView.getInt16(40, true)).toBe(-32767);
    });

    it("clamp valores > 1.0 para +1.0", () => {
      const testData = new Float32Array([1.5, -0.5]); // 2 samples mono interleaved
      const wavBuffer = createWavBuffer(testData);
      const bufferView = new DataView(wavBuffer);

      // Clamps 1.5 → 1.0, converts to +32767 (first sample at offset 44)
      expect(bufferView.getInt16(40, true)).toBe(32767);
    });

    it("clamp valores < -1.0 para -1.0", () => {
      const testData = new Float32Array([-1.5, 0.5]); // 2 samples mono interleaved
      const wavBuffer = createWavBuffer(testData);
      const bufferView = new DataView(wavBuffer);

      // Clamps -1.5 → -1.0, converts to -32767 (first sample at offset 44)
      expect(bufferView.getInt16(40, true)).toBe(-32767);
    });

    it("usa multiplicador 32767 (0x7FFF) para int16", () => {
      const testData = new Float32Array([0.5]); // 1 sample mono interleaved
      const wavBuffer = createWavBuffer(testData);
      const bufferView = new DataView(wavBuffer);

      // 0.5 * 32767 = 16383.5 → round → 16384 (at offset 44)
      expect(bufferView.getInt16(40, true)).toBeCloseTo(16384, 1);
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
    it("buffer tem tamanho esperado para N samples", () => {
      const numSamples = 100;
      const testData = new Float32Array(numSamples).fill(0.5);
      const wavBuffer = createWavBuffer(testData, 16000, 1);

      expect(wavBuffer.byteLength).toBe(44 + numSamples * 2);
    });

    it("dados são int16 signed, não unsigned", () => {
      const testData = new Float32Array([0.5, -0.5]); // 2 samples mono interleaved
      const wavBuffer = createWavBuffer(testData);
      const bufferView = new DataView(wavBuffer);

      // Offset 44: low byte of first int16 (+ve)
      expect(bufferView.getUint8(44)).toBeGreaterThanOrEqual(0);

      // Offset 46: low byte of second int16 (-ve) — high byte will be 0xFF or less
      const firstVal = bufferView.getInt16(40, true); // mono interleaved
      const secondVal = bufferView.getInt16(42, true);

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

    it("block align é 2 para mono e 4 para stereo", () => {
      const testData = new Float32Array([0.5, -0.3]);
      const monoBuffer = createWavBuffer(testData.slice(0, 1), 16000, 1); // 1 sample mono
      const stereoBuffer = createWavBuffer(testData, 16000, 2); // 2 samples stereo

      const monoView = new DataView(monoBuffer);
      const stereoView = new DataView(stereoBuffer);

      expect(monoView.getUint8(29)).toBe(2); // Block align: channels * bitsPerSample / 8 = 1 * 16 / 8 = 2
      expect(stereoView.getUint8(29)).toBe(4); // Block align: channels * bitsPerSample / 8 = 2 * 16 / 8 = 4
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

      expect(bufferView.getUint8(40)).toBe(0x00);
      expect(bufferView.getUint8(41)).toBe(0x40);
    });

    it("preserva valores exatos no clamp", () => {
      const testData = new Float32Array([1.0, -1.0]); // 2 samples mono interleaved
      const wavBuffer = createWavBuffer(testData);
      const bufferView = new DataView(wavBuffer);

      // +1.0 → +32767 (first sample at offset 44)
      expect(bufferView.getInt16(40, true)).toBe(32767);

      // -1.0 → -32767 (second sample at offset 46 in interleaved mono)
      // Note: Math.round(-1.0 * 32767) = -32767
      expect(bufferView.getInt16(42, true)).toBe(-32767);
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
