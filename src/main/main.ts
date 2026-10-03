import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  Notification,
  protocol,
  session,
  shell,
} from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  getTTSServerUrl,
  spawnPythonServer,
} from "../../scripts/spawn-python-server";
import { CONTEXT_MESSAGES } from "@/ai/messages/context";
import type {
  AudioBufferOutput,
  ConversationEvent,
  SandcastlePlanReference,
  SandcastlePrepareIssueRequest,
  SandcastleStopRequest,
} from "@/types/ipc";
import type { TextPresentationResponse } from "@/types/text-presentation";
import { createWavBuffer, writeWavFile } from "@/utils/audio-converter";
import { ConversationOrchestrator } from "./conversation-orchestrator";
import { ConversationMemory } from "./conversation-memory";
import {
  DiscordTransport,
  loadDiscordConfig,
  loadDiscordEnvironmentFile,
} from "./discord-transport";
import { DiscordNotificationMonitor } from "./discord-notification-monitor";
import { TextPresenter } from "./text-presenter";
import {
  GitHubMonitor,
  setActiveGitHubMonitor,
} from "./github-monitor";
import {
  githubService,
  type GitHubWritePlan,
} from "./github-service";
import { sandcastleService } from "./sandcastle-service";
import { streamTTSAudio } from "./stream-tts";
import {
  systemService,
  type SystemWritePlan,
} from "./system-service";
import { textPresentationService } from "./text-presentation";
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
let githubMonitor: GitHubMonitor | null = null;
let conversationMemory: ConversationMemory | null = null;
let discordTransport: DiscordTransport | null = null;
let discordNotificationMonitor: DiscordNotificationMonitor | null = null;

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
  mainWindow.on("closed", () => {
    mainWindow = null;
    textPresentationService.cancelAll();
  });

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

async function confirmGitHubWrite(plan: GitHubWritePlan): Promise<boolean> {
  return textPresentationService.confirm({
    kind: "confirmation",
    title: plan.title,
    content: [
      `Repository: ${plan.repository}`,
      "",
      plan.detail,
      "",
      "This operation will mutate GitHub using your local gh authentication.",
    ].join("\n"),
    spokenHint:
      "I need your confirmation for a GitHub change. The details are on screen.",
    confirmLabel: "Confirm GitHub write",
    cancelLabel: "Cancel",
  });
}

async function confirmSystemWrite(plan: SystemWritePlan): Promise<boolean> {
  return textPresentationService.confirm({
    kind: "confirmation",
    title: plan.title,
    content: [
      plan.detail,
      "",
      "This operation will modify the local filesystem.",
    ].join("\n"),
    spokenHint:
      "I need your confirmation for a local system change. The details are on screen.",
    confirmLabel: "Confirm system change",
    cancelLabel: "Cancel",
  });
}

