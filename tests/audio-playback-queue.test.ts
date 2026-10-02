import { describe, expect, it } from "vitest";
import { SequenceBuffer } from "../src/renderer/audio-playback-queue";

describe("SequenceBuffer", () => {
  it("releases out-of-order audio chunks in FIFO sequence", () => {
    const buffer = new SequenceBuffer<string>();

    expect(buffer.push(1, "segunda")).toEqual([]);
    expect(buffer.push(0, "primeira")).toEqual(["primeira", "segunda"]);
    expect(buffer.push(2, "terceira")).toEqual(["terceira"]);
  });

  it("ignores duplicate and already-consumed chunks", () => {
    const buffer = new SequenceBuffer<string>();

    expect(buffer.push(0, "primeira")).toEqual(["primeira"]);
    expect(buffer.push(0, "duplicada")).toEqual([]);
  });

  it("starts again from zero after reset", () => {
    const buffer = new SequenceBuffer<string>();
    buffer.push(0, "antiga");
    buffer.reset();

    expect(buffer.push(0, "nova")).toEqual(["nova"]);
  });
});
