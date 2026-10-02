import { afterEach, describe, expect, it, vi } from "vitest";
import {
  executeSpectreTool,
  SPECTRE_TOOLS,
} from "../src/main/spectre-tools";

afterEach(() => {
  vi.useRealTimers();
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

  it("publishes only the supported read-only tools", () => {
    expect(
      SPECTRE_TOOLS.map((tool) => tool.function.name),
    ).toEqual([
      "get_current_datetime",
      "get_system_status",
      "search_obsidian_vault",
      "read_obsidian_note",
      "append_obsidian_note",
    ]);
  });
});
