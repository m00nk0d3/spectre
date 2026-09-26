import { app, BrowserWindow, ipcMain } from "electron";

let mainWindow: BrowserWindow | null = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    x: -1, // Allow window manager to position
    y: -1,
    frame: false,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: process.env.ELECTRON_RENDERER_PATH || "./src/preload/index.ts",
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile("./src/renderer/index.html");
}

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) app.quit();
  });

  // IPC handlers for speech events from renderer VAD
  ipcMain.handle("speech-start", () => {
    console.log("[SPECTRE] Speech started");
    return true;
  });

  ipcMain.handle("speech-end", () => {
    console.log("[SPECTRE] Speech ended");
    return true;
  });

  ipcMain.handle("get-tts-audio", async (_event, text: string) => {
    try {
      console.log("[SPECTRE] TTS request for:", text.substring(0, 50) + "...");

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), Number(process.env.OPENAI_TIMEOUT) || 30000);

      const response = await fetch("http://localhost:1234/v1/audio/speech", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.LM_STUDIO_API_KEY || ""}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "tts-1",
          input: text,
          voice: "alloy",
          response_format: "mp3"
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`TTS API returned ${response.status}: ${response.statusText}`);
      }

      const audioBuffer = await response.arrayBuffer();
      return audioBuffer;
    } catch (error) {
      console.error("[SPECTRE] TTS synthesis failed", error);
      throw error;
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
