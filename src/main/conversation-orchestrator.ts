import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ConversationEvent } from "@/types/ipc";
import { createWavBuffer } from "@/utils/audio-converter";
import { synthesizeSpeech } from "./kokoro-client";
import {
  isExplicitWebResearchRequest,
  isLongFormPresentationRequest,
  NO_WEB_EVIDENCE_MESSAGE,
  streamLMStudioResponse,
  type AgentProgressUpdate,
  type StructuredToolResult,
} from "./lm-studio";
import { SentenceChunker } from "./sentence-chunker";
import { transcribeWithFasterWhisper } from "./whisper";
import type { ConversationMemory } from "./conversation-memory";
import {
  shouldPresentInEditor,
  type TextPresenter,
} from "./text-presenter";

export interface ConversationDependencies {
  transcribe: (wavPath: string) => Promise<string>;
  streamResponse: (
    transcript: string,
    signal: AbortSignal,
    memoryContext: string,
    onStructuredResult?: (result: StructuredToolResult) => Promise<void>,
    onProgress?: (update: AgentProgressUpdate) => void,
  ) => AsyncIterable<string>;
  recall: (transcript: string) => Promise<string>;
  remember: (transcript: string, reply: string) => Promise<void>;
  present: (title: string, reply: string) => Promise<void>;
  presentInApp: (title: string, reply: string) => Promise<void>;
  synthesize: (text: string, signal: AbortSignal) => Promise<ArrayBuffer>;
  writeWav: (wavPath: string, audio: Float32Array) => Promise<void>;
  removeWav: (wavPath: string) => Promise<void>;
}

const STRUCTURED_RESULT_INTENT =
  /\b(?:list|show|display|look at|give me|tell me|what|which)\b[\s\S]*\b(?:repositories|repos|projects|issues|pull requests|prs|branches|releases|workflow runs|workflows|files|results|options|steps|commands)\b/i;
const TRANSCRIPTION_HALLUCINATION =
  /^(?:(?:legendas?|subt[ií]tulos?)(?:\s+(?:pela|pelo|por|da|do|de)\s+.{2,80})?|amara\.org|obrigad[oa] por assistir)[.!?\s]*$/i;
const NO_SPEECH_RECOGNIZED =
  /(?:returned 422|status 422)[\s\S]*no speech recognized/i;

export function isLikelyTranscriptionHallucination(
  transcript: string,
): boolean {
  return TRANSCRIPTION_HALLUCINATION.test(transcript.trim());
}

