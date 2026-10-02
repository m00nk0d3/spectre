import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Kokoro Brazilian Portuguese defaults", () => {
  const server = readFileSync(
    path.join(process.cwd(), "src/main/python_server/main.py"),
    "utf8",
  );

  it("uses Portuguese language code p", () => {
    expect(server).toContain('os.environ.get("KOKORO_LANG_CODE", "p")');
    expect(server).toContain("KPipeline(lang_code=LANG_CODE");
  });

  it("uses pf_dora as the default voice", () => {
    expect(server).toContain('os.environ.get("TTS_VOICE", "pf_dora")');
  });
});
