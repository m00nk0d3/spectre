import { afterEach, describe, expect, it, vi } from "vitest";
import {
  executeSpectreTool,
  SPECTRE_TOOLS,
} from "../src/main/spectre-tools";
import { webResearchService } from "../src/main/web-research";
import { githubService } from "../src/main/github-service";
import { textPresentationService } from "../src/main/text-presentation";
import { systemService } from "../src/main/system-service";

afterEach(() => {
  textPresentationService.setEmitter(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Spectre tools", () => {
  it("returns the current date and time in the requested time zone", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-02T18:30:00.000Z"));

    const result = JSON.parse(
      await executeSpectreTool(
        "get_current_datetime",
        JSON.stringify({ timezone: "America/New_York" }),
      ),
    ) as Record<string, unknown>;

    expect(result).toEqual({
      localDateTime: "Friday, October 2, 2026 at 2:30:00 PM EDT",
      timezone: "America/New_York",
      utc: "2026-10-02T18:30:00.000Z",
    });
  });

  it("returns read-only local system status", async () => {
    const result = JSON.parse(
      await executeSpectreTool("get_system_status", "{}"),
    ) as Record<string, unknown>;

    expect(result).toMatchObject({
      platform: expect.any(String),
      architecture: expect.any(String),
      uptimeSeconds: expect.any(Number),
      memory: {
        totalGiB: expect.any(Number),
        availableGiB: expect.any(Number),
      },
      loadAverage: expect.any(Array),
    });
  });

  it("rejects invalid arguments and unknown tools", async () => {
    await expect(
      executeSpectreTool("get_current_datetime", '{"timezone":42}'),
    ).rejects.toThrow("timezone must be a string");
    await expect(
      executeSpectreTool("get_current_datetime", '{"timezone":"Moon/Base"}'),
    ).rejects.toThrow("Invalid IANA time zone");
    await expect(
      executeSpectreTool("launch_missiles", "{}"),
    ).rejects.toThrow("Unknown Spectre tool");
  });

  it("runs constrained public web research tools", async () => {
    const research = vi.spyOn(webResearchService, "research")
      .mockResolvedValue({
        query: "TypeScript 7",
        readableSourceCount: 1,
        sources: [{
          title: "TypeScript 7",
          url: "https://example.com/typescript-7",
          content: "Release details",
        }],
      });

    const fetchPage = vi.spyOn(webResearchService, "fetchPage")
      .mockResolvedValue({
        title: "Example",
        url: "https://example.com/",
        content: "Public page",
      });

    expect(JSON.parse(
      await executeSpectreTool(
        "research_web",
        '{"query":"TypeScript 7","limit":2}',
      ),
    )).toMatchObject({ query: "TypeScript 7" });
    expect(JSON.parse(
      await executeSpectreTool(
        "fetch_web_page",
        '{"url":"https://example.com/"}',
      ),
    )).toMatchObject({ title: "Example" });
    expect(research).toHaveBeenCalledWith("TypeScript 7", 2);
    expect(fetchPage).toHaveBeenCalledWith("https://example.com/");
  });

  it("runs typed GitHub reads and confirmed writes", async () => {
    const read = vi.spyOn(githubService, "read")
      .mockResolvedValue([{ number: 42, title: "Memory" }]);
    const write = vi.spyOn(githubService, "write")
      .mockResolvedValue({
        output: "https://github.com/m00nk0d3/spectre/issues/50",
      });

    expect(JSON.parse(await executeSpectreTool(
      "github_read",
      JSON.stringify({
        operation: "list_issues",
        repository: "m00nk0d3/spectre",
        payload: '{"state":"open","limit":10}',
      }),
    ))).toEqual([{ number: 42, title: "Memory" }]);
    expect(JSON.parse(await executeSpectreTool(
      "github_write",
      JSON.stringify({
        operation: "issue_create",
        repository: "m00nk0d3/spectre",
        payload: '{"title":"Add automation","body":"Details"}',
      }),
    ))).toMatchObject({
      output: expect.stringContaining("/issues/50"),
    });
    expect(read).toHaveBeenCalledWith(
      "list_issues",
      "m00nk0d3/spectre",
      { state: "open", limit: 10 },
    );
    expect(write).toHaveBeenCalledWith(
      "issue_create",
      "m00nk0d3/spectre",
      { title: "Add automation", body: "Details" },
    );
  });

  it("shows long instructions in the in-app text presentation", async () => {
    const emit = vi.fn();
    textPresentationService.setEmitter(emit);

    expect(JSON.parse(await executeSpectreTool(
      "present_text",
      JSON.stringify({
        title: "Terminal commands",
        content: "npm install\nnpm test",
        kind: "instructions",
      }),
    ))).toMatchObject({ displayed: true });
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      title: "Terminal commands",
      content: "npm install\nnpm test",
      kind: "instructions",
      requiresResponse: false,
    }));

    textPresentationService.setEmitter(null);
  });

  it("runs typed system reads and confirmed writes", async () => {
    const read = vi.spyOn(systemService, "read")
      .mockResolvedValue([{ name: "dev", type: "directory" }]);
    const write = vi.spyOn(systemService, "write")
      .mockResolvedValue({ success: true, operation: "create_directory" });

    expect(JSON.parse(await executeSpectreTool(
      "system_read",
      JSON.stringify({
        operation: "list_directory",
        payload: '{"path":"~"}',
      }),
    ))).toEqual([{ name: "dev", type: "directory" }]);
    expect(JSON.parse(await executeSpectreTool(
      "system_write",
      JSON.stringify({
        operation: "create_directory",
        payload: '{"path":"~/example"}',
      }),
    ))).toMatchObject({ success: true });
    expect(read).toHaveBeenCalledWith("list_directory", { path: "~" });
    expect(write).toHaveBeenCalledWith("create_directory", {
      path: "~/example",
    });
  });

  it("publishes the supported local and reviewed workflow tools", () => {
    expect(
      SPECTRE_TOOLS.map((tool) => tool.function.name),
    ).toEqual([
      "get_current_datetime",
      "get_system_status",
      "search_obsidian_vault",
      "read_obsidian_note",
      "append_obsidian_note",
      "list_projects",
      "list_sandcastle_workflows",
      "prepare_sandcastle_issue_workflow",
      "get_github_activity",
      "github_read",
      "github_write",
      "system_read",
      "system_write",
      "present_text",
      "research_web",
      "fetch_web_page",
    ]);
  });
});
