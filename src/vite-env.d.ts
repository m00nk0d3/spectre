/// <reference types="vite/client" />

declare global {
  interface Window {
    electron: import("@/types/ipc").ElectronAPI;
  }
}

// window.electron.sendAudioBuffer accepts Float32Array | Buffer via ElectronAPI.
export {};
