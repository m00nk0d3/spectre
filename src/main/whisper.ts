import path from "path";
import fs from "fs";
import os from "os";

function getManagedWhisperPaths() {
  const dataHome = process.env.XDG_DATA_HOME
    || path.join(os.homedir(), ".local", "share");
  const root = process.env.SPECTRE_WHISPER_RUNTIME
    || path.join(dataHome, "spectre", "whisper");
  const runtime = path.join(root, "runtime", "usr");

  return {
    executable: path.join(runtime, "bin", "whisper-cli"),
    model: path.join(root, "models", "ggml-base.bin"),
    libraryPath: path.join(runtime, "lib"),
    backendPath: path.join(
      runtime,
      "lib",
      "ggml",
      "libggml-cpu-x64.so",
    ),
  };
}

/**
 * Sanitizes a shell argument by escaping quotes and removing dangerous characters.
 * Prevents shell injection attacks when interpolating into commands.
 */
export function sanitizeShellArgument(arg: string): string {
  // Escape double quotes
  let escaped = arg.replace(/"/g, '\\"');
  // Remove backticks (command substitution)
  escaped = escaped.replace(/`/g, "");
  // Remove $ (variable expansion)
  escaped = escaped.replace(/\$/g, "");
  return escaped;
}

export async function transcribeWithWhisperCpp(wavPath: string, modelPath?: string): Promise<string> {
  if (!wavPath || !fs.existsSync(wavPath)) {
    throw new Error(`WAV file does not exist at path: ${wavPath}`);
  }

  const managed = getManagedWhisperPaths();
  const whisperPath = process.env.WHISPER_CPP_PATH || managed.executable;
  const resolvedModelPath = modelPath
    || process.env.WHISPER_MODEL_PATH
    || managed.model;
  if (!fs.existsSync(whisperPath)) {
    throw new Error(
      `Whisper.cpp executable not found at: ${whisperPath}. Run npm run setup:whisper.`,
    );
  }
  if (!fs.existsSync(resolvedModelPath)) {
    throw new Error(
      `Whisper model not found at: ${resolvedModelPath}. Run npm run setup:whisper.`,
    );
  }

  const sanitizedModelPath = sanitizeShellArgument(
    path.normalize(resolvedModelPath),
  );
  const sanitizedWavPath = sanitizeShellArgument(wavPath);

  const cmd = `"${whisperPath}" -f "${sanitizedWavPath}" -m "${sanitizedModelPath}" -l pt --no-gpu --no-timestamps`;

  console.log("[WHISPER] Executing:", cmd);

  const { exec } = await import("child_process");
  return new Promise((resolve, reject) => {
    exec(cmd, {
      env: {
        ...process.env,
        GGML_BACKEND_PATH: managed.backendPath,
        LD_LIBRARY_PATH: [
          managed.libraryPath,
          process.env.LD_LIBRARY_PATH,
        ].filter(Boolean).join(path.delimiter),
      },
    }, (error: Error | null, stdout: string, stderr: string) => {
      if (error) {
        console.error("[WHISPER] Command failed:", error.message);
        if (stderr?.includes("not found")) {
          reject(new Error(`Whisper.cpp executable not found at: ${whisperPath}`));
        } else if (stderr?.includes("Model") || stdout?.trim() === "") {
          reject(new Error(`Whisper.cpp model error or empty output`));
        } else {
          reject(error);
        }
        return;
      }

      const lines = stdout.split("\n").filter((l) => l.trim());
      if (lines.length === 0) {
        reject(new Error("No transcription output from Whisper.cpp"));
      } else {
        const transcript = lines[lines.length - 1].trim();
        console.log("[WHISPER] Transcription:", transcript.substring(0, 100) + "...");
        resolve(transcript);
      }
    });
  });
}
