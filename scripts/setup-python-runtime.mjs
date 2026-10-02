#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";

const dataHome = process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share");
const runtimeRoot = process.env.SPECTRE_PYTHON_RUNTIME
  || path.join(dataHome, "spectre", "python");
const pythonPath = path.join(runtimeRoot, "bin", "python");
const requirementsPath = path.resolve(
  process.cwd(),
  "src/main/python_server/requirements.txt",
);

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: process.env,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
}

if (!existsSync(requirementsPath)) {
  throw new Error(`Requirements file not found at ${requirementsPath}`);
}

if (!existsSync(pythonPath)) {
  run("uv", ["venv", "--python", "3.12", runtimeRoot]);
}

run("uv", [
  "pip",
  "install",
  "--python",
  pythonPath,
  "--requirements",
  requirementsPath,
]);

console.log(`[SPECTRE] Managed Python runtime ready at ${pythonPath}`);
