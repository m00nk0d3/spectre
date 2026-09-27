export type AudioBufferInput = Float32Array | Buffer;

export interface AudioBufferOutput {
  success: boolean;
  buffer?: ArrayBuffer;
}

export interface WhisperTranscribeRequest {
  wavPath: string;
}

export type WhisperTranscribeResponse = string;
