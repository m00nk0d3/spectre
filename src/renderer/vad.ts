import { MicVAD } from "@ricky0123/vad-web";

export interface VADState {
  isSpeaking: boolean;
  lastSpeechTime: number | null;
}

export interface VadConfig {
  silenceTimeoutMs?: number;
  onSpeechStart?: () => void | Promise<void>;
  onSpeechEnd?: (audio: Float32Array) => void | Promise<void>;
  onError?: (error: Error) => void;
}

const DEFAULT_SILENCE_TIMEOUT_MS = 1500;

export function createVad(config: VadConfig = {}) {
  const silenceTimeoutMs =
    config.silenceTimeoutMs ?? DEFAULT_SILENCE_TIMEOUT_MS;
  const state: VADState = {
    isSpeaking: false,
    lastSpeechTime: null,
  };
  let vad: MicVAD | null = null;
  let initialization: Promise<MicVAD> | null = null;
  let disposed = false;

  const initialize = (): Promise<MicVAD> => {
    if (vad) return Promise.resolve(vad);
    if (initialization) return initialization;

    initialization = MicVAD.new({
      startOnLoad: false,
      processorType: "AudioWorklet",
      redemptionMs: silenceTimeoutMs,
      onSpeechStart: async () => {
        state.isSpeaking = true;
        state.lastSpeechTime = Date.now();
        await config.onSpeechStart?.();
      },
      onSpeechEnd: async (audio) => {
        state.isSpeaking = false;
        state.lastSpeechTime = Date.now();
        await config.onSpeechEnd?.(audio);
      },
      onVADMisfire: () => {
        state.isSpeaking = false;
      },
    }).then((instance) => {
      if (disposed) {
        void instance.destroy();
        throw new Error("VAD initialization was cancelled");
      }
      vad = instance;
      return instance;
    }).catch((error: unknown) => {
      initialization = null;
      const normalized = error instanceof Error ? error : new Error(String(error));
      config.onError?.(normalized);
      throw normalized;
    });

    return initialization;
  };

  return {
    state,
    async start(): Promise<void> {
      disposed = false;
      const instance = await initialize();
      await instance.start();
    },
    async stop(): Promise<void> {
      state.isSpeaking = false;
      if (vad) await vad.pause();
    },
    async cleanup(): Promise<void> {
      disposed = true;
      state.isSpeaking = false;
      if (vad) {
        await vad.destroy();
      } else if (initialization) {
        await initialization.catch(() => undefined);
      }
      vad = null;
      initialization = null;
    },
  };
}
