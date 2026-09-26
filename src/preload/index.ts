import { contextBridge, ipcRenderer } from "electron";

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld("electron", {
  onSpeechStart: (callback: () => void) => ipcRenderer.on("speech-start", callback),
  onSpeechEnd: (callback: () => void) => ipcRenderer.on("speech-end", callback),
  sendAudioBuffer: (buffer: ArrayBuffer) =>
    ipcRenderer.send("audio-buffer", buffer),
});
