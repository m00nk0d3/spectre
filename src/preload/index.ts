import { contextBridge, ipcRenderer } from "electron";
import type {
  AudioBufferOutput,
  ConversationEvent,
  ElectronAPI,
} from "@/types/ipc";

const electronApi: ElectronAPI = {
  processConversation: (audio) =>
    ipcRenderer.invoke("conversation:process", audio),
  cancelConversation: () => ipcRenderer.invoke("conversation:cancel"),
  onConversationEvent: (listener) => {
    const wrappedListener = (
      _event: Electron.IpcRendererEvent,
      payload: ConversationEvent,
    ) => listener(payload);
    ipcRenderer.on("conversation:event", wrappedListener);
    return () => {
      ipcRenderer.removeListener("conversation:event", wrappedListener);
    };
  },
  notifySpeechStart: () => ipcRenderer.invoke("speech-start"),
  notifySpeechEnd: () => ipcRenderer.invoke("speech-end"),
  getTTSAudio: (text) => ipcRenderer.invoke("get-tts-audio", text),
  pythonStatusRequest: () => ipcRenderer.invoke("python-status-request"),
  pythonPid: () => ipcRenderer.invoke("python-pid"),
  createWavBuffer: (float32Data) =>
    ipcRenderer.invoke("wav-convert", float32Data),
  writeWavFile: (float32Data, filePath) =>
    ipcRenderer.invoke("wav-write-file", float32Data, filePath),
  sendAudioBuffer: (float32Data: Float32Array | Buffer): Promise<AudioBufferOutput> => ipcRenderer.invoke("audio-buffer-send", float32Data),
  whisperTranscribe: (wavPath) =>
    ipcRenderer.invoke("whisper-transcribe", wavPath),
};

contextBridge.exposeInMainWorld("electron", electronApi);
