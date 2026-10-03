import { describe, expect, it, vi } from "vitest";
import { TextPresentationService } from "../src/main/text-presentation";

describe("TextPresentationService", () => {
  it("presents long informational text without requiring a response", () => {
    const emit = vi.fn();
    const service = new TextPresentationService();
    service.setEmitter(emit);

    const presentation = service.present({
      kind: "instructions",
      title: "Terminal commands",
      content: "npm install\nnpm test",
    });

    expect(presentation).toMatchObject({
      kind: "instructions",
      title: "Terminal commands",
      content: "npm install\nnpm test",
      requiresResponse: false,
    });
    expect(emit).toHaveBeenCalledWith(presentation);
  });

  it("waits for an explicit confirmation response", async () => {
    const service = new TextPresentationService();
    let presentationId = "";
    service.setEmitter((presentation) => {
      presentationId = presentation.id;
    });

    const confirmation = service.confirm({
      kind: "confirmation",
      title: "Create issue",
      content: "Repository: m00nk0d3/spectre",
      spokenHint: "I need your confirmation. The details are on screen.",
    });
    expect(service.respond(presentationId, true)).toBe(true);

    await expect(confirmation).resolves.toBe(true);
    expect(service.respond(presentationId, false)).toBe(false);
  });

  it("cancels pending confirmations when the presentation surface closes", async () => {
    const service = new TextPresentationService();
    service.setEmitter(() => undefined);
    const confirmation = service.confirm({
      title: "Delete branch",
      content: "Branch: old-work",
      spokenHint: "I need your confirmation.",
    });

    service.setEmitter(null);

    await expect(confirmation).resolves.toBe(false);
  });
});
