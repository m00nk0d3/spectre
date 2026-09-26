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

export async function spawnPythonServer(
  modelPath: string = "",
): Promise<{ pid: number; ready: boolean }> {
  const cmd = detectPython();
  const args = ["-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", "1234"];

  let ready = false;
  let resolved = false;

  return new Promise((resolve) => {
    const pythonProcess = spawn(cmd, args, {
      cwd: path.dirname(__filename),
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
        if (line.toLowerCase().includes("gpu") || line.toLowerCase().includes("kokoro")) {
          ready = true;
          stdoutBuffer = ""; // reset for next load
          resolved = true;
          resolve({ pid: pythonProcess.pid!, ready });
        }
      }
    });

    pythonProcess.on("error", (err) => {
      console.log("[PYTHON-SERVER] Error:", err.message);
      if (!resolved) resolve({ pid: pythonProcess.pid!, ready: false });
    });

    pythonProcess.on("close", () => {
      if (!resolved && !ready) resolve({ pid: pythonProcess.pid!, ready: false });
    });
  });
}

export default spawnPythonServer;
