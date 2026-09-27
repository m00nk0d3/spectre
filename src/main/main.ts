import { app, BrowserWindow, ipcMain } from "electron";
import path from "path";
import { spawnPythonServer } from "@/scripts/spawn-python-server";

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
      audioContext: true,
    },
  } as any);

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

  ipcMain.handle("wav-convert", async (_event, float32Data: Float32Array) => {
    try {
      const audioConverter = await import("@/utils/audio-converter").then(m => m);
      const wavBuffer = audioConverter.createWavBuffer(float32Data, 16000, 1);

      return { success: true, buffer: wavBuffer };
    } catch (error) {
      console.error("[WAV-CONVERT] Conversion failed:", error instanceof Error ? error.message : String(error));
      throw new Error(`WAV conversion failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  ipcMain.handle("wav-write-file", async (_event, float32Data: Float32Array, path: string) => {
    try {
      const audioConverter = await import("@/utils/audio-converter").then(m => m);
      await audioConverter.writeWavFile(float32Data, path);

      return { success: true, path };
    } catch (error) {
      console.error("[WAV-FILE] Write failed:", error instanceof Error ? error.message : String(error));
      throw new Error(`Failed to write WAV file: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  ipcMain.handle("vad-get-collected-audio", async (_event, _config?: { sampleRate?: number; channels?: number }) => {
    try {
      const vad = await import("@/renderer/vad").then(m => m.vadModule);
      if (!vad || !vad.collectedBuffers) {
        throw new Error("No audio buffers collected from VAD");
      }

      return { success: true, buffers: vad.collectedBuffers };
    } catch (error) {
      console.error("[VAD] Get collected audio failed:", error instanceof Error ? error.message : String(error));
      throw new Error(`Failed to get collected audio: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  ipcMain.handle("vad-trigger-wav-conversion", async (_event, config?: { sampleRate?: number; channels?: number }) => {
    try {
      const vad = await import("@/renderer/vad").then(m => m.vadModule);
      if (!vad.collectedBuffers || vad.collectedBuffers.length === 0) {
        throw new Error("No audio buffers to convert");
      }

      const audioConverter = await import("@/utils/audio-converter").then(m => m);
      const flattenedData = new Float32Array(
        vad.collectedBuffers.reduce((acc, buf) => acc + buf.length, 0)
      );
      let offset = 0;
      for (const buf of vad.collectedBuffers) {
        flattenedData.set(buf, offset);
        offset += buf.length;
      }
      const wavBuffer = audioConverter.createWavBuffer(flattenedData, config?.sampleRate ?? 16000, config?.channels ?? 1);

      return { success: true, buffer: wavBuffer };
    } catch (error) {
      console.error("[VAD-WAV] Conversion failed:", error instanceof Error ? error.message : String(error));
      throw new Error(`WAV conversion from VAD failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  ipcMain.handle("vad-capture-start", async () => {
    if (!isSpeechActive) {
      console.warn("[VAD] Capture not started - no active speech");
      return false;
    }
    console.log("[VAD] Audio capture enabled");
    return true;
  });

  ipcMain.handle("vad-capture-stop", async () => {
    if (isSpeechActive) {
      console.warn("[VAD] Capture not stopped - speech still active");
      return false;
    }
    console.log("[VAD] Audio capture disabled");
    return true;
  });

  ipcMain.handle("vad-clear-collected", async () => {
    const vad = await import("@/renderer/vad").then(m => m.vadModule);
    if (vad && vad.collectedBuffers) {
      vad.collectedBuffers = [];
    }
    console.log("[VAD] Cleared collected buffers");
    return true;
  });

  ipcMain.handle("vad-status", async () => {
    const vad = await import("@/renderer/vad").then(m => m.vadModule);
    if (!vad) {
      return { status: "not-initialized" };
    }
    return {
      status: vad.state.isSpeaking ? "speaking" : "idle",
      samplesCollected: vad.collectedBuffers?.length || 0,
    };
  });

  ipcMain.handle("vad-trigger-start", async () => {
    if (!isSpeechActive) {
      isSpeechActive = true;
      console.log("[SPECTRE] Speech started");
      return true;
    }
    return false;
  });

  ipcMain.handle("vad-trigger-end", async () => {
    console.log("[SPECTRE] Speech ended");
    isSpeechActive = false;
    return true;
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
