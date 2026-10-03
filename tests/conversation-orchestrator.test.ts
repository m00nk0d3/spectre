import { describe, expect, it } from "vitest";
import type { ConversationEvent } from "../src/types/ipc";
import {
  ConversationOrchestrator,
  formatStructuredResult,
  shouldPresentStructuredResult,
} from "../src/main/conversation-orchestrator";

describe("ConversationOrchestrator", () => {
  it("ignores known Whisper subtitle hallucinations", async () => {
    let streamCalls = 0;
    let recallCalls = 0;
    const events: ConversationEvent[] = [];
    const orchestrator = new ConversationOrchestrator({
      workDirectory: "session-audio",
      emit: (event) => events.push(event),
      dependencies: {
        writeWav: async () => undefined,
        removeWav: async () => undefined,
        transcribe: async () => "Legendas pela comunidade de Amara.org",
        recall: async () => {
          recallCalls += 1;
          return "";
        },
        streamResponse: async function* () {
          streamCalls += 1;
          yield "This must not be generated.";
        },
        remember: async () => undefined,
      },
    });

    await orchestrator.process(new Float32Array([0.1]));

    expect(recallCalls).toBe(0);
    expect(streamCalls).toBe(0);
    expect(events).not.toContainEqual(expect.objectContaining({
      type: "transcript",
    }));
    expect(events.at(-1)).toEqual({ type: "state", state: "idle" });
  });

  it.each([
    "Legendas pela comunidade do Brasil",
    "Legendas por Paulo Montenegro",
    "Subtítulos pela comunidade de Amara.org",
  ])("ignores the subtitle hallucination %s", async (hallucination) => {
    let streamCalls = 0;
    const orchestrator = new ConversationOrchestrator({
      workDirectory: "session-audio",
      emit: () => undefined,
      dependencies: {
        writeWav: async () => undefined,
        removeWav: async () => undefined,
        transcribe: async () => hallucination,
        recall: async () => "",
        streamResponse: async function* () {
          streamCalls += 1;
          yield "This must not be generated.";
        },
        remember: async () => undefined,
      },
    });

    await orchestrator.process(new Float32Array([0.1]));

    expect(streamCalls).toBe(0);
  });

  it("ignores audio where Whisper recognizes no speech", async () => {
    const events: ConversationEvent[] = [];
    const orchestrator = new ConversationOrchestrator({
      workDirectory: "session-audio",
      emit: (event) => events.push(event),
      dependencies: {
        writeWav: async () => undefined,
        removeWav: async () => undefined,
        transcribe: async () => {
          throw new Error(
            'Faster Whisper returned 422: {"detail":"No speech recognized"}',
          );
        },
        recall: async () => "",
        streamResponse: async function* () {
          yield "This must not be generated.";
        },
        remember: async () => undefined,
      },
    });

    await orchestrator.process(new Float32Array([0.1]));

    expect(events).not.toContainEqual(expect.objectContaining({
      type: "error",
    }));
    expect(events.at(-1)).toEqual({ type: "state", state: "idle" });
  });

  it("transcribes, chunks streamed text, and synthesizes serial audio", async () => {
    const events: ConversationEvent[] = [];
    const synthesized: string[] = [];
    let activeSyntheses = 0;
    let maxActiveSyntheses = 0;
    let removedPath = "";
    const remembered: Array<[string, string]> = [];

    const orchestrator = new ConversationOrchestrator({
      workDirectory: "session-audio",
      emit: (event) => events.push(event),
      dependencies: {
        writeWav: async () => undefined,
        removeWav: async (wavPath) => {
          removedPath = wavPath;
        },
        transcribe: async () => "Como você está?",
        recall: async () => "Remembered preference: concise answers.",
        streamResponse: async function* (
          _transcript,
          _signal,
          _memoryContext,
          _onStructuredResult,
          onProgress,
        ) {
          onProgress?.({
            step: 1,
            message: "Inspecting the requested information",
          });
          yield "Estou bem, ";
          yield "obrigado. ";
          yield "E você?";
        },
        synthesize: async (text) => {
          activeSyntheses += 1;
          maxActiveSyntheses = Math.max(maxActiveSyntheses, activeSyntheses);
          await Promise.resolve();
          synthesized.push(text);
          activeSyntheses -= 1;
          return new ArrayBuffer(8);
        },
        remember: async (transcript, reply) => {
          remembered.push([transcript, reply]);
        },
      },
    });

    await orchestrator.process(new Float32Array([0.1, -0.1]));

    expect(synthesized).toEqual(["Estou bem, obrigado.", "E você?"]);
    expect(maxActiveSyntheses).toBe(1);
    expect(
      events
        .filter((event) => event.type === "audio")
        .map((event) => event.type === "audio" && event.sequence),
    ).toEqual([0, 1]);
    expect(events).toContainEqual({
      type: "transcript",
      text: "Como você está?",
    });
    expect(events).toContainEqual({
      type: "progress",
      step: 1,
      message: "Inspecting the requested information",
    });
    expect(events.at(-1)).toEqual({ type: "state", state: "idle" });
    expect(removedPath).toMatch(/speech-\d+-1\.wav$/);
    expect(remembered).toEqual([[
      "Como você está?",
      "Estou bem, obrigado. E você?",
    ]]);
  });

  it("does not remember failed conversations", async () => {
    let rememberCalls = 0;
    const orchestrator = new ConversationOrchestrator({
      workDirectory: "session-audio",
      emit: () => undefined,
      dependencies: {
        writeWav: async () => undefined,
        removeWav: async () => undefined,
        transcribe: async () => "Please answer",
        recall: async () => "",
        streamResponse: async function* () {
          throw new Error("LM Studio failed");
        },
        synthesize: async () => new ArrayBuffer(1),
        remember: async () => {
          rememberCalls += 1;
        },
      },
    });

    await expect(
      orchestrator.process(new Float32Array([0.1])),
    ).rejects.toThrow("LM Studio failed");
    expect(rememberCalls).toBe(0);
  });

  it("presents long list results and speaks only a short cue", async () => {
    const events: ConversationEvent[] = [];
    const presented: Array<[string, string]> = [];
    const synthesized: string[] = [];
    const fullReply = [
      "Here are the repositories visible to you.",
      " - spectre — Updated today.",
      " - grove — Updated yesterday.",
      " - pi-agent — Updated last week.",
      " - jarvis — Updated last month.",
    ].join("");
    const orchestrator = new ConversationOrchestrator({
      workDirectory: "session-audio",
      emit: (event) => events.push(event),
      dependencies: {
        writeWav: async () => undefined,
        removeWav: async () => undefined,
        transcribe: async () => "List my GitHub repositories",
        recall: async () => "",
        streamResponse: async function* () {
          yield fullReply;
        },
        synthesize: async (text) => {
          synthesized.push(text);
          return new ArrayBuffer(1);
        },
        presentInApp: async (title, content) => {
          presented.push([title, content]);
        },
        remember: async () => undefined,
      },
    });

    await orchestrator.process(new Float32Array([0.1]));

    expect(presented).toEqual([[
      "GitHub repositories",
      [
        "Here are the repositories visible to you.",
        "- spectre — Updated today.",
        "- grove — Updated yesterday.",
        "- pi-agent — Updated last week.",
        "- jarvis — Updated last month.",
      ].join("\n"),
    ]]);
    expect(synthesized).toEqual(["I put the complete list on screen."]);
    expect(events.filter((event) => event.type === "text")).toEqual([{
      type: "text",
      delta: "I put the complete list on screen.",
      text: "I put the complete list on screen.",
    }]);
  });

  it("formats inline lists and ignores short structured answers", () => {
    expect(formatStructuredResult(
      "Repositories: - spectre — public - grove — private",
    )).toBe([
      "Repositories:",
      "- spectre — public",
      "- grove — private",
    ].join("\n"));
    expect(shouldPresentStructuredResult(
      "List my repositories",
      "Only one repository: spectre.",
    )).toBe(false);
  });

  it("presents requested long responses without synthesizing them", async () => {
    const presented: Array<[string, string]> = [];
    let syntheses = 0;
    const orchestrator = new ConversationOrchestrator({
      workDirectory: "session-audio",
      emit: () => undefined,
      dependencies: {
        writeWav: async () => undefined,
        removeWav: async () => undefined,
        transcribe: async () => "Show a detailed report in Neovim",
        recall: async () => "",
        streamResponse: async function* () {
          yield "Detailed report content.";
        },
        synthesize: async () => {
          syntheses += 1;
          return new ArrayBuffer(1);
        },
        present: async (title, reply) => {
          presented.push([title, reply]);
        },
        remember: async () => undefined,
      },
    });

    await orchestrator.process(new Float32Array([0.1]));

    expect(syntheses).toBe(0);
    expect(presented).toEqual([[
      "Show a detailed report in Neovim",
      "Detailed report content.",
    ]]);
  });

  it("presents comprehensive guides in app and speaks only completion", async () => {
    const events: ConversationEvent[] = [];
    const presented: Array<[string, string]> = [];
    const remembered: Array<[string, string]> = [];
    const synthesized: string[] = [];
    const guide = [
      "GitHub CLI guide",
      "",
      "- Read repositories with github_read.",
      "- Confirm mutations before github_write.",
    ].join("\n");
    const orchestrator = new ConversationOrchestrator({
      workDirectory: "session-audio",
      emit: (event) => events.push(event),
      dependencies: {
        writeWav: async () => undefined,
        removeWav: async () => undefined,
        transcribe: async () =>
          "Give me a comprehensive guide on how to use the GH tool",
        recall: async () => "",
        streamResponse: async function* () {
          yield guide;
        },
        synthesize: async (text) => {
          synthesized.push(text);
          return new ArrayBuffer(1);
        },
        presentInApp: async (title, content) => {
          presented.push([title, content]);
        },
        remember: async (transcript, reply) => {
          remembered.push([transcript, reply]);
        },
      },
    });

    await orchestrator.process(new Float32Array([0.1]));

    const acknowledgement = "I put the complete guide on screen.";
    expect(presented).toEqual([["GitHub CLI guide", guide]]);
    expect(synthesized).toEqual([acknowledgement]);
    expect(remembered).toEqual([[
      "Give me a comprehensive guide on how to use the GH tool",
      guide,
    ]]);
    expect(events.filter((event) => event.type === "text")).toEqual([{
      type: "text",
      delta: acknowledgement,
      text: acknowledgement,
    }]);
  });

  it("opens explicit research in Neovim and speaks only completion", async () => {
    const events: ConversationEvent[] = [];
    const presented: Array<[string, string]> = [];
    const remembered: Array<[string, string]> = [];
    const synthesized: string[] = [];
    const orchestrator = new ConversationOrchestrator({
      workDirectory: "session-audio",
      emit: (event) => events.push(event),
      dependencies: {
        writeWav: async () => undefined,
        removeWav: async () => undefined,
        transcribe: async () => "Do some research online on bananas",
        recall: async () => "",
        streamResponse: async function* () {
          yield "A detailed sourced banana report.";
        },
        synthesize: async (text) => {
          synthesized.push(text);
          return new ArrayBuffer(1);
        },
        present: async (title, reply) => {
          presented.push([title, reply]);
        },
        remember: async (transcript, reply) => {
          remembered.push([transcript, reply]);
        },
      },
    });

    await orchestrator.process(new Float32Array([0.1]));

    const acknowledgement =
      "The research is complete. I opened the results in Neovim.";
    expect(presented).toEqual([[
      "Do some research online on bananas",
      "A detailed sourced banana report.",
    ]]);
    expect(remembered).toEqual([[
      "Do some research online on bananas",
      "A detailed sourced banana report.",
    ]]);
    expect(synthesized).toEqual([acknowledgement]);
    expect(
      events.filter((event) => event.type === "text"),
    ).toEqual([{
      type: "text",
      delta: acknowledgement,
      text: acknowledgement,
    }]);
    expect(events).toContainEqual({
      type: "complete",
      audioChunks: 1,
      transcript: "Do some research online on bananas",
      text: acknowledgement,
    });
  });

  it("speaks research failure without opening an editor report", async () => {
    const failure =
      "I couldn't access readable public sources for that research, so I won't invent or substitute unsupported information.";
    let presentationCalls = 0;
    const synthesized: string[] = [];
    const orchestrator = new ConversationOrchestrator({
      workDirectory: "session-audio",
      emit: () => undefined,
      dependencies: {
        writeWav: async () => undefined,
        removeWav: async () => undefined,
        transcribe: async () => "Research an unavailable topic online",
        recall: async () => "",
        streamResponse: async function* () {
          yield failure;
        },
        synthesize: async (text) => {
          synthesized.push(text);
          return new ArrayBuffer(1);
        },
        present: async () => {
          presentationCalls += 1;
        },
        remember: async () => undefined,
      },
    });

    await orchestrator.process(new Float32Array([0.1]));

    expect(presentationCalls).toBe(0);
    expect(synthesized).toEqual([failure]);
  });

  it("does not remember cancelled partial conversations", async () => {
    let rememberCalls = 0;
    let markStreaming: (() => void) | undefined;
    const streaming = new Promise<void>((resolve) => {
      markStreaming = resolve;
    });
    const orchestrator = new ConversationOrchestrator({
      workDirectory: "session-audio",
      emit: () => undefined,
      dependencies: {
        writeWav: async () => undefined,
        removeWav: async () => undefined,
        transcribe: async () => "Please answer",
        recall: async () => "",
        streamResponse: async function* (_transcript, signal) {
          yield "Partial response.";
          markStreaming?.();
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              reject(new DOMException("Cancelled", "AbortError"));
            }, { once: true });
          });
        },
        synthesize: async () => new ArrayBuffer(1),
        remember: async () => {
          rememberCalls += 1;
        },
      },
    });

    const processing = orchestrator.process(new Float32Array([0.1]));
    await streaming;
    orchestrator.cancel();
    await processing;
    expect(rememberCalls).toBe(0);
  });

  it("queues follow-up speech without cancelling active work", async () => {
    const transcribed: string[] = [];
    const remembered: string[] = [];
    let releaseFirst: (() => void) | undefined;
    let markFirstStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const transcripts = ["First task", "Follow-up conversation"];
    const orchestrator = new ConversationOrchestrator({
      workDirectory: "session-audio",
      emit: () => undefined,
      dependencies: {
        writeWav: async () => undefined,
        removeWav: async () => undefined,
        transcribe: async () => {
          const transcript = transcripts[transcribed.length];
          transcribed.push(transcript);
          return transcript;
        },
        recall: async () => "",
        streamResponse: async function* (transcript) {
          if (transcript === "First task") {
            markFirstStarted?.();
            await firstGate;
          }
          yield `${transcript} complete.`;
        },
        synthesize: async () => new ArrayBuffer(1),
        remember: async (transcript) => {
          remembered.push(transcript);
        },
      },
    });

    const first = orchestrator.process(new Float32Array([0.1]));
    await firstStarted;
    const second = orchestrator.process(new Float32Array([0.2]));
    await Promise.resolve();
    expect(transcribed).toEqual(["First task"]);

    releaseFirst?.();
    await Promise.all([first, second]);

    expect(transcribed).toEqual(["First task", "Follow-up conversation"]);
    expect(remembered).toEqual(["First task", "Follow-up conversation"]);
  });

  it("rejects empty microphone segments", async () => {
    const orchestrator = new ConversationOrchestrator({
      workDirectory: "session-audio",
      emit: () => undefined,
    });

    await expect(orchestrator.process(new Float32Array())).rejects.toThrow(
      "non-empty Float32Array",
    );
  });
});
