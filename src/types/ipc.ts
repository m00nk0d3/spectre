import type {
  SandcastleIssuePlan,
  SandcastleProject,
  SandcastleStartResult,
  SandcastleWorkflow,
} from "./sandcastle";
import type { GitHubMonitorSnapshot } from "./github-monitor";
import type { ConversationMemorySnapshot } from "./conversation-memory";
import type {
  TextPresentation,
  TextPresentationResponse,
} from "./text-presentation";

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

export interface SandcastlePlanReference {
  id: string;
  hash: string;
}

export interface SandcastlePrepareIssueRequest {
  project: string;
  issue: number;
}

export interface SandcastleStopRequest {
  project: string;
  runId: string;
}

export type ConversationState =
  | "idle"
  | "listening"
  | "transcribing"
  | "thinking"
  | "speaking"
  | "error";

export type ConversationEvent =
  | { type: "state"; state: ConversationState }
  | {
    type: "progress";
    step: number;
    message: string;
    spokenHint?: string;
  }
  | { type: "transcript"; text: string }
  | { type: "text"; delta: string; text: string }
  | { type: "audio"; sequence: number; text: string; data: ArrayBuffer }
  | {
    type: "complete";
    audioChunks: number;
    transcript: string;
    text: string;
  }
  | { type: "presentation"; presentation: TextPresentation }
  | { type: "error"; message: string };

export interface ElectronAPI {
  processConversation(audio: Float32Array): Promise<void>;
  cancelConversation(): Promise<void>;
  onConversationEvent(
    listener: (event: ConversationEvent) => void,
  ): () => void;
  respondToPresentation(response: TextPresentationResponse): Promise<boolean>;
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
  listSandcastleProjects(): Promise<SandcastleProject[]>;
  listSandcastleWorkflows(project: string): Promise<SandcastleWorkflow[]>;
  listSandcastlePlans(): Promise<SandcastleIssuePlan[]>;
  prepareSandcastleIssue(
    request: SandcastlePrepareIssueRequest,
  ): Promise<SandcastleIssuePlan>;
  openSandcastlePlan(reference: SandcastlePlanReference): Promise<void>;
  startSandcastlePlan(
    reference: SandcastlePlanReference,
  ): Promise<SandcastleStartResult | null>;
  stopSandcastleWorkflow(request: SandcastleStopRequest): Promise<boolean>;
  getGitHubMonitorSnapshot(): Promise<GitHubMonitorSnapshot>;
  refreshGitHubMonitor(): Promise<GitHubMonitorSnapshot>;
  onGitHubMonitorUpdate(
    listener: (snapshot: GitHubMonitorSnapshot) => void,
  ): () => void;
  getConversationMemory(): Promise<ConversationMemorySnapshot>;
  setConversationMemoryEnabled(
    enabled: boolean,
  ): Promise<ConversationMemorySnapshot>;
  clearConversationMemory(): Promise<ConversationMemorySnapshot | null>;
}
