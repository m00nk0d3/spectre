import { app, BrowserWindow, ipcMain } from "electron";
import path from "path";
import { spawnPythonServer } from "@/scripts/spawn-python-server";

// PYTHON_CMD environment variable fallback handled in scripts/spawn-python-server module
const WINDOW_MANAGER_CLASS = process.env.WINDOW_MANAGER_CLASS || "spectre";

let mainWindow: BrowserWindow | null = null;
let pythonProcess: any = null;
let pythonPid: number | null = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    x: -1,
    y: -1,
    frame: false,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index"),
      contextIsolation: true,
      nodeIntegration: false,
      // audioContext is needed for VAD microphone access (runtime-only feature)
      audioContext: true,
    },
  } as any);

  // Hyprland window manager integration class name
  (mainWindow as any).windowClassName = WINDOW_MANAGER_CLASS;

  mainWindow.loadFile("./index.html");
}

let serverResult: { pid: number; ready: boolean } | null = null;
let isSpeechActive = false;

  app.whenReady().then(async () => {
    createWindow();

    try {
      const result = await spawnPythonServer(process.env.KOKORO_MODEL_PATH || "");
      pythonPid = result.pid;
      serverResult = result;

      if (!result.ready) {
        throw new Error("Python server failed to load GPU model within timeout");
      }

      console.log(`[PYTHON-SERVER] GPU model loaded on PID ${pythonPid}`);
    } catch (err) {
      console.error("[PYTHON-SERVER] Failed to start:", err);
      throw err;
    }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) app.quit();
    });

    ipcMain.handle("speech-start", () => {
      if (!isSpeechActive) {
        isSpeechActive = true;
        console.log("[SPECTRE] Speech started");
        return true;
      }
      return false;
    });

    ipcMain.handle("speech-end", () => {
      console.log("[SPECTRE] Speech ended");
      isSpeechActive = false;
      return true;
    });

    ipcMain.handle("get-tts-audio", async (_event, text: string) => {
      try {
        console.log("[SPECTRE] TTS request for:", text.substring(0, 50) + "...");

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), Number(process.env.OPENAI_TIMEOUT) || 30000);

        try {
          const apiAuth = process.env.LM_STUDIO_API_KEY || "";
          if (!apiAuth) {
            throw new Error("LM_STUDIO_API_KEY environment variable is not set");
          }

          const response = await fetch("http://localhost:1234/v1/audio/speech", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${apiAuth}`,
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
        } catch (fetchError) {
          clearTimeout(timeoutId);

          let errorMessage: string;
          if (fetchError instanceof TypeError && fetchError.message.includes("Failed to fetch")) {
            errorMessage = "TTS API request failed. Please check if LM Studio is running and accessible on port 1234.";
          } else if (fetchError instanceof DOMException && (fetchError.name === "AbortError" || fetchError.message.includes("timeout"))) {
            errorMessage = "TTS API request timed out after 30s. The model may be slow or unavailable.";
          } else {
            errorMessage = `TTS API error: ${fetchError instanceof Error ? fetchError.message : String(fetchError)}`;
          }

          console.error("[SPECTRE]", errorMessage);
          throw new Error(errorMessage);
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error("[SPECTRE] TTS synthesis failed", errorMessage);
        throw new Error(`TTS API request ${errorMessage}`);
      }
    });

    ipcMain.handle("python-status-request", async () => {
      if (!serverResult) {
        console.error("[PYTHON-SERVER] Server not yet initialized");
        throw new Error("Python server not ready");
      }
      return serverResult.ready;
    });

    ipcMain.handle("python-pid", () => {
      return pythonPid !== null ? pythonPid : null;
    });
  });

app.on("will-quit", () => {
  if (pythonProcess && pythonPid !== null) {
    console.log("[PYTHON-SERVER] Killing subprocess PID:", pythonPid);
    try {
      process.kill(Number(pythonPid), "SIGTERM");
    } catch (e: unknown) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      console.error("[PYTHON-SERVER] SIGTERM failed:", errorMsg);
      // Fallback to SIGKILL for stubborn processes
      try {
        process.kill(Number(pythonPid), "SIGKILL");
        console.log("[PYTHON-SERVER] Used SIGKILL to terminate subprocess");
      } catch (sigkillErr: unknown) {
        const sigkillMsg = sigkillErr instanceof Error ? sigkillErr.message : String(sigkillErr);
        console.error("[PYTHON-SERVER] SIGKILL also failed:", sigkillMsg);
      }
    }
    pythonProcess = null;
    pythonPid = null;
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
