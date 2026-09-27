import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import path from "path";

const PROJECT_ROOT = process.cwd();

describe("Issue #15: Injeção de Persona e Restrições de Idioma", () => {
  const mainPath = path.join(PROJECT_ROOT, "src/main/main.ts");

  // AC-01: Restrição Linguística Absoluta - 100% Português nas respostas
  it("AC-01: should import CONTEXT_MESSAGES from @/ai/messages/context", () => {
    if (!existsSync(mainPath)) {
      throw new Error("src/main/main.ts not found");
    }

    const content = readFileSync(mainPath, "utf8");

    // ACCEPTANCE CRITERIA AC-01: System prompt must be imported and initialized
    // Should import CONTEXT_MESSAGES to inject persona constraints into AI client
    expect(content).toMatch(/import.*CONTEXT_MESSAGES/i);
  });

  it("AC-01: should initialize AI context messages in app.whenReady()", () => {
    if (!existsSync(mainPath)) {
      throw new Error("src/main/main.ts not found");
    }

    const content = readFileSync(mainPath, "utf8");

    // ACCEPTANCE CRITERIA AC-01: Context messages initialized before Python server spawn
    expect(content).toMatch(/\[AI-COMMUNICATIONS\].*Context messages initialized/i);
  });

  it("AC-01: System prompt should contain strict Portuguese language requirement", () => {
    if (!existsSync(mainPath)) {
      throw new Error("src/main/main.ts not found");
    }

    const content = readFileSync(mainPath, "utf8");

    // ACCEPTANCE CRITERIA AC-01: System prompt must require 100% Portuguese
    expect(content).toMatch(/IDIOMA ESTRITO|Português/i);
  });

  // AC-02: Sem Formatação Markdown - Zero Markdown for TTS natural synthesis
  it("AC-02: System prompt should contain zero markdown formatting prohibition", () => {
    if (!existsSync(mainPath)) {
      throw new Error("src/main/main.ts not found");
    }

    const content = readFileSync(mainPath, "utf8");

    // ACCEPTANCE CRITERIA AC-02: System prompt must prohibit Markdown (asterisks, hashtags, lists)
    expect(content).toMatch(/FORMATAÇÃO ZERO|Markdown|não use/i);
  });

  it("AC-02: System prompt should require plain text for TTS", () => {
    if (!existsSync(mainPath)) {
      throw new Error("src/main/main.ts not found");
    }

    const content = readFileSync(mainPath, "utf8");

    // ACCEPTANCE CRITERIA AC-02: Response must be plain text without formatting elements
    expect(content).toMatch(/texto puro|plain.*text|síntese de voz/i);
  });

  // AC-03: Persona "Amigo Profissional" - Friendly but professional tone
  it("AC-03: System prompt should define friendly-professional persona", () => {
    if (!existsSync(mainPath)) {
      throw new Error("src/main/main.ts not found");
    }

    const content = readFileSync(mainPath, "utf8");

    // ACCEPTANCE CRITERIA AC-03: System prompt must define friendly-but-professional tone
    expect(content).toMatch(/PERSONA AMIGO-PROFISIONAL|amigo.*profissional/i);
  });

  it("AC-03: System prompt should encourage informal humor with professional respect", () => {
    if (!existsSync(mainPath)) {
      throw new Error("src/main/main.ts not found");
    }

    const content = readFileSync(mainPath, "utf8");

    // ACCEPTANCE CRITERIA AC-03: Balance between friendly informal tone and professional respect
    expect(content).toMatch(/bom senso de humor|humor/i);
  });

  it("AC-03: System prompt should avoid robotic language", () => {
    if (!existsSync(mainPath)) {
      throw new Error("src/main/main.ts not found");
    }

    const content = readFileSync(mainPath, "utf8");

    // ACCEPTANCE CRITERIA AC-03: Response must be conversational, not robotic
    expect(content).toMatch(/conversacional|não seja robótico/i);
  });
});
