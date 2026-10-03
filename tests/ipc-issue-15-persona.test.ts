import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import path from "path";

const PROJECT_ROOT = process.cwd();

describe("Issue #15: Persona and language constraints", () => {
  const mainPath = path.join(PROJECT_ROOT, "src/main/main.ts");
  const contextPath = path.join(
    PROJECT_ROOT,
    "src/ai/messages/context.ts",
  );
  const readSystemPrompt = () => readFileSync(contextPath, "utf8");

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

  it("AC-01: System prompt should require English", () => {
    if (!existsSync(mainPath)) {
      throw new Error("src/main/main.ts not found");
    }

    const content = readSystemPrompt();

    expect(content).toMatch(/ENGLISH ONLY/i);
    expect(content).toMatch(/natural, concise English/i);
    expect(content).toMatch(/American conversational tone/i);
  });

  it("AC-02: System prompt should contain zero markdown formatting prohibition", () => {
    if (!existsSync(mainPath)) {
      throw new Error("src/main/main.ts not found");
    }

    const content = readSystemPrompt();

    // ACCEPTANCE CRITERIA AC-02: System prompt must prohibit Markdown (asterisks, hashtags, lists)
    expect(content).toMatch(/ZERO MARKDOWN|Markdown/i);
  });

  it("AC-02: System prompt should require plain text for TTS", () => {
    if (!existsSync(mainPath)) {
      throw new Error("src/main/main.ts not found");
    }

    const content = readSystemPrompt();

    // ACCEPTANCE CRITERIA AC-02: Response must be plain text without formatting elements
    expect(content).toMatch(/plain.*text|speech/i);
  });

  it("AC-03: System prompt should define the close-friend persona", () => {
    if (!existsSync(mainPath)) {
      throw new Error("src/main/main.ts not found");
    }

    const content = readSystemPrompt();

    // ACCEPTANCE CRITERIA AC-03: System prompt must define friendly-but-professional tone
    expect(content).toMatch(/CLOSE FRIEND PERSONA/i);
  });

  it("AC-03: System prompt should allow informal humor and language", () => {
    if (!existsSync(mainPath)) {
      throw new Error("src/main/main.ts not found");
    }

    const content = readSystemPrompt();

    // ACCEPTANCE CRITERIA AC-03: Balance between friendly informal tone and professional respect
    expect(content).toMatch(/visible playful energy/i);
    expect(content).toMatch(/Do not default to a flat neutral response/i);
    expect(content).toMatch(/Crack short jokes/i);
    expect(content).toMatch(/brief friendly roast/i);
    expect(content).toMatch(/Actively notice roast opportunities/i);
    expect(content).toMatch(/instead of waiting for the user to request one/i);
    expect(content).toMatch(/repeated pivots, overengineering/i);
    expect(content).toMatch(/one spontaneous affectionate jab/i);
    expect(content).toMatch(/explicitly asks to be roasted/i);
    expect(content).toMatch(/immediately give one or two concise playful roasts/i);
    expect(content).toMatch(/Never say the roast engine is idling/i);
    expect(content).toMatch(/Never explain persona policy/i);
    expect(content).toMatch(/classify the conversation as low-stakes/i);
    expect(content).toMatch(/Do not invent a mistake or personal detail/i);
    expect(content).toMatch(/Profanity is allowed but should remain occasional/i);
    expect(content).toMatch(/instead of replying like a therapist/i);
    expect(content).toMatch(/hard limit of two short sentences/i);
    expect(content).toMatch(/Never repeat a recent response verbatim/i);
    expect(content).toMatch(/drop the jokes when they would make the moment worse/i);
    expect(content).toContain("Yeah, man. What are we getting ourselves into?");
    expect(content).toMatch(/"man", "dude", or "bro"/i);
  });

  it("AC-03: System prompt should keep task execution professional", () => {
    const content = readSystemPrompt();

    expect(content).toMatch(/PROFESSIONAL EXECUTION/i);
    expect(content).toMatch(/conversational layer/i);
    expect(content).toMatch(/Never call the user "sir"/i);
  });

  it("AC-03: System prompt should avoid robotic language", () => {
    if (!existsSync(mainPath)) {
      throw new Error("src/main/main.ts not found");
    }

    const content = readSystemPrompt();

    // ACCEPTANCE CRITERIA AC-03: Response must be conversational, not robotic
    expect(content).toMatch(/conversational|not robotic/i);
  });
});
