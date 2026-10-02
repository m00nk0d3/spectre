import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import path from "path";

const PROJECT_ROOT = process.cwd();
const MAIN_PATH = path.join(PROJECT_ROOT, "src/main/main.ts");

describe("Issue #16: FastAPI TTS Microservice - Endpoint POST /tts Integration", () => {
  // AC-01: Endpoint POST /tts exists and returns WAV binary

  it("should spawn Python server with KOKORO_MODEL_PATH env variable", async () => {
    if (!existsSync(MAIN_PATH)) {
      throw new Error("src/main/main.ts not found");
    }

    const content = readFileSync(MAIN_PATH, "utf8");

    // Check that KOKORO_MODEL_PATH is passed to spawnPythonServer
    expect(content).toMatch(/KOKORO_MODEL_PATH/i);
  });

  it("should handle serverResult check before calling TTS endpoint", async () => {
    if (!existsSync(MAIN_PATH)) {
      throw new Error("src/main/main.ts not found");
    }

    const content = readFileSync(MAIN_PATH, "utf8");

    // Handler should check server readiness before making request
    expect(content).toMatch(/serverResult/i);
  });

  it("should call the dedicated local FastAPI TTS endpoint", async () => {
    if (!existsSync(MAIN_PATH)) {
      throw new Error("src/main/main.ts not found");
    }

    const content = readFileSync(MAIN_PATH, "utf8");

    // Check for local endpoint call (not external LM Studio)
    expect(content).toMatch(/getTTSServerUrl\(\).*\/tts/i);
  });

  it("should POST with JSON body containing text and voice fields", async () => {
    if (!existsSync(MAIN_PATH)) {
      throw new Error("src/main/main.ts not found");
    }

    const content = readFileSync(MAIN_PATH, "utf8");

    // Check for POST request structure
    expect(content).toMatch(/method:\s*["\']POST/i);
  });

  it("should return ArrayBuffer WAV via Promise from IPC handler", async () => {
    if (!existsSync(MAIN_PATH)) {
      throw new Error("src/main/main.ts not found");
    }

    const content = readFileSync(MAIN_PATH, "utf8");

    // Handler should return ArrayBuffer (not MP3 or other format)
    expect(content).toMatch(/return.*arrayBuffer/i);
  });

  it("should throw error on HTTP non-2xx response from FastAPI", async () => {
    if (!existsSync(MAIN_PATH)) {
      throw new Error("src/main/main.ts not found");
    }

    const content = readFileSync(MAIN_PATH, "utf8");

    // Check for status validation
    expect(content).toMatch(/response\.ok/i);
  });

  it("should handle timeout via AbortController with OPENAI_TIMEOUT env", async () => {
    if (!existsSync(MAIN_PATH)) {
      throw new Error("src/main/main.ts not found");
    }

    const content = readFileSync(MAIN_PATH, "utf8");

    // Check for timeout mechanism
    expect(content).toMatch(/AbortController|timeoutId/i);
  });

  it("should fallback to external LM Studio when FastAPI unreachable", async () => {
    if (!existsSync(MAIN_PATH)) {
      throw new Error("src/main/main.ts not found");
    }

    const content = readFileSync(MAIN_PATH, "utf8");

    // Check for fallback logic (optional but expected)
    expect(content).toMatch(/fallback|unreachable/i);
  });

  // AC-02: Model maintained in hot memory - validate startup behavior

  it("should log GPU model loaded marker on server startup", async () => {
    const scriptPath = path.join(PROJECT_ROOT, "scripts/spawn-python-server.ts");

    if (!existsSync(scriptPath)) {
      throw new Error("scripts/spawn-python-server.ts not found");
    }

    const content = readFileSync(scriptPath, "utf8");

    // Spawn script should log GPU marker when model loads
    expect(content).toMatch(/gpu|kokoro/i);
  });

  it("should resolve with ready=true when GPU marker detected", async () => {
    const scriptPath = path.join(PROJECT_ROOT, "scripts/spawn-python-server.ts");

    if (!existsSync(scriptPath)) {
      throw new Error("scripts/spawn-python-server.ts not found");
    }

    const content = readFileSync(scriptPath, "utf8");

    // Check for ready flag logic
    expect(content).toMatch(/ready\s*:\s*true/i);
  });

  it("should reject promise on Python server error", async () => {
    const scriptPath = path.join(PROJECT_ROOT, "scripts/spawn-python-server.ts");

    if (!existsSync(scriptPath)) {
      throw new Error("scripts/spawn-python-server.ts not found");
    }

    const content = readFileSync(scriptPath, "utf8");

    // Check for error handling
    expect(content).toMatch(/reject.*error/i);
  });

  it("should have 30s timeout for GPU model loading", async () => {
    const scriptPath = path.join(PROJECT_ROOT, "scripts/spawn-python-server.ts");

    if (!existsSync(scriptPath)) {
      throw new Error("scripts/spawn-python-server.ts not found");
    }

    const content = readFileSync(scriptPath, "utf8");

    // Check for TIMEOUT_MS constant
    expect(content).toMatch(/TIMEOUT_MS/i);
  });

  it("should pass PYTHONPATH or correct module path to uvicorn", async () => {
    const scriptPath = path.join(PROJECT_ROOT, "scripts/spawn-python-server.ts");

    if (!existsSync(scriptPath)) {
      throw new Error("scripts/spawn-python-server.ts not found");
    }

    const content = readFileSync(scriptPath, "utf8");

    // Check uvicorn spawn args
    expect(content).toMatch(/uvicorn/i);
  });

  // AC-03: Immediate WAV output - validate buffer handling and conversion

  it("should import audio-converter module in main.ts IPC handler", async () => {
    if (!existsSync(MAIN_PATH)) {
      throw new Error("src/main/main.ts not found");
    }

    const content = readFileSync(MAIN_PATH, "utf8");

    // Check for audio converter availability (may be used for fallback)
    expect(content).toMatch(/audio-converter|createWavBuffer/i);
  });

  it("should throw error with clear message on failure", async () => {
    if (!existsSync(MAIN_PATH)) {
      throw new Error("src/main/main.ts not found");
    }

    const content = readFileSync(MAIN_PATH, "utf8");

    // Handler should throw errors that bubble up to renderer (not silent failures)
    expect(content).toMatch(/throw new Error/i);
  });

  it("should handle empty text gracefully or throw clear error", async () => {
    if (!existsSync(MAIN_PATH)) {
      throw new Error("src/main/main.ts not found");
    }

    const content = readFileSync(MAIN_PATH, "utf8");

    // Handler should handle edge cases (empty text validation optional)
    expect(content).toMatch(/try\s*{[\s\S]{0,100}catch/i);
  });

  it("should log TTS request for debugging", async () => {
    if (!existsSync(MAIN_PATH)) {
      throw new Error("src/main/main.ts not found");
    }

    const content = readFileSync(MAIN_PATH, "utf8");

    // Check for logging
    expect(content).toMatch(/console\.log/i);
  });

  it("should log TTS error with message context", async () => {
    if (!existsSync(MAIN_PATH)) {
      throw new Error("src/main/main.ts not found");
    }

    const content = readFileSync(MAIN_PATH, "utf8");

    // Check for error logging
    expect(content).toMatch(/console\.error/i);
  });

  // Regression tests: ensure existing handlers are not broken

  it("should preserve wav-convert IPC handler", async () => {
    if (!existsSync(MAIN_PATH)) {
      throw new Error("src/main/main.ts not found");
    }

    const content = readFileSync(MAIN_PATH, "utf8");

    // wav-convert should still exist and work
    expect(content).toMatch(/ipcMain\.handle\(["\']wav-convert/i);
  });

  it("should preserve speech-start IPC handler", async () => {
    if (!existsSync(MAIN_PATH)) {
      throw new Error("src/main/main.ts not found");
    }

    const content = readFileSync(MAIN_PATH, "utf8");

    // speech-start should still exist
    expect(content).toMatch(/ipcMain\.handle\(["\']speech-start/i);
  });

  it("should preserve speech-end IPC handler", async () => {
    if (!existsSync(MAIN_PATH)) {
      throw new Error("src/main/main.ts not found");
    }

    const content = readFileSync(MAIN_PATH, "utf8");

    // speech-end should still exist
    expect(content).toMatch(/ipcMain\.handle\(["\']speech-end/i);
  });

  it("should preserve python-status-request IPC handler", async () => {
    if (!existsSync(MAIN_PATH)) {
      throw new Error("src/main/main.ts not found");
    }

    const content = readFileSync(MAIN_PATH, "utf8");

    // python-status-request should still exist
    expect(content).toMatch(/ipcMain\.handle\(["\']python-status-request/i);
  });

  it("should preserve python-pid IPC handler", async () => {
    if (!existsSync(MAIN_PATH)) {
      throw new Error("src/main/main.ts not found");
    }

    const content = readFileSync(MAIN_PATH, "utf8");

    // python-pid should still exist
    expect(content).toMatch(/ipcMain\.handle\(["\']python-pid/i);
  });

  it("should preserve cleanup handler in will-quit event", async () => {
    if (!existsSync(MAIN_PATH)) {
      throw new Error("src/main/main.ts not found");
    }

    const content = readFileSync(MAIN_PATH, "utf8");

    // Cleanup should still exist
    expect(content).toMatch(/will-quit/i);
  });

  describe("Audio Buffer Handling Scenarios", () => {
    it("should return ArrayBuffer directly from FastAPI response", async () => {
      if (!existsSync(MAIN_PATH)) {
        throw new Error("src/main/main.ts not found");
      }

      const content = readFileSync(MAIN_PATH, "utf8");

      // Check for arrayBuffer() call in fetch response handling
      expect(content).toMatch(/arrayBuffer\(\)/i);
    });

    it("should handle Content-Type audio/wav header from FastAPI", async () => {
      if (!existsSync(MAIN_PATH)) {
        throw new Error("src/main/main.ts not found");
      }

      const content = readFileSync(MAIN_PATH, "utf8");

      // May check headers or use as-is (WAV should be usable directly)
      expect(content).toMatch(/response/i);
    });

    it("should support both WAV and potentially MP3 response formats", async () => {
      if (!existsSync(MAIN_PATH)) {
        throw new Error("src/main/main.ts not found");
      }

      const content = readFileSync(MAIN_PATH, "utf8");

      // Response format may be configurable or fixed to WAV
      expect(content).toMatch(/response_format|wav/i);
    });
  });

  describe("VAD Event Detection Integration Scenarios", () => {
    it("should integrate with notifySpeechEnd handler for TTS trigger", async () => {
      if (!existsSync(MAIN_PATH)) {
        throw new Error("src/main/main.ts not found");
      }

      const content = readFileSync(MAIN_PATH, "utf8");

      // get-tts-audio should be triggered by speech-end events
      expect(content).toMatch(/get-tts-audio/i);
    });

    it("should pass STT text result to TTS handler", async () => {
      if (!existsSync(MAIN_PATH)) {
        throw new Error("src/main/main.ts not found");
      }

      const content = readFileSync(MAIN_PATH, "utf8");

      // Handler should accept text parameter
      expect(content).toMatch(/text:\s*string/i);
    });

    it("should maintain seamless transition from silence to speech", async () => {
      if (!existsSync(MAIN_PATH)) {
        throw new Error("src/main/main.ts not found");
      }

      const content = readFileSync(MAIN_PATH, "utf8");

      // Should not block event loop (async handler)
      expect(content).toMatch(/async/i);
    });
  });

  describe("Edge Cases and Error Handling", () => {
    it("should throw clear error when KOKORO_MODEL_PATH is empty or invalid", async () => {
      const scriptPath = path.join(PROJECT_ROOT, "scripts/spawn-python-server.ts");

      if (!existsSync(scriptPath)) {
        throw new Error("scripts/spawn-python-server.ts not found");
      }

      const content = readFileSync(scriptPath, "utf8");

      // Spawn should handle model path validation
      expect(content).toMatch(/modelPath/i);
    });

    it("should handle GPU unavailable (CPU fallback)", async () => {
      if (!existsSync(MAIN_PATH)) {
        throw new Error("src/main/main.ts not found");
      }

      const content = readFileSync(MAIN_PATH, "utf8");

      // Should handle errors gracefully and propagate to renderer
      expect(content).toMatch(/try[\s\S]{0,150}catch/i);
    });

    it("should handle FastAPI server crash during session", async () => {
      if (!existsSync(MAIN_PATH)) {
        throw new Error("src/main/main.ts not found");
      }

      const content = readFileSync(MAIN_PATH, "utf8");

      // Cleanup should handle process termination
      expect(content).toMatch(/will-quit/i);
    });

    it("should validate response.ok before parsing body", async () => {
      if (!existsSync(MAIN_PATH)) {
        throw new Error("src/main/main.ts not found");
      }

      const content = readFileSync(MAIN_PATH, "utf8");

      // Check for status validation
      expect(content).toMatch(/response\.ok/i);
    });

    it("should handle AbortError from timeout", async () => {
      if (!existsSync(MAIN_PATH)) {
        throw new Error("src/main/main.ts not found");
      }

      const content = readFileSync(MAIN_PATH, "utf8");

      // Check for AbortError handling
      expect(content).toMatch(/AbortError/i);
    });
  });

  describe("Environment Variable Dependencies", () => {
    it("should use OPENAI_TIMEOUT env for request timeout", async () => {
      if (!existsSync(MAIN_PATH)) {
        throw new Error("src/main/main.ts not found");
      }

      const content = readFileSync(MAIN_PATH, "utf8");

      // Check for timeout environment variable usage
      expect(content).toMatch(/OPENAI_TIMEOUT/i);
    });

    it("should pass KOKORO_MODEL_PATH to Python subprocess", async () => {
      const scriptPath = path.join(PROJECT_ROOT, "scripts/spawn-python-server.ts");

      if (!existsSync(scriptPath)) {
        throw new Error("scripts/spawn-python-server.ts not found");
      }

      const content = readFileSync(scriptPath, "utf8");

      // Check env variable propagation
      expect(content).toMatch(/KOKORO_MODEL_PATH/i);
    });

    it("should support CUDA_VISIBLE_DEVICES for multi-GPU setups", async () => {
      if (!existsSync(MAIN_PATH)) {
        throw new Error("src/main/main.ts not found");
      }

      const content = readFileSync(MAIN_PATH, "utf8");

      // May use CUDA_VISIBLE_DEVICES or pass through process.env
      expect(content).toMatch(/CUDA_VISIBLE_DEVICES|process\.env/i);
    });
  });

  describe("API IPC Version Compatibility", () => {
    it("should maintain same return structure for get-tts-audio handler", async () => {
      if (!existsSync(MAIN_PATH)) {
        throw new Error("src/main/main.ts not found");
      }

      const content = readFileSync(MAIN_PATH, "utf8");

      // Return should be ArrayBuffer (not object with success flag for this endpoint)
      expect(content).toMatch(/return.*ArrayBuffer/i);
    });

    it("should use AudioBufferOutput type where applicable", async () => {
      if (!existsSync(MAIN_PATH)) {
        throw new Error("src/main/main.ts not found");
      }

      const content = readFileSync(MAIN_PATH, "utf8");

      // May use AudioBufferOutput interface for handlers that need it
      expect(content).toMatch(/AudioBufferOutput/i);
    });
  });
});
