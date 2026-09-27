/**
 * Cria buffer WAV a partir de Float32Array.
 * Formato: RIFF/WAV, PCM 16-bit mono ou stereo, sample rate configurável.
 */
export function createWavBuffer(
  float32Data: Float32Array | Buffer,
  sampleRate: number = 16000,
  channels: number = 1,
): ArrayBuffer {
  // Clamp valores fora do range [-1, 1] para evitar clipping
  const clampedData = Array.from(float32Data).map((v) => Math.max(-1, Math.min(1, v)));

  // Calcular tamanhos de header e arquivo total
  // Para dados interleaved: N amostras × canais × 2 bytes = tamanho em bytes
  const numSamples = (clampedData.length / channels) | 0;
  const dataSizeBytes = numSamples * channels * 2; // 2 bytes por amostra por canal
  const fileSize = 44 + dataSizeBytes; // Header fixo de 44 bytes + dados

  // Criar buffer do cabeçalho RIFF/WAV com espaço para dados (tamanho dinâmico)
  const headerBuffer = new Uint8Array(fileSize);
  let offset = 0;

  // === RIFF Chunk Identifier ===
  headerBuffer[offset++] = 0x46; // 'F'
  headerBuffer[offset++] = 0x46; // 'F'
  headerBuffer[offset++] = 0x49; // 'I'
  headerBuffer[offset++] = 0x52; // 'R'

  // Offset 4-7: File size - 8 (little-endian)
  const fileLow = fileSize & 0xff;
  const fileMid = (fileSize >> 8) & 0xff;
  const fileHi = (fileSize >> 16) & 0xff;
  const fileTop = (fileSize >> 24) & 0xff;
  headerBuffer[offset++] = fileLow;
  headerBuffer[offset++] = fileMid;
  headerBuffer[offset++] = fileHi;
  headerBuffer[offset++] = fileTop;

  // === WAVE Identifier ===
  headerBuffer[offset++] = 0x45; // 'E'
  headerBuffer[offset++] = 0x56; // 'V'
  headerBuffer[offset++] = 0x41; // 'A'
  headerBuffer[offset++] = 0x57; // 'W'

  // === fmt Subchunk Identifier === (little-endian: f-m-t-space)
  headerBuffer[offset++] = 0x66; // 'f'
  headerBuffer[offset++] = 0x6D; // 'm'
  headerBuffer[offset++] = 0x74; // 't'
  headerBuffer[offset++] = 0x20; // space

  // === fmt Subchunk Size ===
  headerBuffer[offset++] = 0x10; // low byte of 16
  headerBuffer[offset++] = 0x00; // high byte of 16

  // === Audio Format ===
  headerBuffer[offset++] = 0x01; // low byte of 1
  headerBuffer[offset++] = 0x00; // high byte of 1

  // === Number of Channels ===
  headerBuffer[offset++] = channels & 0xff;

  // === Sample Rate ===
  const srLow = sampleRate & 0xff;
  const srMid = (sampleRate >> 8) & 0xff;
  const srHi = (sampleRate >> 16) & 0xff;
  const srTop = (sampleRate >> 24) & 0xff;
  headerBuffer[offset++] = srLow;
  headerBuffer[offset++] = srMid;
  headerBuffer[offset++] = srHi;
  headerBuffer[offset++] = srTop;

  // === Byte Rate ===
  const byteRate = sampleRate * channels * 16 / 8;
  const brLow = byteRate & 0xff;
  const brMid = (byteRate >> 8) & 0xff;
  const brHi = (byteRate >> 16) & 0xff;
  const brTop = (byteRate >> 24) & 0xff;
  headerBuffer[offset++] = brLow;
  headerBuffer[offset++] = brMid;
  headerBuffer[offset++] = brHi;
  headerBuffer[offset++] = brTop;

  // === Block Align ===
  const blockAlign = channels * 2;
  headerBuffer[offset++] = blockAlign & 0xff;

  // === Bits Per Sample ===
  headerBuffer[offset++] = 0x10; // low byte of 16
  headerBuffer[offset++] = 0x00; // high byte of 16

  // === Data Subchunk Identifier === (little-endian: d-a-t-a)
  headerBuffer[offset++] = 0x64; // 'd'
  headerBuffer[offset++] = 0x61; // 'a'
  headerBuffer[offset++] = 0x74; // 't'
  headerBuffer[offset++] = 0x61; // 'a'

  // === Data Size (in bytes) ===
  const dataLow = dataSizeBytes & 0xff;
  const dataMid = (dataSizeBytes >> 8) & 0xff;
  const dataHi = (dataSizeBytes >> 16) & 0xff;
  const dataTop = (dataSizeBytes >> 24) & 0xff;
  headerBuffer[offset++] = dataLow;
  headerBuffer[offset++] = dataMid;
  headerBuffer[offset++] = dataHi;
  headerBuffer[offset++] = dataTop;

  // Write audio data at offset 44 (after RIFF + WAVE + fmt subchunk + data identifier + data size)
  let sampleIdx = 0;
  while (sampleIdx < numSamples) {
    const baseOffset = sampleIdx * channels;
    for (let ch = 0; ch < channels; ch++) {
      const val = clampedData[baseOffset + ch];
      // Little-endian: low byte first, then high byte
      headerBuffer[44 + baseOffset * 2 + ch * 2] = Math.round(val * 32767) & 0xff;
      headerBuffer[45 + baseOffset * 2 + ch * 2] = (Math.round(val * 32767) >> 8) & 0xff;
    }
    sampleIdx++;
  }

  return headerBuffer.buffer as ArrayBuffer;
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
  import("fs").then((fs) => {
    if (typeof fs.default === "function") {
      fs.default.writeFileSync(path, Buffer.from(wavBuffer));
    } else {
      const fsDefault = fs.default;
      if (fsDefault && typeof fsDefault.writeFileSync === "function") {
        fsDefault.writeFileSync(path, Buffer.from(wavBuffer));
      }
    }
  }).catch((err) => {
    console.error("[WAV] Failed to write file:", err);
    throw err;
  });
}
