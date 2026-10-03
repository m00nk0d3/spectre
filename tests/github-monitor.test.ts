import {
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractNotModifiedOutput,
  GitHubMonitor,
  type GitHubCommandRunner,
} from "../src/main/github-monitor";

const temporaryDirectories: string[] = [];

async function statePath(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "spectre-gh-monitor-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "state.json");
}

function pullRequest(options: {
  number?: number;
  title?: string;
  state?: string;
  draft?: boolean;
  updatedAt?: string;
  sha?: string;
  requestedReviewers?: string[];
} = {}) {
  const number = options.number ?? 42;
  return {
    number,
    title: options.title ?? "Add GitHub monitor",
    html_url: `https://github.com/m00nk0d3/spectre/pull/${number}`,
    state: options.state ?? "open",
    draft: options.draft ?? true,
    updated_at: options.updatedAt ?? "2026-10-03T00:00:00Z",
    user: { login: "contributor" },
    head: { sha: options.sha ?? "abc123" },
    requested_reviewers: (options.requestedReviewers ?? []).map(
      (login) => ({ login }),
    ),
  };
}

function included(
  status: number,
  etag: string,
  body = "",
): string {
  return [
    `HTTP/2.0 ${status} ${status === 200 ? "OK" : "Not Modified"}`,
    `etag: ${etag}`,
    "content-type: application/json",
    "",
    body,
  ].join("\n");
}

function runnerWithPullResponses(
  responses: string[],
): GitHubCommandRunner {
  let pullIndex = 0;
  return vi.fn(async (_command, args) => {
    if (args[0] === "api" && args[1] === "user") return "m00nk0d3\n";
    if (args[0] === "repo" && args[1] === "list") {
      return JSON.stringify([{
        nameWithOwner: "m00nk0d3/spectre",
        isArchived: false,
        url: "https://github.com/m00nk0d3/spectre",
      }]);
    }
    if (args[0] === "api" && args.includes("--include")) {
      const response = responses[pullIndex];
      pullIndex += 1;
      if (!response) throw new Error("missing fake pull response");
      return response;
    }
    throw new Error(`unexpected gh arguments: ${args.join(" ")}`);
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("GitHubMonitor", () => {
  it("recovers the included response when gh exits nonzero for HTTP 304", () => {
    const output = included(304, '"repo-v1"');
    expect(extractNotModifiedOutput({
      code: 1,
      stdout: output,
      stderr: "gh: HTTP 304\n",
    })).toBe(output);
    expect(extractNotModifiedOutput({
      code: 1,
      stdout: included(403, '"repo-v1"'),
      stderr: "gh: HTTP 403\n",
    })).toBeNull();
  });

  it("establishes a silent baseline and persists repository ETags", async () => {
    const destination = await statePath();
    const runner = runnerWithPullResponses([
      included(200, '"repo-v1"', JSON.stringify([pullRequest()])),
    ]);
    const monitor = new GitHubMonitor({
      statePath: destination,
      runner,
      now: () => new Date("2026-10-03T00:00:00.000Z"),
    });

    await monitor.poll();

    expect(monitor.getSnapshot()).toMatchObject({
      status: "ready",
      account: "m00nk0d3",
      repositoryCount: 1,
      events: [],
    });
    const stored = await readFile(destination, "utf8");
    expect(stored).toContain('"etag": "\\"repo-v1\\""');
    expect(stored).toContain('"initialized": true');
  });

  it("detects new commits after baseline and includes the ETag cursor", async () => {
    const destination = await statePath();
    const runner = runnerWithPullResponses([
      included(200, '"repo-v1"', JSON.stringify([pullRequest()])),
      included(200, '"repo-v2"', JSON.stringify([
        pullRequest({
          updatedAt: "2026-10-03T00:01:00Z",
          sha: "def456",
        }),
      ])),
    ]);
    const monitor = new GitHubMonitor({
      statePath: destination,
      runner,
      now: () => new Date("2026-10-03T00:02:00.000Z"),
    });

    const events: string[] = [];
    monitor.onEvent((event) => events.push(event.kind));

    await monitor.poll();
    await monitor.poll();

    expect(events).toEqual(["synchronized"]);
    expect(monitor.getSnapshot().events[0]).toMatchObject({
      kind: "synchronized",
      repository: "m00nk0d3/spectre",
      number: 42,
      headSha: "def456",
    });
    expect(runner).toHaveBeenLastCalledWith(
      "gh",
      expect.arrayContaining(["If-None-Match: \"repo-v1\""]),
    );
  });

  it("emits a review request when the active account is newly requested", async () => {
    const destination = await statePath();
    const runner = runnerWithPullResponses([
      included(200, '"repo-v1"', JSON.stringify([pullRequest()])),
      included(200, '"repo-v2"', JSON.stringify([
        pullRequest({
          updatedAt: "2026-10-03T00:01:00Z",
          requestedReviewers: ["m00nk0d3"],
        }),
      ])),
    ]);
    const monitor = new GitHubMonitor({
      statePath: destination,
      runner,
    });
    const listener = vi.fn();
    monitor.onEvent(listener);

    await monitor.poll();
    await monitor.poll();

    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      kind: "review_requested",
      repository: "m00nk0d3/spectre",
      number: 42,
    }));
  });

  it("does not emit duplicate events for a 304 response", async () => {
    const destination = await statePath();
    const runner = runnerWithPullResponses([
      included(200, '"repo-v1"', JSON.stringify([pullRequest()])),
      included(304, '"repo-v1"'),
    ]);
    const monitor = new GitHubMonitor({
      statePath: destination,
      runner,
    });
    const listener = vi.fn();
    monitor.onEvent(listener);

    await monitor.poll();
    await monitor.poll();

    expect(listener).not.toHaveBeenCalled();
    expect(monitor.getSnapshot().events).toEqual([]);
  });

  it("reports authentication failures through monitor status", async () => {
    const destination = await statePath();
    const monitor = new GitHubMonitor({
      statePath: destination,
      runner: async () => {
        throw new Error("gh auth login is required");
      },
    });

    await expect(monitor.poll()).rejects.toThrow("gh auth login is required");
    expect(monitor.getSnapshot()).toMatchObject({
      status: "error",
      error: "gh auth login is required",
    });
  });
});
