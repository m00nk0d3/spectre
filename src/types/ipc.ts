export type AudioBufferInput = Float32Array | Buffer;

export interface AudioBufferOutput {
  success: boolean;
  buffer?: ArrayBuffer;
}

export interface AudioStreamChunk {
  sequence: number;
  data: ArrayBuffer;
}

export interface AudioStreamComplete {
  finalSequence: number;
}

export interface WhisperTranscribeRequest {
  wavPath: string;
}

export type WhisperTranscribeResponse = string;
