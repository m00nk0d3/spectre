import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ConversationEvent } from "@/types/ipc";
import { createWavBuffer } from "@/utils/audio-converter";
import { synthesizeSpeech } from "./kokoro-client";
import { streamLMStudioResponse } from "./lm-studio";
import { SentenceChunker } from "./sentence-chunker";
import { transcribeWithFasterWhisper } from "./whisper";

export interface ConversationDependencies {
  transcribe: (wavPath: string) => Promise<string>;
  streamResponse: (
    transcript: string,
    signal: AbortSignal,
  ) => AsyncIterable<string>;
  synthesize: (text: string, signal: AbortSignal) => Promise<ArrayBuffer>;
  writeWav: (wavPath: string, audio: Float32Array) => Promise<void>;
  removeWav: (wavPath: string) => Promise<void>;
}

export interface ConversationOrchestratorOptions {
  workDirectory: string;
  emit: (event: ConversationEvent) => void;
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

  constructor(options: ConversationOrchestratorOptions) {
    this.workDirectory = options.workDirectory;
    this.emit = options.emit;
    this.dependencies = {
      transcribe: transcribeWithFasterWhisper,
      streamResponse: (transcript, signal) => streamLMStudioResponse(
        transcript,
        { signal },
      ),
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
    this.emit({ type: "state", state: "idle" });
  }

  async process(audio: Float32Array): Promise<void> {
    if (!(audio instanceof Float32Array) || audio.length === 0) {
      throw new Error("Conversation audio must be a non-empty Float32Array");
    }

    this.activeController?.abort();
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
      const transcript = (await this.dependencies.transcribe(wavPath)).trim();
      this.assertActive(requestId, controller.signal);
      if (!transcript) throw new Error("Whisper returned an empty transcript");
      this.emit({ type: "transcript", text: transcript });
      this.emit({ type: "state", state: "thinking" });

      const chunker = new SentenceChunker();
      let reply = "";
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
      )) {
        this.assertActive(requestId, controller.signal);
        reply += token;
        this.emit({ type: "text", delta: token, text: reply });
        for (const chunk of chunker.push(token)) queueSpeech(chunk);
      }

      for (const chunk of chunker.flush()) queueSpeech(chunk);
      await synthesisChain;
      this.assertActive(requestId, controller.signal);
      this.emit({
        type: "complete",
        audioChunks: sequence,
        transcript,
        text: reply.trim(),
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
