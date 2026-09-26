import { contextBridge, ipcRenderer } from "electron";

// Expose protected methods that allow the renderer process to call main IPC handlers
contextBridge.exposeInMainWorld("electron", {
  notifySpeechStart: () => ipcRenderer.invoke("speech-start"),
  notifySpeechEnd: () => ipcRenderer.invoke("speech-end"),
  getTTSAudio: (text: string) => ipcRenderer.invoke("get-tts-audio", text),
});
