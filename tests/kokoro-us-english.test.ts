import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Kokoro US English defaults", () => {
  const server = readFileSync(
    path.join(process.cwd(), "src/main/python_server/main.py"),
    "utf8",
  );
  const client = readFileSync(
    path.join(process.cwd(), "src/main/kokoro-client.ts"),
    "utf8",
  );

  it("transcribes and synthesizes US English", () => {
    expect(server).toContain(
      'LANG_CODE = os.environ.get("KOKORO_LANG_CODE", "a")',
    );
    expect(server).toContain('"language": "en-US"');
    expect(server).toContain('language="en"');
    expect(server).toContain("Accurate US English transcription");
  });

  it("uses the selected male Kokoro voice and speed", () => {
    expect(server).toContain(
      'DEFAULT_VOICE = os.environ.get("TTS_VOICE", "am_michael")',
    );
    expect(client).toContain('process.env.TTS_VOICE || "am_michael"');
    expect(client).toContain("Number(process.env.TTS_SPEED) || 1.1");
  });

  it("serializes synthesis through the shared local model", () => {
    expect(server).toContain("tts_lock = asyncio.Lock()");
    expect(server).toContain("async with tts_lock");
  });
});
