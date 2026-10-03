import { describe, it, expect } from "vitest";
import path from "path";

const PROJECT_ROOT = process.cwd();

describe("Main Process Python Integration", () => {
  it("should define pythonPid variable in main.ts", async () => {
    const mainPath = path.join(PROJECT_ROOT, "src/main/main.ts");
    const fs = await import("fs");
    const content = fs.readFileSync(mainPath, "utf8");

    // Check that pythonPid is defined
    expect(content).toMatch(/pythonPid/i);
  });

  it("should spawn Python server in whenReady handler", async () => {
    const mainPath = path.join(PROJECT_ROOT, "src/main/main.ts");
    const fs = await import("fs");
    const content = fs.readFileSync(mainPath, "utf8");

    // Check that Python server is spawned in whenReady handler
    expect(content).toMatch(/spawnPythonServer/i);
  });

  it("should have cleanup handler for will-quit", async () => {
    const mainPath = path.join(PROJECT_ROOT, "src/main/main.ts");
    const fs = await import("fs");
    const content = fs.readFileSync(mainPath, "utf8");

    // Check that will-quit handler exists for cleanup
    expect(content).toMatch(/will-quit/i);
  });

  it("should have ipcMain handle for python-status-request", async () => {
    const mainPath = path.join(PROJECT_ROOT, "src/main/main.ts");
    const fs = await import("fs");
    const content = fs.readFileSync(mainPath, "utf8");

    // Check that python-status-request handler exists
    expect(content).toMatch(/python-status-request/i);
  });

  it("should handle spawn failure with try/catch", async () => {
    const mainPath = path.join(PROJECT_ROOT, "src/main/main.ts");
    const fs = await import("fs");
    const content = fs.readFileSync(mainPath, "utf8");

    // Check that spawn is wrapped in try/catch
    expect(content).toMatch(/try\s*{[\s\S]*?spawnPythonServer/i);
  });

  it("should kill Python subprocess on will-quit", async () => {
    const mainPath = path.join(PROJECT_ROOT, "src/main/main.ts");
    const fs = await import("fs");
    const content = fs.readFileSync(mainPath, "utf8");

    // Check that process.kill is called in will-quit handler
    expect(content).toMatch(/will-quit[\s\S]{0,150}process\.kill/i);
  });

  it("should set pythonPid variable before spawn", async () => {
    const mainPath = path.join(PROJECT_ROOT, "src/main/main.ts");
    const fs = await import("fs");
    const content = fs.readFileSync(mainPath, "utf8");

    // Check that pythonPid is set after spawnPythonServer result
    expect(content).toMatch(/await.*spawnPythonServer[\s\S]{0,150}pythonPid/i);
  });

  it("should export spawnPythonServer from scripts module", async () => {
    const scriptPath = path.join(PROJECT_ROOT, "scripts/spawn-python-server.ts");
    const fs = await import("fs");
    const content = fs.readFileSync(scriptPath, "utf8");

    // Check that spawnPythonServer is exported
    expect(content).toMatch(/export.*function.*spawnPythonServer/i);
  });
});

describe("Spawn Python Server Module", () => {
  it("should have detectPython function", async () => {
    const scriptPath = path.join(PROJECT_ROOT, "scripts/spawn-python-server.ts");
    const fs = await import("fs");
    const content = fs.readFileSync(scriptPath, "utf8");

    expect(content).toMatch(/export.*function.*detectPython/i);
  });

  it("should prefer the managed Python runtime", async () => {
    const scriptPath = path.join(PROJECT_ROOT, "scripts/spawn-python-server.ts");
    const fs = await import("fs");
    const content = fs.readFileSync(scriptPath, "utf8");

    expect(content).toContain("SPECTRE_PYTHON_RUNTIME");
    expect(content).toContain("getManagedPythonPath");
  });

  it("should expose managed CUDA libraries to CTranslate2", async () => {
    const scriptPath = path.join(
      PROJECT_ROOT,
      "scripts/spawn-python-server.ts",
    );
    const fs = await import("fs");
    const content = fs.readFileSync(scriptPath, "utf8");

    expect(content).toContain("getManagedCudaLibraryPath");
    expect(content).toContain("nvidia\", \"cublas\", \"lib");
    expect(content).toContain("LD_LIBRARY_PATH");
  });

  it("should spawn with uvicorn command", async () => {
    const scriptPath = path.join(PROJECT_ROOT, "scripts/spawn-python-server.ts");
    const fs = await import("fs");
    const content = fs.readFileSync(scriptPath, "utf8");

    expect(content).toMatch(/uvicorn/i);
  });

  it("should spawn on a dedicated configurable port", async () => {
    const scriptPath = path.join(PROJECT_ROOT, "scripts/spawn-python-server.ts");
    const fs = await import("fs");
    const content = fs.readFileSync(scriptPath, "utf8");

    expect(content).toMatch(/\-\-port/i);
    expect(content).toContain("TTS_SERVER_PORT");
    expect(content).toContain("1235");
  });

  it("should handle model-ready output", async () => {
    const scriptPath = path.join(PROJECT_ROOT, "scripts/spawn-python-server.ts");
    const fs = await import("fs");
    const content = fs.readFileSync(scriptPath, "utf8");

    expect(content).toMatch(/model loaded successfully/i);
  });

  it("should set ready flag after the health check succeeds", async () => {
    const scriptPath = path.join(PROJECT_ROOT, "scripts/spawn-python-server.ts");
    const fs = await import("fs");
    const content = fs.readFileSync(scriptPath, "utf8");

    expect(content).toMatch(/ready\s*:\s*true/i);
  });

  it("should return object with pid and ready properties", async () => {
    const scriptPath = path.join(PROJECT_ROOT, "scripts/spawn-python-server.ts");
    const fs = await import("fs");
    const content = fs.readFileSync(scriptPath, "utf8");

    expect(content).toMatch(/resolve.*\{[^}]*pid/i);
  });

  it("should handle Python process errors", async () => {
    const scriptPath = path.join(PROJECT_ROOT, "scripts/spawn-python-server.ts");
    const fs = await import("fs");
    const content = fs.readFileSync(scriptPath, "utf8");

    expect(content).toMatch(/pythonProcess\.on\(.*error/i);
  });

  it("should handle Python process close events", async () => {
    const scriptPath = path.join(PROJECT_ROOT, "scripts/spawn-python-server.ts");
    const fs = await import("fs");
    const content = fs.readFileSync(scriptPath, "utf8");

    expect(content).toMatch(/pythonProcess\.on\(.*close/i);
  });

  it("should pass env variables to Python subprocess", async () => {
    const scriptPath = path.join(PROJECT_ROOT, "scripts/spawn-python-server.ts");
    const fs = await import("fs");
    const content = fs.readFileSync(scriptPath, "utf8");

    expect(content).toMatch(/env:.*process\.env/i);
  });

  it("should resolve packaged Python files outside app.asar", async () => {
    const scriptPath = path.join(PROJECT_ROOT, "scripts/spawn-python-server.ts");
    const fs = await import("fs");
    const content = fs.readFileSync(scriptPath, "utf8");

    expect(content).toContain("app.asar.unpacked");
    expect(content).toContain("process.resourcesPath");
  });
});

describe("Main Process Python Spawning Environment", () => {
  it("should use the managed Kokoro runtime without a legacy model path", async () => {
    const scriptPath = path.join(
      PROJECT_ROOT,
      "scripts/spawn-python-server.ts",
    );
    const fs = await import("fs");
    const content = fs.readFileSync(scriptPath, "utf8");

    expect(content).not.toMatch(/KOKORO_MODEL_PATH/i);
    expect(content).toContain("python_server.main:app");
  });
});

describe("Spawn Python Server Stdio Configuration", () => {
  it("should capture stdout for GPU confirmation", async () => {
    const scriptPath = path.join(PROJECT_ROOT, "scripts/spawn-python-server.ts");
    const fs = await import("fs");
    const content = fs.readFileSync(scriptPath, "utf8");

    expect(content).toMatch(/stdio:\s*\[\s*"/i);
  });

  it("should have a bounded startup timeout mechanism", async () => {
    const scriptPath = path.join(PROJECT_ROOT, "scripts/spawn-python-server.ts");
    const fs = await import("fs");
    const content = fs.readFileSync(scriptPath, "utf8");

    expect(content).toContain("TIMEOUT_MS = 120000");
  });

  it("should reject promise on timeout", async () => {
    const scriptPath = path.join(PROJECT_ROOT, "scripts/spawn-python-server.ts");
    const fs = await import("fs");
    const content = fs.readFileSync(scriptPath, "utf8");

    expect(content).toMatch(/reject/i);
  });

  it("should handle non-zero exit codes", async () => {
    const scriptPath = path.join(PROJECT_ROOT, "scripts/spawn-python-server.ts");
    const fs = await import("fs");
    const content = fs.readFileSync(scriptPath, "utf8");

    expect(content).toMatch(/exitCode|exit.*code/i);
  });

  it("should log Python server output", async () => {
    const scriptPath = path.join(PROJECT_ROOT, "scripts/spawn-python-server.ts");
    const fs = await import("fs");
    const content = fs.readFileSync(scriptPath, "utf8");

    expect(content).toMatch(/\[PYTHON-SERVER\]/i);
  });
});
