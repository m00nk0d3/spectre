export type AudioBufferInput = Float32Array | Buffer;

export interface AudioBufferOutput {
  success: boolean;
  buffer?: ArrayBuffer;
}
