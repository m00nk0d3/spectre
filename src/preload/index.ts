import { contextBridge, ipcRenderer } from "electron";
import type {
  AudioBufferOutput,
  ConversationEvent,
  ElectronAPI,
} from "@/types/ipc";
import type { GitHubMonitorSnapshot } from "@/types/github-monitor";

const electronApi: ElectronAPI = {
  processConversation: (audio) =>
    ipcRenderer.invoke("conversation:process", audio),
  cancelConversation: () => ipcRenderer.invoke("conversation:cancel"),
  onConversationEvent: (listener) => {
    const wrappedListener = (
      _event: Electron.IpcRendererEvent,
      payload: ConversationEvent,
    ) => listener(payload);
    ipcRenderer.on("conversation:event", wrappedListener);
    return () => {
      ipcRenderer.removeListener("conversation:event", wrappedListener);
    };
  },
  respondToPresentation: (response) =>
    ipcRenderer.invoke("presentation:respond", response),
  notifySpeechStart: () => ipcRenderer.invoke("speech-start"),
  notifySpeechEnd: () => ipcRenderer.invoke("speech-end"),
  getTTSAudio: (text) => ipcRenderer.invoke("get-tts-audio", text),
  pythonStatusRequest: () => ipcRenderer.invoke("python-status-request"),
  pythonPid: () => ipcRenderer.invoke("python-pid"),
  createWavBuffer: (float32Data) =>
    ipcRenderer.invoke("wav-convert", float32Data),
  writeWavFile: (float32Data, filePath) =>
    ipcRenderer.invoke("wav-write-file", float32Data, filePath),
  sendAudioBuffer: (float32Data: Float32Array | Buffer): Promise<AudioBufferOutput> => ipcRenderer.invoke("audio-buffer-send", float32Data),
  whisperTranscribe: (wavPath) =>
    ipcRenderer.invoke("whisper-transcribe", wavPath),
  listSandcastleProjects: () =>
    ipcRenderer.invoke("sandcastle:projects"),
  listSandcastleWorkflows: (project) =>
    ipcRenderer.invoke("sandcastle:workflows", project),
  listSandcastlePlans: () =>
    ipcRenderer.invoke("sandcastle:plans"),
  prepareSandcastleIssue: (request) =>
    ipcRenderer.invoke("sandcastle:prepare-issue", request),
  openSandcastlePlan: (reference) =>
    ipcRenderer.invoke("sandcastle:open-plan", reference),
  startSandcastlePlan: (reference) =>
    ipcRenderer.invoke("sandcastle:start-plan", reference),
  stopSandcastleWorkflow: (request) =>
    ipcRenderer.invoke("sandcastle:stop-workflow", request),
  getGitHubMonitorSnapshot: () =>
    ipcRenderer.invoke("github-monitor:snapshot"),
  refreshGitHubMonitor: () =>
    ipcRenderer.invoke("github-monitor:refresh"),
  onGitHubMonitorUpdate: (listener) => {
    const wrappedListener = (
      _event: Electron.IpcRendererEvent,
      snapshot: GitHubMonitorSnapshot,
    ) => listener(snapshot);
    ipcRenderer.on("github-monitor:update", wrappedListener);
    return () => {
      ipcRenderer.removeListener("github-monitor:update", wrappedListener);
    };
  },
  getConversationMemory: () =>
    ipcRenderer.invoke("conversation-memory:snapshot"),
  setConversationMemoryEnabled: (enabled) =>
    ipcRenderer.invoke("conversation-memory:set-enabled", enabled),
  clearConversationMemory: () =>
    ipcRenderer.invoke("conversation-memory:clear"),
};

contextBridge.exposeInMainWorld("electron", electronApi);
