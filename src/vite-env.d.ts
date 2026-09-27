/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly [key: string]: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
  readonly cwd: string;
}

declare global { interface ElectronAPI { sendAudioBuffer(buffer: Float32Array | Buffer): Promise<{ success: boolean; buffer?: ArrayBuffer }>; } interface Window { electron?: ElectronAPI; }; /* type for window.electron */ }
