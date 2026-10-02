import {
  app,
  BrowserWindow,
  ipcMain,
  net,
  protocol,
  session,
} from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  getTTSServerUrl,
  spawnPythonServer,
} from "../../scripts/spawn-python-server";
import { CONTEXT_MESSAGES } from "@/ai/messages/context";
import type { AudioBufferOutput, ConversationEvent } from "@/types/ipc";
import { createWavBuffer, writeWavFile } from "@/utils/audio-converter";
import { ConversationOrchestrator } from "./conversation-orchestrator";
import { streamTTSAudio } from "./stream-tts";
import { transcribeWithWhisperCpp } from "./whisper";

const WINDOW_MANAGER_CLASS = process.env.WINDOW_MANAGER_CLASS || "spectre";
const RENDERER_SCHEME = "spectre";

protocol.registerSchemesAsPrivileged([
  {
    scheme: RENDERER_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

let mainWindow: BrowserWindow | null = null;
let pythonPid: number | null = null;
let serverResult: { pid: number; ready: boolean } | null = null;
let isSpeechActive = false;
let conversation: ConversationOrchestrator | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    x: -1,
    y: -1,
    frame: false,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: true,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      audioContext: true,
    },
  } as Electron.BrowserWindowConstructorOptions);

  Object.assign(mainWindow, { windowClassName: WINDOW_MANAGER_CLASS });
  mainWindow.webContents.on("console-message", (details) => {
    console.log(`[RENDERER:${details.level}] ${details.message}`);
  });
  mainWindow.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL) => {
      console.error(
        `[RENDERER] Failed to load ${validatedURL}: ${errorCode} ${errorDescription}`,
      );
    },
  );

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}

function registerRendererProtocol(): void {
  const rendererRoot = path.resolve(__dirname, "../renderer");
  protocol.handle(RENDERER_SCHEME, (request) => {
    const url = new URL(request.url);
    if (url.hostname !== "renderer") {
      return new Response("Not found", { status: 404 });
    }

    const filePath = path.resolve(rendererRoot, `.${decodeURIComponent(url.pathname)}`);
    if (
      filePath !== rendererRoot &&
      !filePath.startsWith(`${rendererRoot}${path.sep}`)
    ) {
      return new Response("Forbidden", { status: 403 });
    }

    return net.fetch(pathToFileURL(filePath).toString());
  });
}

function sendConversationEvent(event: ConversationEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("conversation:event", event);
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle("conversation:process", async (_event, audio: Float32Array) => {
    if (!conversation) throw new Error("Conversation service is not ready");
    await conversation.process(audio);
  });

  ipcMain.handle("conversation:cancel", () => {
    conversation?.cancel();
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

  ipcMain.handle("get-tts-audio", async (_event, text: string): Promise<ArrayBuffer> => {
    if (!serverResult) throw new Error("Python TTS server not ready");
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      Number(process.env.OPENAI_TIMEOUT) || 30_000,
    );
    try {
      const response = await fetch(`${getTTSServerUrl()}/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          voice: process.env.TTS_VOICE || "pf_dora",
          response_format: "wav",
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const details = await response.text();
        throw new Error(
          `TTS API returned ${response.status}: ${details || response.statusText}`,
        );
      }
      return await response.arrayBuffer();
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new Error("TTS API request timed out");
      }
      // Deliberately no remote fallback: speech remains local.
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  });

  ipcMain.handle("get-tts-audio-stream", async (_event, text: string) => {
    const stream = streamTTSAudio(text, {
      apiKey: process.env.LM_STUDIO_API_KEY || "",
    });
    return new ReadableStream<{ seq: number; data: ArrayBuffer }>({
      async pull(controller) {
        const chunk = await stream.next();
        if (chunk.done) controller.close();
        else controller.enqueue(chunk.value);
      },
      async cancel() {
        await stream.return?.(undefined);
      },
    });
  });

  ipcMain.handle("python-status-request", () => {
    if (!serverResult) throw new Error("Python server not ready");
    return serverResult.ready;
  });
  ipcMain.handle("python-pid", () => pythonPid);

  ipcMain.handle("wav-convert", (_event, float32Data: Float32Array) => ({
    success: true,
    buffer: createWavBuffer(float32Data, 16000, 1),
  }));
  ipcMain.handle(
    "wav-write-file",
    async (_event, float32Data: Float32Array, filePath: string) => {
      await writeWavFile(float32Data, filePath);
      return { success: true, path: filePath };
    },
  );

  ipcMain.handle("audio-buffer-send", async (_event, float32Data: Float32Array | Buffer): Promise<AudioBufferOutput> => { if (float32Data.length === 0) throw new Error("Audio buffer is empty"); return { success: true, buffer: createWavBuffer(float32Data, 16000, 1) }; });

  ipcMain.handle("whisper-transcribe", async (_event, wavPath: string) => {
    const result = await transcribeWithWhisperCpp(wavPath);
    return result;
  });
}

app.whenReady().then(async () => {
  registerRendererProtocol();
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, permission, callback) => {
      callback(permission === "media");
    },
  );
  createWindow();
  registerIpcHandlers();
  conversation = new ConversationOrchestrator({
    workDirectory: path.join(app.getPath("userData"), "conversation-audio"),
    emit: sendConversationEvent,
  });

  console.log(
    `[AI-COMMUNICATIONS] Context messages initialized: ${CONTEXT_MESSAGES.length}`,
  );
  console.log(
    "[AI-COMMUNICATIONS] IDIOMA ESTRITO em português; FORMATAÇÃO ZERO sem Markdown, texto puro para síntese de voz; PERSONA AMIGO-PROFISSIONAL, conversacional, com bom senso de humor e respeito, não seja robótico.",
  );

  try {
    const result = await spawnPythonServer(
      process.env.KOKORO_MODEL_PATH || "",
    );
    pythonPid = result.pid;
    serverResult = result;
    if (!result.ready) {
      throw new Error("Python server failed to load GPU model within timeout");
    }
    console.log(`[PYTHON-SERVER] GPU model loaded on PID ${pythonPid}`);
  } catch (error) {
    console.error("[PYTHON-SERVER] Failed to start:", error);
    serverResult = null;
    pythonPid = null;
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("will-quit", () => {
  conversation?.cancel();
  if (pythonPid !== null) {
    try {
      process.kill(pythonPid, "SIGTERM");
    } catch (error) {
      console.error(
        "[PYTHON-SERVER] SIGTERM failed:",
        error instanceof Error ? error.message : String(error),
      );
    }
    pythonPid = null;
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
