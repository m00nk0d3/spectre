import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import path from "path";

const PROJECT_ROOT = process.cwd();

describe("Issue #13: Whisper.cpp Local STT Handler - Organization, Types & Security", () => {
  // === CODE_ORGANIZATION TESTS ===

  it("should extract whisper-transcribe handler into separate module file", () => {
    const mainPath = path.join(PROJECT_ROOT, "src/main/main.ts");
    const whisperPath = path.join(PROJECT_ROOT, "src/main/whisper.ts");

    expect(existsSync(whisperPath)).toBe(true);

    const whisperContent = readFileSync(whisperPath, "utf8");
    const mainContent = readFileSync(mainPath, "utf8");

    // Handler should be extracted to separate module with clear function boundaries
    expect(whisperContent).toMatch(/export async function transcribeWithWhisperCpp/);
    expect(mainContent).toMatch(/import.*transcribeWithWhisperCpp.*from "\.\/whisper"/);
  });

  it("should have clean main.ts without massive inline handler", () => {
    const mainPath = path.join(PROJECT_ROOT, "src/main/main.ts");
    const content = readFileSync(mainPath, "utf8");

    // Handler should be decomposed into a single line call to module function
    expect(content).toMatch(/ipcMain\.handle\(["\']whisper-transcribe["']/);
    expect(content).toMatch(/await transcribeWithWhisperCpp\(wavPath\)/);
  });

  // === TYPE_CONSISTENCY TESTS ===

  it("should define WhisperTranscribeResponse as string type", () => {
    const typesPath = path.join(PROJECT_ROOT, "src/types/ipc.ts");

    if (!existsSync(typesPath)) {
      throw new Error("src/types/ipc.ts not found");
    }

    const content = readFileSync(typesPath, "utf8");

    // Expected: type is string (not string | null)
    expect(content).toMatch(/WhisperTranscribeResponse.*\s*=\s*string;/);
    expect(content).not.toMatch(/WhisperTranscribeResponse.*\s*=\s*string\s*\|\s*null/);
  });

  it("should export WhisperTranscribeRequest interface", () => {
    const typesPath = path.join(PROJECT_ROOT, "src/types/ipc.ts");

    if (!existsSync(typesPath)) {
      throw new Error("src/types/ipc.ts not found");
    }

    const content = readFileSync(typesPath, "utf8");
    expect(content).toMatch(/export interface WhisperTranscribeRequest/);
  });

  // === SECURITY TESTS ===

  it("should sanitize model path before shell interpolation", () => {
    const whisperPath = path.join(PROJECT_ROOT, "src/main/whisper.ts");
    const content = readFileSync(whisperPath, "utf8");

    expect(content).toMatch(/export function sanitizeShellArgument/);
  });

  it("should escape double quotes in shell arguments", () => {
    const whisperPath = path.join(PROJECT_ROOT, "src/main/whisper.ts");
    const content = readFileSync(whisperPath, "utf8");

    // Verify the code escapes quotes with \\" pattern
    expect(content).toContain('replace(/"/g');
  });

  it("should remove backticks from shell arguments", () => {
    const whisperPath = path.join(PROJECT_ROOT, "src/main/whisper.ts");
    const content = readFileSync(whisperPath, "utf8");

    // Verify the code removes backticks
    expect(content).toContain("Remove backticks (command substitution)");
  });

  it("should remove dollar signs from shell arguments", () => {
    const whisperPath = path.join(PROJECT_ROOT, "src/main/whisper.ts");
    const content = readFileSync(whisperPath, "utf8");

    // Verify the code removes $ characters
    expect(content).toContain('escaped.replace(/\\$/g');
  });

  it("should sanitize model path using normalize before use", () => {
    const whisperPath = path.join(PROJECT_ROOT, "src/main/whisper.ts");
    const content = readFileSync(whisperPath, "utf8");

    // Should call sanitizeShellArgument with path.normalize(modelPath)
    expect(content).toMatch(/sanitizeShellArgument.*path\.normalize.*modelPath/);
  });

  // === FUNCTIONAL TESTS ===

  it("should validate WAV file existence before processing", () => {
    const whisperPath = path.join(PROJECT_ROOT, "src/main/whisper.ts");
    const content = readFileSync(whisperPath, "utf8");

    expect(content).toMatch(/!fs\.existsSync\(wavPath\)/);
  });

  it("should throw error for missing WAV file", () => {
    const whisperPath = path.join(PROJECT_ROOT, "src/main/whisper.ts");
    const content = readFileSync(whisperPath, "utf8");

    expect(content).toMatch(/throw new Error.*WAV file does not exist/);
  });

  it("should handle Whisper.cpp executable not found error", () => {
    const whisperPath = path.join(PROJECT_ROOT, "src/main/whisper.ts");
    const content = readFileSync(whisperPath, "utf8");

    expect(content).toMatch(/stderr.*includes.*not found/);
  });

  it("should handle model error or empty output", () => {
    const whisperPath = path.join(PROJECT_ROOT, "src/main/whisper.ts");
    const content = readFileSync(whisperPath, "utf8");

    expect(content).toMatch(/stderr.*includes.*Model|stdout.*trim.*===\s*""/);
  });

  it("should extract last line of transcript from output", () => {
    const whisperPath = path.join(PROJECT_ROOT, "src/main/whisper.ts");
    const content = readFileSync(whisperPath, "utf8");

    expect(content).toMatch(/lines\[lines\.length - 1\]/);
  });

  // === IPC CONTRACT TESTS ===

  it("should accept single string argument from preload", () => {
    const mainPath = path.join(PROJECT_ROOT, "src/main/main.ts");
    const content = readFileSync(mainPath, "utf8");

    // Main handler should accept single wavPath string, not object destructure
    expect(content).toMatch(/ipcMain\.handle\(["\']whisper-transcribe["']/);
    expect(content).toMatch(/async.*_event.*wavPath: string/);
  });

  it("should not destructure request object in handler", () => {
    const mainPath = path.join(PROJECT_ROOT, "src/main/main.ts");
    const content = readFileSync(mainPath, "utf8");

    // Should NOT contain destructuring pattern that caused IPC contract mismatch
    expect(content).not.toMatch(/request:\s*\{.*wavPath/);
  });

  it("should call transcribeWithWhisperCpp with single string argument", () => {
    const mainPath = path.join(PROJECT_ROOT, "src/main/main.ts");
    const content = readFileSync(mainPath, "utf8");

    expect(content).toMatch(/await transcribeWithWhisperCpp\(wavPath\)/);
  });

  // === SECURITY TESTS - WAVE PATH SANITIZATION ===

  it("should sanitize wavPath before shell interpolation", () => {
    const whisperPath = path.join(PROJECT_ROOT, "src/main/whisper.ts");
    const content = readFileSync(whisperPath, "utf8");

    // Verify sanitizeShellArgument is called for wavPath
    expect(content).toMatch(/const sanitizedWavPath.*sanitizeShellArgument\(wavPath\)/);
  });

  it("should use sanitized wavPath in command", () => {
    const whisperPath = path.join(PROJECT_ROOT, "src/main/whisper.ts");
    const content = readFileSync(whisperPath, "utf8");

    // -f flag should use sanitizedWavPath, not raw wavPath
    expect(content).toMatch(/-f\s+"[^"]*sanitizedWavPath[^"]*"/);
  });

  it("should sanitize wavPath regardless of model path presence", () => {
    const whisperPath = path.join(PROJECT_ROOT, "src/main/whisper.ts");
    const content = readFileSync(whisperPath, "utf8");

    // wavPath sanitization should be unconditional
    expect(content).toMatch(/const sanitizedWavPath.*sanitizeShellArgument\(wavPath\)/);
  });

  // === COMMAND CONSTRUCTION TESTS ===

  it("should use consistent spacing pattern in command", () => {
    const whisperPath = path.join(PROJECT_ROOT, "src/main/whisper.ts");
    const content = readFileSync(whisperPath, "utf8");

    // Command structure: -f "path" ${modelFlag?} --no-timestamps
    // Should NOT have double-space between -f and model flag when model path present
    expect(content).toMatch(/-m\s+"[^"]*"/);
    expect(content).toMatch(/\-\-no-timestamps/);
  });

  it("should conditionally include model flag without trailing space", () => {
    const whisperPath = path.join(PROJECT_ROOT, "src/main/whisper.ts");
    const content = readFileSync(whisperPath, "utf8");

    // Model flag should not have trailing space before conditional --no-timestamps
    expect(content).toMatch(/-m\s+"[^"]*"/);
    expect(content).toMatch(/\-\-no-timestamps/);
  });

  // === ERROR HANDLING TESTS ===

  it("should reject on empty output from Whisper.cpp", () => {
    const whisperPath = path.join(PROJECT_ROOT, "src/main/whisper.ts");
    const content = readFileSync(whisperPath, "utf8");

    expect(content).toMatch(/lines\.length\s*===\s*0/);
  });

  it("should throw error for empty transcription output", () => {
    const whisperPath = path.join(PROJECT_ROOT, "src/main/whisper.ts");
    const content = readFileSync(whisperPath, "utf8");

    expect(content).toMatch(/reject.*new Error.*No transcription output/);
  });
});
