export interface AudioAnalysis {
  amplitude: number;
  bass: number;
  treble: number;
  isPlaying: boolean;
}

export interface AudioPlaybackLifecycle {
  playbackTailMs?: number;
  onPlaybackStart?: () => void | Promise<void>;
  onPlaybackIdle?: () => void;
}

export class SequenceBuffer<T> {
  private expectedSequence = 0;
  private readonly pending = new Map<number, T>();

  push(sequence: number, value: T): T[] {
    if (sequence < this.expectedSequence || this.pending.has(sequence)) {
      return [];
    }
    this.pending.set(sequence, value);

    const ready: T[] = [];
    while (this.pending.has(this.expectedSequence)) {
      ready.push(this.pending.get(this.expectedSequence) as T);
      this.pending.delete(this.expectedSequence);
      this.expectedSequence += 1;
    }
    return ready;
  }

  reset(): void {
    this.expectedSequence = 0;
    this.pending.clear();
  }
}

export class AudioPlaybackQueue {
  private readonly context: AudioContext;
  private readonly analyser: AnalyserNode;
  private readonly frequencyData: Uint8Array;
  private readonly sequenceBuffer = new SequenceBuffer<ArrayBuffer>();
  private readonly sources = new Set<AudioBufferSourceNode>();
  private decodeChain = Promise.resolve();
  private nextStartTime = 0;
  private generation = 0;
  private pendingSchedules = 0;
  private playbackActive = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    context = new AudioContext({ latencyHint: "interactive" }),
    private readonly lifecycle: AudioPlaybackLifecycle = {},
  ) {
    this.context = context;
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0.72;
    this.analyser.connect(this.context.destination);
    this.frequencyData = new Uint8Array(this.analyser.frequencyBinCount);
  }

  enqueue(sequence: number, audio: ArrayBuffer): Promise<void> {
    const ready = this.sequenceBuffer.push(sequence, audio);
    const generation = this.generation;
    for (const chunk of ready) {
      this.pendingSchedules += 1;
      this.cancelIdle();
      this.decodeChain = this.decodeChain.then(() =>
        this.schedule(chunk, generation),
      );
    }
    return this.decodeChain;
  }

  enqueueImmediate(audio: ArrayBuffer): Promise<void> {
    const generation = this.generation;
    this.pendingSchedules += 1;
    this.cancelIdle();
    this.decodeChain = this.decodeChain.then(() =>
      this.schedule(audio, generation),
    );
    return this.decodeChain;
  }

  private async schedule(
    audio: ArrayBuffer,
    generation: number,
  ): Promise<void> {
    try {
      if (!(await this.activatePlayback(generation))) return;
      if (this.context.state === "suspended") await this.context.resume();

      const decoded = await this.context.decodeAudioData(audio.slice(0));
      if (generation !== this.generation) return;
      const source = this.context.createBufferSource();
      source.buffer = decoded;
      source.connect(this.analyser);

      const startTime = Math.max(
        this.context.currentTime + 0.015,
        this.nextStartTime,
      );
      this.nextStartTime = startTime + decoded.duration;
      this.sources.add(source);
      source.onended = () => {
        source.disconnect();
        this.sources.delete(source);
        if (this.sources.size === 0) {
          this.nextStartTime = this.context.currentTime;
        }
        this.scheduleIdle(generation);
      };
      source.start(startTime);
    } finally {
      if (generation === this.generation) {
        this.pendingSchedules = Math.max(0, this.pendingSchedules - 1);
        this.scheduleIdle(generation);
      }
    }
  }

  private async activatePlayback(generation: number): Promise<boolean> {
    if (generation !== this.generation) return false;
    this.cancelIdle();
    if (!this.playbackActive) {
      this.playbackActive = true;
      await this.lifecycle.onPlaybackStart?.();
    }
    return generation === this.generation;
  }

  private scheduleIdle(generation: number): void {
    if (
      generation !== this.generation ||
      !this.playbackActive ||
      this.pendingSchedules > 0 ||
      this.sources.size > 0 ||
      this.idleTimer
    ) {
      return;
    }

    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (
        generation !== this.generation ||
        this.pendingSchedules > 0 ||
        this.sources.size > 0
      ) {
        return;
      }
      this.playbackActive = false;
      this.lifecycle.onPlaybackIdle?.();
    }, this.lifecycle.playbackTailMs ?? 350);
  }

  private cancelIdle(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  analyze(): AudioAnalysis {
    this.analyser.getByteFrequencyData(this.frequencyData);

    let energy = 0;
    let bass = 0;
    let treble = 0;
    const bassEnd = Math.max(1, Math.floor(this.frequencyData.length * 0.18));
    const trebleStart = Math.floor(this.frequencyData.length * 0.55);

    for (let index = 0; index < this.frequencyData.length; index += 1) {
      const normalized = this.frequencyData[index] / 255;
      energy += normalized * normalized;
      if (index < bassEnd) bass += normalized;
      if (index >= trebleStart) treble += normalized;
    }

    return {
      amplitude: Math.sqrt(energy / this.frequencyData.length),
      bass: bass / bassEnd,
      treble: treble / (this.frequencyData.length - trebleStart),
      isPlaying: this.sources.size > 0,
    };
  }

  reset(): void {
    this.generation += 1;
    this.sequenceBuffer.reset();
    this.pendingSchedules = 0;
    this.cancelIdle();
    for (const source of this.sources) {
      source.onended = null;
      source.stop();
      source.disconnect();
    }
    this.sources.clear();
    this.nextStartTime = this.context.currentTime;
    this.scheduleIdle(this.generation);
  }

  async close(): Promise<void> {
    this.generation += 1;
    this.sequenceBuffer.reset();
    this.pendingSchedules = 0;
    this.cancelIdle();
    for (const source of this.sources) {
      source.onended = null;
      source.stop();
      source.disconnect();
    }
    this.sources.clear();
    this.playbackActive = false;
    await this.decodeChain;
    this.analyser.disconnect();
    if (this.context.state !== "closed") await this.context.close();
  }
}
