#!/usr/bin/env node
import { spawn } from "child_process";
import path from "path";
import fs from "fs";

export function detectPython(): string {
  if (process.env.PYTHON_CMD) return process.env.PYTHON_CMD;
  if (fs.existsSync("/usr/bin/python3")) return "python3";
  if (fs.existsSync("/usr/local/bin/python3")) return "/usr/local/bin/python3";
  throw new Error("Python3 not found. Set PYTHON_CMD or install Python3.");
}

export type SpawnResult = { pid: number; ready: boolean };

const TIMEOUT_MS = 30000; // 30s timeout for GPU model loading

export async function spawnPythonServer(
  modelPath: string = "",
): Promise<SpawnResult> {
  const cmd = detectPython();
  const args = ["-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", "1234"];

  return new Promise((resolve, reject) => {
    let ready = false;
    let resolved = false;
    let exitCode: number | null = null;
    const timeoutId = setTimeout(() => {
      console.log("[PYTHON-SERVER] Timeout after 30s without GPU marker");
      if (!resolved) resolve({ pid: 0, ready: false });
    }, TIMEOUT_MS);

    const pythonProcess = spawn(cmd, args, {
      cwd: path.resolve(path.dirname(__filename), "../src/main"),
      stdio: ["ignore", "pipe", "inherit"],
      env: { ...process.env, KOKORO_MODEL_PATH: modelPath },
    });

    let stdoutBuffer = "";

    pythonProcess.stdout.on("data", (chunk: Buffer) => {
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

        if (line.toLowerCase().includes("gpu") || line.toLowerCase().includes("kokoro")) {
          ready = true;
          stdoutBuffer = ""; // reset for next load
          resolved = true;
          resolve({ pid: pythonProcess.pid!, ready });
        } else if (line.includes("Exception") || line.includes("Error")) {
          const errorMessage = `Python server error: ${line.trim()}`;
          console.error(`[PYTHON-SERVER] ${errorMessage}`);
          clearTimeout(timeoutId);
          if (!resolved) reject(new Error(errorMessage));
        }
      }
    });

    pythonProcess.on("error", (err) => {
      console.log("[PYTHON-SERVER] Error:", err.message);
      clearTimeout(timeoutId);
      if (!resolved) reject(err);
    });

    pythonProcess.on("close", (code) => {
      exitCode = code;
      if (!resolved) {
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
