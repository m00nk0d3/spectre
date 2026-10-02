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

export type ConversationState =
  | "idle"
  | "listening"
  | "transcribing"
  | "thinking"
  | "speaking"
  | "error";

export type ConversationEvent =
  | { type: "state"; state: ConversationState }
  | { type: "transcript"; text: string }
  | { type: "text"; delta: string; text: string }
  | { type: "audio"; sequence: number; text: string; data: ArrayBuffer }
  | {
    type: "complete";
    audioChunks: number;
    transcript: string;
    text: string;
  }
  | { type: "error"; message: string };

export interface ElectronAPI {
  processConversation(audio: Float32Array): Promise<void>;
  cancelConversation(): Promise<void>;
  onConversationEvent(
    listener: (event: ConversationEvent) => void,
  ): () => void;
  notifySpeechStart(): Promise<boolean>;
  notifySpeechEnd(): Promise<boolean>;
  getTTSAudio(text: string): Promise<ArrayBuffer>;
  pythonStatusRequest(): Promise<boolean>;
  pythonPid(): Promise<number | null>;
  createWavBuffer(
    float32Data: Float32Array,
  ): Promise<{ success: boolean; buffer: ArrayBuffer }>;
  writeWavFile(float32Data: Float32Array, filePath: string): Promise<void>;
  sendAudioBuffer(float32Data: AudioBufferInput): Promise<AudioBufferOutput>;
  whisperTranscribe(wavPath: string): Promise<WhisperTranscribeResponse>;
}
