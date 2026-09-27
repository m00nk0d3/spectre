import { MicVAD } from "@ricky0123/vad-web";

interface VadConfig {
  silenceTimeoutMs?: number;
}

export interface VADState {
  isSpeaking: boolean;
  lastSpeechTime: number | null;
}

const DEFAULT_SILENCE_TIMEOUT_MS = parseInt(process.env.SILENCE_TIMEOUT_MS ?? "1500", 10);

export function createVad(config?: VadConfig): {
  vad: MicVAD;
  state: VADState;
  start: () => void;
  stop: () => void;
  cleanup: () => void;
} {
  const silenceTimeoutMs = config?.silenceTimeoutMs ?? DEFAULT_SILENCE_TIMEOUT_MS;

  // Initialize VAD with WebAssembly (runs in browser context)
  let vad: any = null;
  let isInitializing = false;

  // State tracking
  const state: VADState = {
    isSpeaking: false,
    lastSpeechTime: null,
  };

  async function initialize(): Promise<void> {
    if (vad) return;

    if (isInitializing) return;
    isInitializing = true;

    try {
      // VAD library loads WASM locally—no network required
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
  }

  // Fire IPC events when speech state changes
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

  // Check speech state periodically
  let checkIntervalId: ReturnType<typeof setInterval> | null = null;

  const monitorSpeech = (): void => {
    if (!vad) return;

    const now = Date.now();

    // Use MicVAD's built-in listening state and our own speech tracking
    // If we haven't heard speech in silenceTimeoutMs, fire "end" event
    if (state.lastSpeechTime && now - state.lastSpeechTime > silenceTimeoutMs) {
      emitSpeechEvent("end");
      state.isSpeaking = false;
      state.lastSpeechTime = null;
    } else if (!vad.listening && state.lastSpeechTime !== null) {
      // VAD stopped listening
      const timeSinceLastSpeech = now - state.lastSpeechTime;
      if (timeSinceLastSpeech > silenceTimeoutMs) {
        emitSpeechEvent("end");
        state.isSpeaking = false;
        state.lastSpeechTime = null;
      }
    } else if (!vad.listening && !state.isSpeaking) {
      // First detection of silence after speech
      if (state.lastSpeechTime !== null) {
        emitSpeechEvent("end");
        state.isSpeaking = false;
      }
    } else if (vad.listening) {
      state.isSpeaking = true;
      state.lastSpeechTime = now;

      // Emit start event only when transitioning from silent to speaking
      if (!state.lastSpeechTime) {
        emitSpeechEvent("start");
        state.lastSpeechTime = now;
      }
    } else {
      // For test compatibility: expose isSpeaking property on vad object
      (vad.isSpeaking = state.isSpeaking);
    }
  };

  checkIntervalId = setInterval(monitorSpeech, 100); // Check every 100ms

  return {
    vad,
    state,
    start,
    stop,
    cleanup,
  };
}

export const vadModule = createVad();
