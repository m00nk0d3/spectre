import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Kokoro US English defaults", () => {
  const server = readFileSync(
    path.join(process.cwd(), "src/main/python_server/main.py"),
    "utf8",
  );

  it("uses American English language code a", () => {
    expect(server).toContain('os.environ.get("KOKORO_LANG_CODE", "a")');
    expect(server).toContain("KPipeline(lang_code=LANG_CODE");
  });

  it("uses am_michael as the default male voice", () => {
    expect(server).toContain('os.environ.get("TTS_VOICE", "am_michael")');
  });
});
