#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";

const dataHome = process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share");
const runtimeRoot = process.env.SPECTRE_WHISPER_RUNTIME
  || path.join(dataHome, "spectre", "whisper");
const packagesDirectory = path.join(runtimeRoot, "packages");
const extractedDirectory = path.join(runtimeRoot, "runtime");
const modelDirectory = path.join(runtimeRoot, "models");
const pythonRuntime = process.env.SPECTRE_PYTHON_RUNTIME
  || path.join(dataHome, "spectre", "python");
const pythonPath = path.join(pythonRuntime, "bin", "python");
const fasterWhisperDirectory = path.join(runtimeRoot, "faster-whisper");

const artifacts = [
  {
    name: "ggml.pkg.tar.zst",
    url: "https://archive.archlinux.org/packages/g/ggml/ggml-0.21.0-1-x86_64.pkg.tar.zst",
  },
  {
    name: "ggml-cpu.pkg.tar.zst",
    url: "https://archive.archlinux.org/packages/g/ggml-cpu/ggml-cpu-0.21.0-1-x86_64.pkg.tar.zst",
  },
  {
    name: "whisper-cpp.pkg.tar.zst",
    url: "https://archive.archlinux.org/packages/w/whisper-cpp/whisper-cpp-1.9.4-1-x86_64.pkg.tar.zst",
  },
];

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
}

mkdirSync(packagesDirectory, { recursive: true });
mkdirSync(extractedDirectory, { recursive: true });
mkdirSync(modelDirectory, { recursive: true });

for (const artifact of artifacts) {
  const destination = path.join(packagesDirectory, artifact.name);
  if (!existsSync(destination)) {
    run("curl", ["--fail", "--location", "--output", destination, artifact.url]);
  }
  run("bsdtar", ["-xf", destination, "-C", extractedDirectory]);
}

const modelPath = path.join(modelDirectory, "ggml-small.bin");
if (!existsSync(modelPath)) {
  run("curl", [
    "--fail",
    "--location",
    "--output",
    modelPath,
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
  ]);
}

if (!existsSync(pythonPath)) {
  throw new Error(
    `Managed Python runtime not found at ${pythonPath}. Run npm run setup:python first.`,
  );
}
run(pythonPath, [
  "-c",
  [
    "from faster_whisper import WhisperModel",
    `WhisperModel("small", device="cpu", compute_type="int8", download_root=${JSON.stringify(fasterWhisperDirectory)})`,
  ].join(";"),
]);

console.log(`[SPECTRE] Managed Whisper runtime ready at ${runtimeRoot}`);
