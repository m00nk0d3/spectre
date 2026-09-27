import { MicVAD } from "@ricky0123/vad-web";

interface VadConfig {
  silenceTimeoutMs?: number;
}

export interface VADState {
  isSpeaking: boolean;
  lastSpeechTime: number | null;
}

const DEFAULT_SILENCE_TIMEOUT_MS = parseInt(process.env.SILENCE_TIMEOUT_MS ?? "1500", 10);

interface VademoduleReturn {
  vad: MicVAD;
  state: VADState;
  start: () => void;
  stop: () => void;
  cleanup: () => void;
}

export function createVad(config?: VadConfig): VademoduleReturn {
  const silenceTimeoutMs = config?.silenceTimeoutMs ?? DEFAULT_SILENCE_TIMEOUT_MS;

  let vad: any = null;
  let isInitializing = false;

  // State tracking
  const state: VADState = {
    isSpeaking: false,
    lastSpeechTime: null,
  };

  // Audio buffer collection for WAV export
  const collectedBuffers: Float32Array[] = [];

  async function initialize(): Promise<void> {
    if (vad) return;

    if (isInitializing) return;
    isInitializing = true;

    try {
      vad = await MicVAD.new({
        getStream: async () => navigator.mediaDevices.getUserMedia({ audio: true }),
        pauseStream: async (stream) => {
          stream.getTracks().forEach(track => track.stop());
        },
        resumeStream: async (stream) => stream,
        startOnLoad: true,
        processorType: "ScriptProcessor",
      });
    } catch (err) {
      console.error("[VAD] Initialization error:", err);
      state.isSpeaking = false;
      return;
    } finally {
      isInitializing = false;
    }
  }

  async function start(): Promise<void> {
    await initialize();

    if (!vad) {
      console.warn("[VAD] Not initialized");
      return;
    }

    vad.startOnLoad = true;
  }

  function stop(): void {
    vad = null;
    state.isSpeaking = false;
    checkIntervalId = null;
  }

  function cleanup(): void {
    stop();
    vad?.off("frameprocessed");
    if (checkIntervalId !== null) {
      clearInterval(checkIntervalId);
      checkIntervalId = null;
    }
    // Clear collected buffers on cleanup
    collectedBuffers.length = 0;
  }

  const emitSpeechEvent = (event: "start" | "end") => {
    if (typeof window !== "undefined" && window.electron) {
      try {
        if (event === "start") {
          window.electron.notifySpeechStart();
          console.log("[VAD] Speech started");
        } else if (event === "end") {
          window.electron.notifySpeechEnd();
          console.log(`[VAD] Speech ended after ${silenceTimeoutMs}ms silence`);
        }
      } catch (err) {
        console.error("[VAD] IPC event failed:", err);
      }
    }
  };

  let checkIntervalId: ReturnType<typeof setInterval> | null = null;

  const monitorSpeech = (): void => {
    if (!vad) return;

    const now = Date.now();

    // If we haven't heard speech in silenceTimeoutMs, fire "end" event
    if (state.lastSpeechTime && now - state.lastSpeechTime > silenceTimeoutMs) {
      emitSpeechEvent("end");
      state.isSpeaking = false;
      state.lastSpeechTime = null;
    } else if (!vad.listening && state.lastSpeechTime !== null) {
      const timeSinceLastSpeech = now - state.lastSpeechTime;
      if (timeSinceLastSpeech > silenceTimeoutMs) {
        emitSpeechEvent("end");
        state.isSpeaking = false;
        state.lastSpeechTime = null;
      }
    } else if (!vad.listening && !state.isSpeaking) {
      if (state.lastSpeechTime !== null) {
        emitSpeechEvent("end");
        state.isSpeaking = false;
      }
    } else if (vad.listening) {
      state.isSpeaking = true;
      state.lastSpeechTime = now;

      if (!state.lastSpeechTime) {
        emitSpeechEvent("start");
        state.lastSpeechTime = now;
      }
    } else {
      (vad.isSpeaking = state.isSpeaking);
    }
  };

  checkIntervalId = setInterval(monitorSpeech, 100);

  return {
    vad,
    state,
    start,
    stop,
    cleanup,
  };
}

// Add audio collection methods to vadModule for IPC handling
export const vadModule: ReturnType<typeof createVad> & {
  collectedBuffers: Float32Array[];
  setCollectedBuffers: (buffers: Float32Array[]) => void;
  addCollectedBuffer: (buffer: Float32Array) => void;
} = Object.assign(createVad(), {
  collectedBuffers: [],
  setCollectedBuffers: (buffers: Float32Array[]) => {
    collectedBuffers.length = 0;
    for (const buf of buffers) {
      collectedBuffers.push(new Float32Array(buf));
    }
  },
  addCollectedBuffer: (buffer: Float32Array) => {
    collectedBuffers.push(new Float32Array(buffer));
  },
});

// Expose methods globally for IPC handlers in renderer context
if (typeof window !== "undefined") {
  (window as any).__vadCollectAudio = (buffer: Float32Array) => {
    vadModule.addCollectedBuffer(buffer);
  };
}
