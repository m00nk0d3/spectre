import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Whisper large-v3-turbo defaults", () => {
  const server = readFileSync(
    path.join(process.cwd(), "src/main/python_server/main.py"),
    "utf8",
  );
  const setup = readFileSync(
    path.join(process.cwd(), "scripts/setup-whisper-runtime.mjs"),
    "utf8",
  );
  const legacyClient = readFileSync(
    path.join(process.cwd(), "src/main/whisper.ts"),
    "utf8",
  );

  it("uses the CTranslate2 large-v3-turbo model by default", () => {
    expect(server).toContain(
      "dropbox-dash/faster-whisper-large-v3-turbo",
    );
    expect(setup).toContain(
      "dropbox-dash/faster-whisper-large-v3-turbo",
    );
  });

  it("prefers GPU int8 and exposes an explicit CPU fallback", () => {
    expect(server).toContain('"int8_float16" if whisper_device == "cuda"');
    expect(server).toContain("falling back to CPU int8");
    expect(server).toContain('whisper_device = "cpu"');
    expect(server).toContain('whisper_compute_type = "int8"');
  });

  it("keeps the whisper.cpp fallback on the turbo model", () => {
    expect(setup).toContain("ggml-large-v3-turbo.bin");
    expect(legacyClient).toContain("ggml-large-v3-turbo.bin");
  });
});
