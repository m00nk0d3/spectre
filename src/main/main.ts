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
      preload: "/home/m00nk0d3/dev/spectre/.sandcastle/worktrees/agent-1-1-inicializar-template-react-6/src/preload/index.ts",
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

  ipcMain.handle("get-tts-audio", async (event, text: string) => {
    // TODO: Implement OpenAI TTS synthesis here
    console.log("[SPECTRE] TTS request for:", text.substring(0, 50) + "...");
    return null;
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