function registerIpcHandlers(): void {
  ipcMain.handle("conversation:process", async (_event, audio: Float32Array) => {
    if (!conversation) throw new Error("Conversation service is not ready");
    await conversation.process(audio);
  });

  ipcMain.handle("conversation:cancel", () => {
    conversation?.cancel();
  });

  ipcMain.handle(
    "presentation:respond",
    (_event, response: TextPresentationResponse) => {
      if (
        !response
        || typeof response.id !== "string"
        || typeof response.accepted !== "boolean"
      ) {
        throw new Error("Invalid presentation response");
      }
      return textPresentationService.respond(response.id, response.accepted);
    },
  );

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
          voice: process.env.TTS_VOICE || "am_michael",
          speed: Number(process.env.TTS_SPEED) || 1.1,
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
    return serverResult?.ready ?? false;
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

  ipcMain.handle("sandcastle:projects", () =>
    sandcastleService.listProjects());

  ipcMain.handle(
    "sandcastle:workflows",
    (_event, project: string) =>
      sandcastleService.listWorkflows(project),
  );

  ipcMain.handle("sandcastle:plans", () =>
    sandcastleService.listPlans());

  ipcMain.handle(
    "sandcastle:prepare-issue",
    (_event, request: SandcastlePrepareIssueRequest) =>
      sandcastleService.prepareIssueWorkflow(
        request.project,
        request.issue,
      ),
  );

  ipcMain.handle(
    "sandcastle:open-plan",
    async (_event, reference: SandcastlePlanReference) => {
      const planPath = await sandcastleService.writePlanFile(
        reference.id,
        reference.hash,
      );
      const error = await shell.openPath(planPath);
      if (error) throw new Error(`Unable to open workflow plan: ${error}`);
    },
  );

  ipcMain.handle(
    "sandcastle:start-plan",
    async (_event, reference: SandcastlePlanReference) => {
      const plan = sandcastleService.getPlan(reference.id, reference.hash);
      const parent = mainWindow && !mainWindow.isDestroyed()
        ? mainWindow
        : undefined;
      const options: Electron.MessageBoxOptions = {
        type: "warning",
        title: "Start Sandcastle workflow?",
        message: plan.title,
        detail: [
          plan.summary,
          "",
          ...plan.effects.map((effect) => `• ${effect}`),
          "",
          `Plan hash: ${plan.hash}`,
        ].join("\n"),
        buttons: ["Cancel", "Start workflow"],
        cancelId: 0,
        defaultId: 0,
        noLink: true,
      };
      const confirmation = parent
        ? await dialog.showMessageBox(parent, options)
        : await dialog.showMessageBox(options);
      if (confirmation.response !== 1) return null;
      return sandcastleService.startPlan(reference.id, reference.hash);
    },
  );

  ipcMain.handle(
    "sandcastle:stop-workflow",
    async (_event, request: SandcastleStopRequest) => {
      const parent = mainWindow && !mainWindow.isDestroyed()
        ? mainWindow
        : undefined;
      const options: Electron.MessageBoxOptions = {
        type: "warning",
        title: "Stop and remove workflow?",
        message: `Stop ${request.runId}?`,
        detail:
          "Sandcastle will stop its owned process and agents, then remove the workflow run record.",
        buttons: ["Cancel", "Stop and remove"],
        cancelId: 0,
        defaultId: 0,
        noLink: true,
      };
      const confirmation = parent
        ? await dialog.showMessageBox(parent, options)
        : await dialog.showMessageBox(options);
      if (confirmation.response !== 1) return false;
      await sandcastleService.stopWorkflow(request.project, request.runId);
      return true;
    },
  );

  ipcMain.handle("github-monitor:snapshot", () => {
    if (!githubMonitor) throw new Error("GitHub monitor is not ready");
    return githubMonitor.getSnapshot();
  });

  ipcMain.handle("github-monitor:refresh", async () => {
    if (!githubMonitor) throw new Error("GitHub monitor is not ready");
    await githubMonitor.poll();
    return githubMonitor.getSnapshot();
  });

  ipcMain.handle("conversation-memory:snapshot", () => {
    if (!conversationMemory) throw new Error("Conversation memory is not ready");
    return conversationMemory.snapshot();
  });

  ipcMain.handle(
    "conversation-memory:set-enabled",
    (_event, enabled: boolean) => {
      if (!conversationMemory) {
        throw new Error("Conversation memory is not ready");
      }
      if (typeof enabled !== "boolean") {
        throw new Error("Memory enabled state must be boolean");
      }
      return conversationMemory.setEnabled(enabled);
    },
  );

  ipcMain.handle("conversation-memory:clear", async () => {
    if (!conversationMemory) throw new Error("Conversation memory is not ready");
    const parent = mainWindow && !mainWindow.isDestroyed()
      ? mainWindow
      : undefined;
    const options: Electron.MessageBoxOptions = {
      type: "warning",
      title: "Erase Spectre's conversation memory?",
      message: "This permanently deletes every remembered conversation turn.",
      detail:
        "The current conversation can continue, but deleted memory cannot be recovered.",
      buttons: ["Cancel", "Erase memory"],
      cancelId: 0,
      defaultId: 0,
      noLink: true,
    };
    const confirmation = parent
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options);
    if (confirmation.response !== 1) return null;
    return conversationMemory.clear();
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
  githubMonitor = new GitHubMonitor({
    statePath: path.join(
      app.getPath("userData"),
      "github-monitor",
      "state.json",
    ),
  });
  setActiveGitHubMonitor(githubMonitor);
  githubMonitor.onUpdate((snapshot) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("github-monitor:update", snapshot);
    }
  });
  githubMonitor.onEvent((event) => {
    if (!Notification.isSupported()) return;
    const notification = new Notification({
      title: `${event.repository} #${event.number}`,
      body: `${event.kind.replaceAll("_", " ")}: ${event.title}`,
      silent: false,
    });
    notification.on("click", () => {
      void shell.openExternal(event.url);
    });
    notification.show();
    if (event.kind === "review_requested") {
      void discordTransport?.notify({
        kind: "review_requested",
        title: `Review requested: ${event.repository} #${event.number}`,
        body: event.title,
        url: event.url,
      }).catch((error) => {
        void error;
        console.error("[DISCORD] Review notification failed safely");
      });
    }
  });
  registerIpcHandlers();
  conversationMemory = new ConversationMemory({
    statePath: path.join(
      app.getPath("userData"),
      "conversation-memory",
      "state.json",
    ),
  });
  await conversationMemory.load();
  textPresentationService.setEmitter((presentation) => {
    sendConversationEvent({ type: "presentation", presentation });
  });
  githubService.setConfirmationHandler(confirmGitHubWrite);
  systemService.setConfirmationHandler(confirmSystemWrite);
  conversation = new ConversationOrchestrator({
    workDirectory: path.join(app.getPath("userData"), "conversation-audio"),
    emit: sendConversationEvent,
    memory: conversationMemory,
    presenter: new TextPresenter({
      directory: path.join(app.getPath("userData"), "presentations"),
    }),
    dependencies: {
      presentInApp: async (title, content) => {
        textPresentationService.present({
          kind: "information",
          title,
          content,
        });
      },
    },
  });
  void githubMonitor.start();
  try {
    await loadDiscordEnvironmentFile(
      path.join(app.getPath("userData"), "discord.env"),
    );
    const discordConfig = loadDiscordConfig();
    if (discordConfig.enabled) {
      discordTransport = new DiscordTransport({
        config: discordConfig.config,
        memoryPath: path.join(
          app.getPath("userData"),
          "discord",
          "memory.json",
        ),
      });
      discordNotificationMonitor = new DiscordNotificationMonitor({
        statePath: path.join(
          app.getPath("userData"),
          "discord",
          "notifications.json",
        ),
        notify: (notification) => discordTransport!.notify(notification),
      });
      void discordTransport.start()
        .then(() => {
          void discordNotificationMonitor?.start().catch((error) => {
            void error;
            console.error(
              "[DISCORD] Proactive notification monitor unavailable",
            );
          });
        })
        .catch((error) => {
          void error;
          console.error(
            "[DISCORD] Transport unavailable; desktop startup continues",
          );
        });
    } else {
      console.info("[DISCORD] Transport disabled");
    }
  } catch (error) {
    console.error(
      "[DISCORD] Configuration error; transport disabled:",
      error instanceof Error ? error.message : String(error),
    );
  }

  console.log(
    `[AI-COMMUNICATIONS] Context messages initialized: ${CONTEXT_MESSAGES.length}`,
  );
  console.log(
    "[AI-COMMUNICATIONS] ENGLISH ONLY; polite concise close-friend persona; professional task execution.",
  );

  try {
    const result = await spawnPythonServer();
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
  conversation?.cancel();
  textPresentationService.setEmitter(null);
  githubService.setConfirmationHandler(null);
  systemService.setConfirmationHandler(null);
  githubMonitor?.stop();
  setActiveGitHubMonitor(null);
  discordNotificationMonitor?.stop();
  discordNotificationMonitor = null;
  void discordTransport?.stop();
  discordTransport = null;
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
