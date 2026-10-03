import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  shouldPresentInEditor,
  TextPresenter,
} from "../src/main/text-presenter";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

describe("TextPresenter", () => {
  it("opens a private Markdown file read-only in Neovim", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "spectre-presenter-"),
    );
    temporaryDirectories.push(directory);
    const runner = vi.fn(async (_command: string, args: string[]) => {
      if (args[0] === "pane" && args[1] === "split") {
        return JSON.stringify({
          result: { pane: { pane_id: "w1:p2" } },
        });
      }
      if (args[0] === "pane" && args[1] === "run") {
        return JSON.stringify({ result: { accepted: true } });
      }
      throw new Error(`Unexpected args: ${args.join(" ")}`);
    });
    const presenter = new TextPresenter({
      directory,
      runner,
      env: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" },
    });

    const result = await presenter.present("Research results", "Large report");

    expect(result.paneId).toBe("w1:p2");
    expect(await readFile(result.path, "utf8")).toBe(
      "# Research results\n\nLarge report\n",
    );
    expect((await stat(result.path)).mode & 0o777).toBe(0o600);
    expect(runner).toHaveBeenNthCalledWith(1, "herdr", [
      "pane",
      "split",
      "--current",
      "--direction",
      "right",
      "--cwd",
      directory,
      "--no-focus",
    ]);
    expect(runner.mock.calls[1][1]).toEqual([
      "pane",
      "run",
      "w1:p2",
      expect.stringMatching(/^exec nvim -R -M -- '/),
    ]);
  });

  it("detects explicit editor presentation requests", () => {
    expect(shouldPresentInEditor("Show the report in Neovim")).toBe(true);
    expect(shouldPresentInEditor("Open this in a new Herdr pane")).toBe(true);
    expect(shouldPresentInEditor("Tell me the result briefly")).toBe(false);
  });
});
