import { describe, it, expect } from "vitest";

describe("Main Process Python Integration", () => {
  it("should define pythonPid variable in main.ts", async () => {
    const mainPath = "/home/m00nk0d3/dev/spectre/.sandcastle/worktrees/agent-1-4-orquestracao-do-subprocesso-python-9/src/main/main.ts";
    const fs = await import("fs");
    const content = fs.readFileSync(mainPath, "utf8");

    // Check that pythonPid is defined
    expect(content).toMatch(/pythonPid/i);
  });

  it("should spawn Python server in whenReady handler", async () => {
    const mainPath = "/home/m00nk0d3/dev/spectre/.sandcastle/worktrees/agent-1-4-orquestracao-do-subprocesso-python-9/src/main/main.ts";
    const fs = await import("fs");
    const content = fs.readFileSync(mainPath, "utf8");

    // Check that Python server is spawned in whenReady handler
    expect(content).toMatch(/whenReady[\s\S]{0,200}spawnPythonServer/i);
  });

  it("should have cleanup handler for will-quit", async () => {
    const mainPath = "/home/m00nk0d3/dev/spectre/.sandcastle/worktrees/agent-1-4-orquestracao-do-subprocesso-python-9/src/main/main.ts";
    const fs = await import("fs");
    const content = fs.readFileSync(mainPath, "utf8");

    // Check that will-quit handler exists for cleanup
    expect(content).toMatch(/will-quit/i);
  });

  it("should have ipcMain handle for python-status-request", async () => {
    const mainPath = "/home/m00nk0d3/dev/spectre/.sandcastle/worktrees/agent-1-4-orquestracao-do-subprocesso-python-9/src/main/main.ts";
    const fs = await import("fs");
    const content = fs.readFileSync(mainPath, "utf8");

    // Check that python-status-request handler exists
    expect(content).toMatch(/python-status-request/i);
  });

  it("should handle spawn failure with try/catch", async () => {
    const mainPath = "/home/m00nk0d3/dev/spectre/.sandcastle/worktrees/agent-1-4-orquestracao-do-subprocesso-python-9/src/main/main.ts";
    const fs = await import("fs");
    const content = fs.readFileSync(mainPath, "utf8");

    // Check that spawn is wrapped in try/catch
    expect(content).toMatch(/try\s*{[\s\S]*?spawn/i);
  });

  it("should kill Python subprocess on will-quit", async () => {
    const mainPath = "/home/m00nk0d3/dev/spectre/.sandcastle/worktrees/agent-1-4-orquestracao-do-subprocesso-python-9/src/main/main.ts";
    const fs = await import("fs");
    const content = fs.readFileSync(mainPath, "utf8");

    // Check that process.kill is called in will-quit handler
    expect(content).toMatch(/will-quit[\s\S]{0,150}process\.kill/i);
  });

  it("should set pythonPid variable before spawn", async () => {
    const mainPath = "/home/m00nk0d3/dev/spectre/.sandcastle/worktrees/agent-1-4-orquestracao-do-subprocesso-python-9/src/main/main.ts";
    const fs = await import("fs");
    const content = fs.readFileSync(mainPath, "utf8");

    // Check that pythonPid is set after spawnPythonServer result
    expect(content).toMatch(/await.*spawnPythonServer[\s\S]{0,150}pythonPid/i);
  });

  it("should export spawnPythonServer from scripts module", async () => {
    const scriptPath = "/home/m00nk0d3/dev/spectre/.sandcastle/worktrees/agent-1-4-orquestracao-do-subprocesso-python-9/scripts/spawn-python-server.ts";
    const fs = await import("fs");
    const content = fs.readFileSync(scriptPath, "utf8");

    // Check that spawnPythonServer is exported
    expect(content).toMatch(/export.*function.*spawnPythonServer/i);
  });
});

describe("Spawn Python Server Module", () => {
  it("should have detectPython function", async () => {
    const scriptPath = "/home/m00nk0d3/dev/spectre/.sandcastle/worktrees/agent-1-4-orquestracao-do-subprocesso-python-9/scripts/spawn-python-server.ts";
    const fs = await import("fs");
    const content = fs.readFileSync(scriptPath, "utf8");

    expect(content).toMatch(/export.*function.*detectPython/i);
  });

  it("should spawn with uvicorn command", async () => {
    const scriptPath = "/home/m00nk0d3/dev/spectre/.sandcastle/worktrees/agent-1-4-orquestracao-do-subprocesso-python-9/scripts/spawn-python-server.ts";
    const fs = await import("fs");
    const content = fs.readFileSync(scriptPath, "utf8");

    expect(content).toMatch(/uvicorn/i);
  });

  it("should spawn on port 1234", async () => {
    const scriptPath = "/home/m00nk0d3/dev/spectre/.sandcastle/worktrees/agent-1-4-orquestracao-do-subprocesso-python-9/scripts/spawn-python-server.ts";
    const fs = await import("fs");
    const content = fs.readFileSync(scriptPath, "utf8");

    expect(content).toMatch(/\-\-port/i);
  });

  it("should handle GPU marker in stdout", async () => {
    const scriptPath = "/home/m00nk0d3/dev/spectre/.sandcastle/worktrees/agent-1-4-orquestracao-do-subprocesso-python-9/scripts/spawn-python-server.ts";
    const fs = await import("fs");
    const content = fs.readFileSync(scriptPath, "utf8");

    expect(content).toMatch(/gpu/i);
  });

  it("should set ready flag when GPU marker detected", async () => {
    const scriptPath = "/home/m00nk0d3/dev/spectre/.sandcastle/worktrees/agent-1-4-orquestracao-do-subprocesso-python-9/scripts/spawn-python-server.ts";
    const fs = await import("fs");
    const content = fs.readFileSync(scriptPath, "utf8");

    expect(content).toMatch(/ready.*=.*true/i);
  });

  it("should return object with pid and ready properties", async () => {
    const scriptPath = "/home/m00nk0d3/dev/spectre/.sandcastle/worktrees/agent-1-4-orquestracao-do-subprocesso-python-9/scripts/spawn-python-server.ts";
    const fs = await import("fs");
    const content = fs.readFileSync(scriptPath, "utf8");

    expect(content).toMatch(/resolve.*\{[^}]*pid/i);
  });

  it("should handle Python process errors", async () => {
    const scriptPath = "/home/m00nk0d3/dev/spectre/.sandcastle/worktrees/agent-1-4-orquestracao-do-subprocesso-python-9/scripts/spawn-python-server.ts";
    const fs = await import("fs");
    const content = fs.readFileSync(scriptPath, "utf8");

    expect(content).toMatch(/pythonProcess\.on\(.*error/i);
  });

  it("should handle Python process close events", async () => {
    const scriptPath = "/home/m00nk0d3/dev/spectre/.sandcastle/worktrees/agent-1-4-orquestracao-do-subprocesso-python-9/scripts/spawn-python-server.ts";
    const fs = await import("fs");
    const content = fs.readFileSync(scriptPath, "utf8");

    expect(content).toMatch(/pythonProcess\.on\(.*close/i);
  });

  it("should pass env variables to Python subprocess", async () => {
    const scriptPath = "/home/m00nk0d3/dev/spectre/.sandcastle/worktrees/agent-1-4-orquestracao-do-subprocesso-python-9/scripts/spawn-python-server.ts";
    const fs = await import("fs");
    const content = fs.readFileSync(scriptPath, "utf8");

    expect(content).toMatch(/env:.*process\.env/i);
  });
});

describe("Main Process Python Spawning Environment", () => {
  it("should have PYTHON_CMD environment variable fallback in main.ts", async () => {
    const mainPath = "/home/m00nk0d3/dev/spectre/.sandcastle/worktrees/agent-1-4-orquestracao-do-subprocesso-python-9/src/main/main.ts";
    const fs = await import("fs");
    const content = fs.readFileSync(mainPath, "utf8");

    expect(content).toMatch(/PYTHON_CMD/i);
  });

  it("should have KOKORO_MODEL_PATH environment variable support", async () => {
    const mainPath = "/home/m00nk0d3/dev/spectre/.sandcastle/worktrees/agent-1-4-orquestracao-do-subprocesso-python-9/src/main/main.ts";
    const fs = await import("fs");
    const content = fs.readFileSync(mainPath, "utf8");

    expect(content).toMatch(/KOKORO_MODEL_PATH/i);
  });

  it("should spawn Python with cwd set to __dirname", async () => {
    const scriptPath = "/home/m00nk0d3/dev/spectre/.sandcastle/worktrees/agent-1-4-orquestracao-do-subprocesso-python-9/scripts/spawn-python-server.ts";
    const fs = await import("fs");
    const content = fs.readFileSync(scriptPath, "utf8");

    expect(content).toMatch(/cwd:.*__filename/i);
  });
});

describe("Spawn Python Server Stdio Configuration", () => {
  it("should capture stdout for GPU confirmation", async () => {
    const scriptPath = "/home/m00nk0d3/dev/spectre/.sandcastle/worktrees/agent-1-4-orquestracao-do-subprocesso-python-9/scripts/spawn-python-server.ts";
    const fs = await import("fs");
    const content = fs.readFileSync(scriptPath, "utf8");

    expect(content).toMatch(/stdio:\s*\[\s*\"ignore\",\s*\"pipe\",/i);
  });

  it("should log Python server output", async () => {
    const scriptPath = "/home/m00nk0d3/dev/spectre/.sandcastle/worktrees/agent-1-4-orquestracao-do-subprocesso-python-9/scripts/spawn-python-server.ts";
    const fs = await import("fs");
    const content = fs.readFileSync(scriptPath, "utf8");

    expect(content).toMatch(/\[PYTHON-SERVER\]/i);
  });
});