export function formatStructuredResult(reply: string): string {
  return reply
    .replace(/\s+-\s+(?=[A-Za-z0-9_.`])/g, "\n- ")
    .replace(/\s+(?=\d+[.)]\s+[A-Za-z0-9])/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function shouldPresentStructuredResult(
  transcript: string,
  reply: string,
): boolean {
  if (!STRUCTURED_RESULT_INTENT.test(transcript)) return false;
  const formatted = formatStructuredResult(reply);
  const itemCount = formatted
    .split("\n")
    .filter((line) => /^-\s+\S/.test(line) || /^\d+[.)]\s+\S/.test(line))
    .length;
  return itemCount >= 3 || (reply.length >= 360 && itemCount >= 2);
}

function structuredResultTitle(transcript: string): string {
  if (/\b(?:repositories|repos)\b/i.test(transcript)) {
    return "GitHub repositories";
  }
  if (/\b(?:pull requests|prs)\b/i.test(transcript)) {
    return "Pull requests";
  }
  if (/\bissues\b/i.test(transcript)) return "GitHub issues";
  if (/\bbranches\b/i.test(transcript)) return "Branches";
  if (/\breleases\b/i.test(transcript)) return "Releases";
  if (/\b(?:workflow runs|workflows)\b/i.test(transcript)) {
    return "GitHub workflows";
  }
  if (/\bcommands\b/i.test(transcript)) return "Commands";
  if (/\bsteps\b/i.test(transcript)) return "Steps";
  return "Results";
}

function longFormPresentationTitle(transcript: string): string {
  if (/\b(?:gh|github)\b/i.test(transcript)) return "GitHub CLI guide";
  if (/\bspectre\b/i.test(transcript)) return "Spectre guide";
  return "Guide";
}

export interface ConversationOrchestratorOptions {
  workDirectory: string;
  emit: (event: ConversationEvent) => void;
  memory?: ConversationMemory;
  presenter?: TextPresenter;
  dependencies?: Partial<ConversationDependencies>;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export class ConversationOrchestrator {
  private readonly workDirectory: string;
  private readonly emit: (event: ConversationEvent) => void;
  private readonly dependencies: ConversationDependencies;
  private activeController: AbortController | null = null;
  private requestId = 0;
  private processingQueue = false;
  private pendingTurns: Array<{
    audio: Float32Array;
    resolve: () => void;
    reject: (error: unknown) => void;
  }> = [];

  constructor(options: ConversationOrchestratorOptions) {
    this.workDirectory = options.workDirectory;
    this.emit = options.emit;
    this.dependencies = {
      transcribe: transcribeWithFasterWhisper,
      streamResponse: (
        transcript,
        signal,
        memoryContext,
        onStructuredResult,
        onProgress,
      ) => streamLMStudioResponse(transcript, {
        signal,
        memoryContext,
        onStructuredResult,
        onProgress,
      }),
      recall: async (transcript) =>
        (await options.memory?.recall(transcript))?.text ?? "",
      remember: async (transcript, reply) => {
        await options.memory?.remember(transcript, reply);
      },
      present: async (title, reply) => {
        await options.presenter?.present(title, reply);
      },
      presentInApp: async () => undefined,
      synthesize: synthesizeSpeech,
      writeWav: async (wavPath, audio) => {
        await mkdir(path.dirname(wavPath), { recursive: true });
        await writeFile(wavPath, Buffer.from(createWavBuffer(audio, 16000, 1)));
      },
      removeWav: async (wavPath) => {
        await rm(wavPath, { force: true });
      },
      ...options.dependencies,
    };
  }

  cancel(): void {
    this.activeController?.abort();
    this.activeController = null;
    this.requestId += 1;
    for (const turn of this.pendingTurns.splice(0)) turn.resolve();
    this.emit({ type: "state", state: "idle" });
  }

  async process(audio: Float32Array): Promise<void> {
    if (!(audio instanceof Float32Array) || audio.length === 0) {
      throw new Error("Conversation audio must be a non-empty Float32Array");
    }

    return new Promise<void>((resolve, reject) => {
      this.pendingTurns.push({ audio, resolve, reject });
      void this.drainQueue();
    });
  }

  private async drainQueue(): Promise<void> {
    if (this.processingQueue) return;
    this.processingQueue = true;
    try {
      while (this.pendingTurns.length > 0) {
        const turn = this.pendingTurns.shift();
        if (!turn) continue;
        try {
          await this.processTurn(turn.audio);
          turn.resolve();
        } catch (error) {
          turn.reject(error);
        }
      }
    } finally {
      this.processingQueue = false;
    }
  }

  private async processTurn(audio: Float32Array): Promise<void> {
    const controller = new AbortController();
    const requestId = ++this.requestId;
    this.activeController = controller;
    const wavPath = path.join(
      this.workDirectory,
      `speech-${Date.now()}-${requestId}.wav`,
    );

    try {
      this.emit({ type: "state", state: "transcribing" });
      await this.dependencies.writeWav(wavPath, audio);
      let transcript: string;
      try {
        transcript = (await this.dependencies.transcribe(wavPath)).trim();
      } catch (error) {
        if (
          error instanceof Error
          && NO_SPEECH_RECOGNIZED.test(error.message)
        ) {
          console.info("[WHISPER] Ignoring audio with no recognized speech");
          this.emit({ type: "state", state: "idle" });
          return;
        }
        throw error;
      }
      this.assertActive(requestId, controller.signal);
      if (!transcript) throw new Error("Whisper returned an empty transcript");
      if (isLikelyTranscriptionHallucination(transcript)) {
        console.warn(
          `[WHISPER] Ignoring likely hallucination: ${transcript}`,
        );
        this.emit({ type: "state", state: "idle" });
        return;
      }
      this.emit({ type: "transcript", text: transcript });
      this.emit({ type: "state", state: "thinking" });
      const memoryContext = await this.dependencies.recall(transcript);
      this.assertActive(requestId, controller.signal);
      const researchPresentation = isExplicitWebResearchRequest(transcript);
      const longFormPresentation =
        isLongFormPresentationRequest(transcript);
      const presentInEditor =
        shouldPresentInEditor(transcript) || researchPresentation;
      const structuredResultCandidate =
        STRUCTURED_RESULT_INTENT.test(transcript);

      const chunker = new SentenceChunker();
      let reply = "";
      let structuredToolResult: StructuredToolResult | undefined;
      let sequence = 0;
      let synthesisChain = Promise.resolve();

      const queueSpeech = (text: string): void => {
        const chunkSequence = sequence++;
        synthesisChain = synthesisChain.then(async () => {
          this.assertActive(requestId, controller.signal);
          this.emit({ type: "state", state: "speaking" });
          const audioChunk = await this.dependencies.synthesize(
            text,
            controller.signal,
          );
          this.assertActive(requestId, controller.signal);
          this.emit({
            type: "audio",
            sequence: chunkSequence,
            text,
            data: audioChunk,
          });
        });
        void synthesisChain.catch(() => undefined);
      };

      for await (const token of this.dependencies.streamResponse(
        transcript,
        controller.signal,
        memoryContext,
        async (result) => {
          structuredToolResult = result;
          await this.dependencies.presentInApp(result.title, result.content);
        },
        (update) => {
          this.emit({ type: "progress", ...update });
        },
      )) {
        this.assertActive(requestId, controller.signal);
        reply += token;
        if (
          !researchPresentation
          && !longFormPresentation
          && !structuredResultCandidate
        ) {
          this.emit({ type: "text", delta: token, text: reply });
        }
        if (
          !presentInEditor
          && !longFormPresentation
          && !structuredResultCandidate
        ) {
          for (const chunk of chunker.push(token)) queueSpeech(chunk);
        }
      }

      if (
        !presentInEditor
        && !longFormPresentation
        && !structuredResultCandidate
      ) {
        for (const chunk of chunker.flush()) queueSpeech(chunk);
      }
      await synthesisChain;
      this.assertActive(requestId, controller.signal);
      const completedReply = reply.trim();
      const researchFailed = completedReply === NO_WEB_EVIDENCE_MESSAGE;
      const structuredPresentation = shouldPresentStructuredResult(
        transcript,
        completedReply,
      );
      if (longFormPresentation) {
        await this.dependencies.presentInApp(
          longFormPresentationTitle(transcript),
          completedReply,
        );
        this.assertActive(requestId, controller.signal);
        const acknowledgement = "I put the complete guide on screen.";
        this.emit({
          type: "text",
          delta: acknowledgement,
          text: acknowledgement,
        });
        this.emit({ type: "state", state: "speaking" });
        const acknowledgementAudio = await this.dependencies.synthesize(
          acknowledgement,
          controller.signal,
        );
        this.assertActive(requestId, controller.signal);
        this.emit({
          type: "audio",
          sequence: 0,
          text: acknowledgement,
          data: acknowledgementAudio,
        });
        await this.dependencies.remember(transcript, completedReply);
        this.emit({
          type: "complete",
          audioChunks: 1,
          transcript,
          text: acknowledgement,
        });
        this.emit({ type: "state", state: "idle" });
        return;
      }
      if (structuredPresentation) {
        await this.dependencies.presentInApp(
          structuredResultTitle(transcript),
          formatStructuredResult(completedReply),
        );
        this.assertActive(requestId, controller.signal);
        const acknowledgement = "I put the complete list on screen.";
        this.emit({
          type: "text",
          delta: acknowledgement,
          text: acknowledgement,
        });
        this.emit({ type: "state", state: "speaking" });
        const acknowledgementAudio = await this.dependencies.synthesize(
          acknowledgement,
          controller.signal,
        );
        this.assertActive(requestId, controller.signal);
        this.emit({
          type: "audio",
          sequence: 0,
          text: acknowledgement,
          data: acknowledgementAudio,
        });
        await this.dependencies.remember(
          transcript,
          structuredToolResult?.memoryText ?? completedReply,
        );
        this.emit({
          type: "complete",
          audioChunks: 1,
          transcript,
          text: acknowledgement,
        });
        this.emit({ type: "state", state: "idle" });
        return;
      }
      if (structuredResultCandidate && !presentInEditor) {
        this.emit({
          type: "text",
          delta: completedReply,
          text: completedReply,
        });
        for (const chunk of chunker.push(completedReply)) queueSpeech(chunk);
        for (const chunk of chunker.flush()) queueSpeech(chunk);
        await synthesisChain;
        this.assertActive(requestId, controller.signal);
      }
      if (presentInEditor && !researchFailed) {
        await this.dependencies.present(transcript, completedReply);
        this.assertActive(requestId, controller.signal);
      }
      if (researchPresentation) {
        const acknowledgement = researchFailed
          ? completedReply
          : "The research is complete. I opened the results in Neovim.";
        this.emit({
          type: "text",
          delta: acknowledgement,
          text: acknowledgement,
        });
        this.emit({ type: "state", state: "speaking" });
        const acknowledgementAudio = await this.dependencies.synthesize(
          acknowledgement,
          controller.signal,
        );
        this.assertActive(requestId, controller.signal);
        this.emit({
          type: "audio",
          sequence: 0,
          text: acknowledgement,
          data: acknowledgementAudio,
        });
        await this.dependencies.remember(transcript, completedReply);
        this.emit({
          type: "complete",
          audioChunks: 1,
          transcript,
          text: acknowledgement,
        });
        this.emit({ type: "state", state: "idle" });
        return;
      }
      await this.dependencies.remember(transcript, completedReply);
      this.emit({
        type: "complete",
        audioChunks: sequence,
        transcript,
        text: completedReply,
      });
      this.emit({ type: "state", state: "idle" });
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) return;
      const message = error instanceof Error ? error.message : String(error);
      this.emit({ type: "error", message });
      this.emit({ type: "state", state: "error" });
      throw error;
    } finally {
      if (this.activeController === controller) {
        this.activeController = null;
      }
      try {
        await this.dependencies.removeWav(wavPath);
      } catch (error) {
        console.error(
          "[CONVERSATION] Failed to remove temporary WAV:",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  private assertActive(requestId: number, signal: AbortSignal): void {
    if (signal.aborted || requestId !== this.requestId) {
      throw new DOMException("Conversation cancelled", "AbortError");
    }
  }
}
