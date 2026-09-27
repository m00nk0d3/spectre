import path from "path";
import fs from "fs";

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

  const whisperPath = process.env.WHISPER_CPP_PATH || "./whisper.linux-x86_64.bin";
  const sanitizedModelPath = modelPath ? sanitizeShellArgument(path.normalize(modelPath)) : "";
  const sanitizedWavPath = sanitizeShellArgument(wavPath);

  const cmd = `"${whisperPath}" -f "${sanitizedWavPath}" ${modelPath ? `-m "${sanitizedModelPath}"` : ""} --no-timestamps`;

  console.log("[WHISPER] Executing:", cmd);

  const { exec } = await import("child_process");
  return new Promise((resolve, reject) => {
    exec(cmd, (error: Error | null, stdout: string, stderr: string) => {
      if (error) {
        console.error("[WHISPER] Command failed:", error.message);
        if (stderr?.includes("not found")) {
          reject(new Error(`Whisper.cpp executable not found at: ${whisperPath}`));
        } else if (stderr?.includes("Model") || stdout?.trim() === "") {
          reject(new Error(`Whisper.cpp model error or empty output`));
        } else {
          reject(error);
        }
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
