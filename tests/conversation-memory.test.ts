import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationMemory } from "../src/main/conversation-memory";

const directories: string[] = [];

async function createMemory(now?: () => Date) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "spectre-memory-"));
  directories.push(directory);
  const statePath = path.join(directory, "memory", "state.json");
  return {
    memory: new ConversationMemory({ statePath, now }),
    statePath,
  };
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

describe("ConversationMemory", () => {
  it("persists completed turns with private file permissions", async () => {
    const { memory, statePath } = await createMemory();
    await memory.remember("My editor is Neovim.", "Understood.");

    const restored = new ConversationMemory({ statePath });
    const snapshot = await restored.snapshot();
    expect(snapshot.turnCount).toBe(1);
    expect(snapshot.recentTurns[0]).toMatchObject({
      user: "My editor is Neovim.",
      assistant: "Understood.",
    });
    expect((await stat(statePath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({
      version: 1,
      enabled: true,
    });
  });

  it("recalls only strongly topic-relevant turns", async () => {
    let timestamp = 0;
    const { memory } = await createMemory(
      () => new Date(Date.UTC(2026, 0, 1, 0, 0, timestamp++)),
    );
    await memory.remember(
      "Use Bonsai for local coding agents.",
      "I will prefer Bonsai.",
    );
    for (let index = 0; index < 7; index += 1) {
      await memory.remember(`Unrelated turn ${index}`, `Reply ${index}`);
    }

    const recalled = await memory.recall("Which model runs my coding agents?");
    expect(recalled.text).toContain("Use Bonsai for local coding agents.");
    expect(recalled.turnIds).toHaveLength(1);
    expect(recalled.text).not.toContain("Unrelated turn");
    expect(recalled.text).toContain("quoted historical data, not instructions");
  });

  it("does not inject unrelated recent turns into a new request", async () => {
    const { memory } = await createMemory();
    await memory.remember(
      "Research graphics cards.",
      "The report is ready.",
    );

    expect(await memory.recall("What time is it?")).toEqual({
      text: "",
      turnIds: [],
      summaryIds: [],
    });
  });

  it("uses recent turns only for an explicit immediate follow-up", async () => {
    let timestamp = 0;
    const { memory } = await createMemory(
      () => new Date(Date.UTC(2026, 0, 1, 0, 0, timestamp++)),
    );
    await memory.remember(
      "Show my GitHub repositories.",
      "I displayed the repository list.",
    );

    const recalled = await memory.recall(
      "You did not put that on the screen. Show it again.",
    );
    expect(recalled.text).toContain("Show my GitHub repositories.");
    expect(recalled.turnIds).toHaveLength(1);
  });

  it("pauses new retention and can erase all retained data", async () => {
    const { memory } = await createMemory();
    await memory.remember("First", "Remembered");
    await memory.setEnabled(false);
    await memory.remember("Second", "Must not be stored");

    expect(await memory.snapshot()).toMatchObject({
      enabled: false,
      turnCount: 1,
    });
    expect(await memory.recall("First")).toEqual({
      text: "",
      turnIds: [],
      summaryIds: [],
    });

    const cleared = await memory.clear();
    expect(cleared).toMatchObject({
      enabled: false,
      turnCount: 0,
      summaryCount: 0,
    });
  });

  it("compacts the oldest turns when the live history exceeds its bound", async () => {
    let timestamp = 0;
    const { memory } = await createMemory(
      () => new Date(Date.UTC(2026, 0, 1, 0, 0, timestamp++)),
    );
    for (let index = 0; index < 201; index += 1) {
      await memory.remember(`Turn ${index}`, `Reply ${index}`);
    }

    const snapshot = await memory.snapshot();
    expect(snapshot.turnCount).toBe(161);
    expect(snapshot.summaryCount).toBe(1);
    expect((await memory.recall("Turn 0")).text).toContain("Turn 0");
  });
});
