/**
 * Cria buffer WAV a partir de Float32Array.
 * Formato: RIFF/WAV, PCM 16-bit mono ou stereo, sample rate configurável.
 */
export function createWavBuffer(
  float32Data: Float32Array | Buffer,
  sampleRate: number = 16000,
  channels: number = 1,
): ArrayBuffer {
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new Error("Sample rate must be a positive integer");
  }
  if (!Number.isInteger(channels) || channels <= 0) {
    throw new Error("Channel count must be a positive integer");
  }

  const sampleCount = Math.floor(float32Data.length / channels) * channels;
  const dataSize = sampleCount * Int16Array.BYTES_PER_ELEMENT;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, text: string): void => {
    for (let index = 0; index < text.length; index++) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, dataSize, true);

  for (let index = 0; index < sampleCount; index++) {
    const sample = Math.max(-1, Math.min(1, float32Data[index]));
    view.setInt16(44 + index * 2, Math.round(sample * 32767), true);
  }

  return buffer;
}

/**
 * Escreve buffer WAV ao disco.
 * @param float32Data - Dados de áudio normalizados entre -1.0 e +1.0 (interleaved per sample)
 * @param path - Caminho do arquivo a criar
 */
export async function writeWavFile(
  float32Data: Float32Array | Buffer,
  path: string,
): Promise<void> {
  const wavBuffer = createWavBuffer(float32Data);
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, Buffer.from(wavBuffer));
}
