import { describe, expect, it } from "vitest";
import type { ConversationEvent } from "../src/types/ipc";
import { ConversationOrchestrator } from "../src/main/conversation-orchestrator";

describe("ConversationOrchestrator", () => {
  it("transcribes, chunks streamed text, and synthesizes serial audio", async () => {
    const events: ConversationEvent[] = [];
    const synthesized: string[] = [];
    let activeSyntheses = 0;
    let maxActiveSyntheses = 0;
    let removedPath = "";

    const orchestrator = new ConversationOrchestrator({
      workDirectory: "session-audio",
      emit: (event) => events.push(event),
      dependencies: {
        writeWav: async () => undefined,
        removeWav: async (wavPath) => {
          removedPath = wavPath;
        },
        transcribe: async () => "Como você está?",
        streamResponse: async function* () {
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
    expect(events.at(-1)).toEqual({ type: "state", state: "idle" });
    expect(removedPath).toMatch(/speech-\d+-1\.wav$/);
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
