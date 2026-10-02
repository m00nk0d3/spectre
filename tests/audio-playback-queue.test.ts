import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AudioPlaybackQueue,
  SequenceBuffer,
} from "../src/renderer/audio-playback-queue";

class FakeSource {
  buffer: AudioBuffer | null = null;
  onended: (() => void) | null = null;

  connect(): void {}
  disconnect(): void {}
  start(): void {}
  stop(): void {}
}

class FakeAudioContext {
  state: AudioContextState = "running";
  currentTime = 0;
  destination = {};
  readonly sources: FakeSource[] = [];

  createAnalyser() {
    return {
      fftSize: 0,
      smoothingTimeConstant: 0,
      frequencyBinCount: 256,
      connect: () => undefined,
      disconnect: () => undefined,
      getByteFrequencyData: () => undefined,
    };
  }

  createBufferSource(): FakeSource {
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  }

  async decodeAudioData(): Promise<AudioBuffer> {
    return { duration: 0.2 } as AudioBuffer;
  }

  async resume(): Promise<void> {}
  async close(): Promise<void> {}
}

afterEach(() => {
  vi.useRealTimers();
});

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

describe("AudioPlaybackQueue lifecycle", () => {
  it("waits for microphone capture to pause before scheduling audio", async () => {
    const context = new FakeAudioContext();
    let releasePause!: () => void;
    const paused = new Promise<void>((resolve) => {
      releasePause = resolve;
    });
    const queue = new AudioPlaybackQueue(
      context as unknown as AudioContext,
      { onPlaybackStart: () => paused },
    );

    const enqueued = queue.enqueue(0, new ArrayBuffer(8));
    await Promise.resolve();
    expect(context.sources).toHaveLength(0);

    releasePause();
    await enqueued;
    expect(context.sources).toHaveLength(1);
  });

  it("pauses capture before playback and resumes after the acoustic tail", async () => {
    vi.useFakeTimers();
    const context = new FakeAudioContext();
    const onPlaybackStart = vi.fn();
    const onPlaybackIdle = vi.fn();
    const queue = new AudioPlaybackQueue(
      context as unknown as AudioContext,
      { playbackTailMs: 350, onPlaybackStart, onPlaybackIdle },
    );

    await queue.enqueue(0, new ArrayBuffer(8));

    expect(onPlaybackStart).toHaveBeenCalledOnce();
    expect(onPlaybackIdle).not.toHaveBeenCalled();

    context.sources[0].onended?.();
    await vi.advanceTimersByTimeAsync(349);
    expect(onPlaybackIdle).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(onPlaybackIdle).toHaveBeenCalledOnce();
  });

  it("stays paused when another chunk arrives during the acoustic tail", async () => {
    vi.useFakeTimers();
    const context = new FakeAudioContext();
    const onPlaybackStart = vi.fn();
    const onPlaybackIdle = vi.fn();
    const queue = new AudioPlaybackQueue(
      context as unknown as AudioContext,
      { playbackTailMs: 350, onPlaybackStart, onPlaybackIdle },
    );

    await queue.enqueue(0, new ArrayBuffer(8));
    context.sources[0].onended?.();
    await vi.advanceTimersByTimeAsync(200);
    await queue.enqueue(1, new ArrayBuffer(8));
    await vi.advanceTimersByTimeAsync(150);

    expect(onPlaybackStart).toHaveBeenCalledOnce();
    expect(onPlaybackIdle).not.toHaveBeenCalled();

    context.sources[1].onended?.();
    await vi.advanceTimersByTimeAsync(350);
    expect(onPlaybackIdle).toHaveBeenCalledOnce();
  });

  it("resumes capture after active playback is reset", async () => {
    vi.useFakeTimers();
    const context = new FakeAudioContext();
    const onPlaybackIdle = vi.fn();
    const queue = new AudioPlaybackQueue(
      context as unknown as AudioContext,
      { playbackTailMs: 350, onPlaybackIdle },
    );

    await queue.enqueue(0, new ArrayBuffer(8));
    queue.reset();
    await vi.advanceTimersByTimeAsync(350);

    expect(onPlaybackIdle).toHaveBeenCalledOnce();
  });
});
