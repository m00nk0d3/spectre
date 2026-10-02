#!/usr/bin/env node
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";

export function getManagedPythonPath(): string {
  const dataHome = process.env.XDG_DATA_HOME
    || path.join(os.homedir(), ".local", "share");
  const runtimeRoot = process.env.SPECTRE_PYTHON_RUNTIME
    || path.join(dataHome, "spectre", "python");

  return path.join(runtimeRoot, "bin", "python");
}

export function detectPython(): string {
  if (process.env.PYTHON_CMD) return process.env.PYTHON_CMD;
  const managedPython = getManagedPythonPath();
  if (fs.existsSync(managedPython)) return managedPython;
  if (fs.existsSync("/usr/bin/python3")) return "python3";
  if (fs.existsSync("/usr/local/bin/python3")) return "/usr/local/bin/python3";
  throw new Error(
    "Python3 not found. Run npm run setup:python or set PYTHON_CMD.",
  );
}

export type SpawnResult = { pid: number; ready: boolean };

const TIMEOUT_MS = 30000; // 30s timeout for GPU model loading
const DEFAULT_TTS_SERVER_PORT = 1235;

export function getTTSServerPort(): number {
  const configuredPort = Number(process.env.TTS_SERVER_PORT);

  return Number.isInteger(configuredPort) && configuredPort > 0
    ? configuredPort
    : DEFAULT_TTS_SERVER_PORT;
}

export function getTTSServerUrl(): string {
  return `http://127.0.0.1:${getTTSServerPort()}`;
}

export function resolvePythonServerCwd(): string {
  const packagedPath = path.join(
    process.resourcesPath,
    "app.asar.unpacked",
    "src",
    "main",
  );
  const developmentPath = path.resolve(process.cwd(), "src/main");
  const serverPath = fs.existsSync(packagedPath)
    ? packagedPath
    : developmentPath;

  if (!fs.existsSync(path.join(serverPath, "python_server", "main.py"))) {
    throw new Error(`Python server files not found at ${serverPath}`);
  }

  return serverPath;
}

export async function spawnPythonServer(
  modelPath: string = "",
): Promise<SpawnResult> {
  const cmd = detectPython();
  const serverCwd = resolvePythonServerCwd();
  const serverPort = getTTSServerPort();
  const args = [
    "-m", "uvicorn",
    "python_server.main:app",
    "--host", "127.0.0.1",
    "--port", String(serverPort),
  ];

  return new Promise((resolve, reject) => {
    let resolved = false;
    let exitCode: number | null = null;

    const pythonProcess = spawn(cmd, args, {
      cwd: serverCwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env,
        KOKORO_MODEL_PATH: modelPath,
        PYTHONUNBUFFERED: "1",
      },
    });

    const healthInterval = setInterval(async () => {
      if (resolved) return;

      try {
        const response = await fetch(`${getTTSServerUrl()}/health`);
        const health = await response.json() as {
          ready?: boolean;
          whisper_ready?: boolean;
        };
        if (!response.ok || !health.ready || !health.whisper_ready) return;

        resolved = true;
        clearInterval(healthInterval);
        clearTimeout(timeoutId);
        const pid = pythonProcess.pid ?? 0;
        console.log(`[PYTHON-SERVER] Ready on port ${serverPort}, PID ${pid}`);
        resolve({ pid, ready: true });
      } catch {
        // The server is still starting.
      }
    }, 250);

    const timeoutId = setTimeout(() => {
      if (resolved) return;

      resolved = true;
      clearInterval(healthInterval);
      pythonProcess.kill("SIGTERM");
      console.error("[PYTHON-SERVER] Timeout after 30s without model-ready marker");
      reject(new Error("Python server failed to load the model within 30s"));
    }, TIMEOUT_MS);

    let stdoutBuffer = "";

    pythonProcess.stdout?.on("data", (chunk: Buffer) => {
      if (resolved) return; // Already resolved, ignore further output

      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        console.log(`[PYTHON-SERVER] ${line}`);

        // Check exit code from output
        const exitMatch = line.match(/exit\s*code\s*:\s*(\d+)/i);
        if (exitMatch) {
          exitCode = parseInt(exitMatch[1], 10);
          console.log(`[PYTHON-SERVER] Exit code: ${exitCode}`);
          clearTimeout(timeoutId);
        }

        const normalizedLine = line.toLowerCase();
        if (normalizedLine.includes("model loaded successfully")) {
          stdoutBuffer = ""; // reset for next load
          console.log("[PYTHON-SERVER] GPU model loaded; waiting for health check");
        } else if (line.includes("Exception") || line.includes("Error")) {
          const errorMessage = `Python server error: ${line.trim()}`;
          console.error(`[PYTHON-SERVER] ${errorMessage}`);
          clearTimeout(timeoutId);
          if (!resolved) {
            resolved = true;
            reject(new Error(errorMessage));
          }
        }
      }
    });

    pythonProcess.stderr?.on("data", (chunk: Buffer) => {
      console.error(`[PYTHON-SERVER] ${chunk.toString().trimEnd()}`);
    });

    pythonProcess.on("error", (err) => {
      console.log("[PYTHON-SERVER] Error:", err.message);
      clearInterval(healthInterval);
      clearTimeout(timeoutId);
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });

    pythonProcess.on("close", (code) => {
      exitCode = code;
      clearInterval(healthInterval);
      if (!resolved) {
        resolved = true;
        const errorMsg = code !== null && code !== 0
          ? `Python server exited with non-zero code: ${code}`
          : "Python server closed unexpectedly";
        clearTimeout(timeoutId);
        console.log(`[PYTHON-SERVER] ${errorMsg}`);
        reject(new Error(errorMsg));
      }
    });
  });
}
