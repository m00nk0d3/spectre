import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electron", {
  notifySpeechStart: () => ipcRenderer.invoke("speech-start"),
  notifySpeechEnd: () => ipcRenderer.invoke("speech-end"),
  getTTSAudio: (text: string): Promise<Buffer> => ipcRenderer.invoke("get-tts-audio", text),
  pythonStatusRequest: () => ipcRenderer.invoke("python-status-request"),
  pythonPid: () => ipcRenderer.invoke("python-pid"),
  createWavBuffer: async (float32Data: Float32Array): Promise<ArrayBuffer> => {
    return ipcRenderer.invoke("wav-convert", float32Data);
  },
  writeWavFile: async (float32Data: Float32Array, path: string): Promise<void> => {
    return ipcRenderer.invoke("wav-write-file", float32Data, path);
  },
  vadGetCollectedAudio: async (config?: { sampleRate?: number; channels?: number }) => {
    return ipcRenderer.invoke("vad-get-collected-audio", config);
  },
  vadTriggerWavConversion: async (config?: { sampleRate?: number; channels?: number }) => {
    return ipcRenderer.invoke("vad-trigger-wav-conversion", config);
  },
  vadCaptureStart: () => ipcRenderer.invoke("vad-capture-start"),
  vadCaptureStop: () => ipcRenderer.invoke("vad-capture-stop"),
  vadClearCollected: () => ipcRenderer.invoke("vad-clear-collected"),
  vadStatus: () => ipcRenderer.invoke("vad-status"),

  sendAudioBuffer: async (float32Data: Float32Array | Buffer): Promise<{ success: boolean; buffer?: ArrayBuffer }> => ipcRenderer.invoke("audio-buffer-send", float32Data),
});
