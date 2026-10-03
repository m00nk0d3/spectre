import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GitHubService,
  type GitHubWritePlan,
} from "../src/main/github-service";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })),
  );
});

function runner(
  handler: (args: string[]) => string | Promise<string>,
) {
  return vi.fn(async (command: string, args: string[]) => {
    expect(command).toBe("gh");
    if (args.join(" ") === "api user --jq .login") return "m00nk0d3\n";
    return handler(args);
  });
}

describe("GitHubService", () => {
  it("searches the active user's assigned issues across owned repositories", async () => {
    const run = runner((args) => {
      expect(args).toEqual([
        "search",
        "issues",
        "--owner",
        "m00nk0d3",
        "--assignee",
        "m00nk0d3",
        "--state",
        "open",
        "--limit",
        "25",
        "--json",
        "number,title,state,author,assignees,labels,repository,updatedAt,url",
      ]);
      return '[{"number":42,"title":"Memory"}]';
    });
    const service = new GitHubService({ runner: run });

    await expect(service.read(
      "search_issues",
      undefined,
      { state: "open", limit: 25 },
    )).resolves.toEqual([{ number: 42, title: "Memory" }]);
  });

  it("reads owned repository issues without confirmation", async () => {
    const run = runner((args) => {
      expect(args).toEqual([
        "issue",
        "list",
        "--repo",
        "m00nk0d3/spectre",
        "--state",
        "open",
        "--limit",
        "10",
        "--json",
        "number,title,state,author,assignees,labels,createdAt,updatedAt,url",
      ]);
      return '[{"number":42,"title":"Memory"}]';
    });
    const confirm = vi.fn();
    const service = new GitHubService({ runner: run, confirm });

    await expect(service.read(
      "list_issues",
      "spectre",
      { state: "open", limit: 10 },
    )).resolves.toEqual([{ number: 42, title: "Memory" }]);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("confirms and creates an issue with typed arguments", async () => {
    const run = runner((args) => {
      expect(args).toEqual([
        "issue",
        "create",
        "--repo",
        "m00nk0d3/spectre",
        "--title",
        "Add automation",
        "--body",
        "Implement the approved workflow.",
        "--label",
        "enhancement",
        "--assignee",
        "m00nk0d3",
      ]);
      return "https://github.com/m00nk0d3/spectre/issues/50\n";
    });
    const plans: GitHubWritePlan[] = [];
    const service = new GitHubService({
      runner: run,
      confirm: async (plan) => {
        plans.push(plan);
        return true;
      },
    });

    await expect(service.write(
      "issue_create",
      "spectre",
      {
        title: "Add automation",
        body: "Implement the approved workflow.",
        labels: ["enhancement"],
        assignees: ["m00nk0d3"],
      },
    )).resolves.toEqual({
      output: "https://github.com/m00nk0d3/spectre/issues/50",
    });
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      operation: "issue_create",
      repository: "m00nk0d3/spectre",
    });
  });

  it("does not execute a cancelled write", async () => {
    const run = runner(() => {
      throw new Error("write must not run");
    });
    const service = new GitHubService({
      runner: run,
      confirm: async () => false,
    });

    await expect(service.write(
      "pull_request_merge",
      "m00nk0d3/spectre",
      { number: 42, method: "squash" },
    )).resolves.toEqual({
      cancelled: true,
      operation: "pull_request_merge",
      repository: "m00nk0d3/spectre",
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("rejects repositories outside the active personal account", async () => {
    const service = new GitHubService({
      runner: runner(() => "[]"),
      confirm: async () => true,
    });

    await expect(service.read(
      "list_pull_requests",
      "octocat/example",
      {},
    )).rejects.toThrow("must be owned by the active account m00nk0d3");
  });

  it("confirms before resolving and creating a branch", async () => {
    let confirmed = false;
    const run = runner((args) => {
      expect(confirmed).toBe(true);
      if (args[0] === "api" && args.includes("--jq")) return "abc123\n";
      expect(args).toEqual([
        "api",
        "--method",
        "POST",
        "repos/m00nk0d3/spectre/git/refs",
        "-f",
        "ref=refs/heads/feature/research",
        "-f",
        "sha=abc123",
      ]);
      return '{"ref":"refs/heads/feature/research"}';
    });
    const service = new GitHubService({
      runner: run,
      confirm: async () => {
        confirmed = true;
        return true;
      },
    });

    await expect(service.write(
      "branch_create",
      "m00nk0d3/spectre",
      { branch: "feature/research", fromRef: "main" },
    )).resolves.toMatchObject({
      ref: "refs/heads/feature/research",
    });
  });

  it("uses the repository default branch when branch creation omits fromRef", async () => {
    const commands: string[][] = [];
    const service = new GitHubService({
      runner: runner((args) => {
        commands.push(args);
        if (args[0] === "repo") return "trunk\n";
        if (args.includes("--jq") && args[1]?.includes("/git/ref/")) {
          return "def456\n";
        }
        return '{"ref":"refs/heads/feature/default"}';
      }),
      confirm: async () => true,
    });

    await service.write("branch_create", "m00nk0d3/spectre", {
      branch: "feature/default",
    });

    expect(commands).toContainEqual([
      "repo",
      "view",
      "m00nk0d3/spectre",
      "--json",
      "defaultBranchRef",
      "--jq",
      ".defaultBranchRef.name",
    ]);
    expect(commands).toContainEqual([
      "api",
      "repos/m00nk0d3/spectre/git/ref/heads/trunk",
      "--jq",
      ".object.sha",
    ]);
  });

  it("validates the complete payload before asking for confirmation", async () => {
    const confirm = vi.fn(async () => true);
    const service = new GitHubService({
      runner: runner(() => ""),
      confirm,
    });

    await expect(service.write(
      "release_edit",
      "m00nk0d3/spectre",
      { tag: "v1.2.0", draft: "yes" },
    )).rejects.toThrow("draft must be boolean");
    await expect(service.write(
      "branch_delete",
      "m00nk0d3/spectre",
      { branch: "../main" },
    )).rejects.toThrow("branch is not a safe Git ref");
    await expect(service.write(
      "issue_close",
      "m00nk0d3/spectre",
      { number: 42, force: true },
    )).rejects.toThrow("Unsupported payload field: force");
    expect(confirm).not.toHaveBeenCalled();
  });

  it("refuses writes when no confirmation surface is available", async () => {
    const service = new GitHubService({ runner: runner(() => "") });

    await expect(service.write(
      "issue_close",
      "m00nk0d3/spectre",
      { number: 42 },
    )).rejects.toThrow("GitHub write confirmation is not available");
  });

  it("maps pull request reviews and merges to typed gh commands", async () => {
    const commands: string[][] = [];
    const service = new GitHubService({
      runner: runner((args) => {
        commands.push(args);
        return "";
      }),
      confirm: async () => true,
    });

    await service.write("pull_request_review", "m00nk0d3/spectre", {
      number: 42,
      action: "request_changes",
      body: "Please add coverage.",
    });
    await service.write("pull_request_merge", "m00nk0d3/spectre", {
      number: 42,
      method: "rebase",
      deleteBranch: true,
    });

    expect(commands).toContainEqual([
      "pr",
      "review",
      "42",
      "--repo",
      "m00nk0d3/spectre",
      "--request-changes",
      "--body",
      "Please add coverage.",
    ]);
    expect(commands).toContainEqual([
      "pr",
      "merge",
      "42",
      "--repo",
      "m00nk0d3/spectre",
      "--rebase",
      "--delete-branch",
    ]);
  });

  it("maps release edits, deletion, and Actions run controls", async () => {
    const commands: string[][] = [];
    const service = new GitHubService({
      runner: runner((args) => {
        commands.push(args);
        return "";
      }),
      confirm: async () => true,
    });

    await service.write("release_edit", "m00nk0d3/spectre", {
      tag: "v1.2.0",
      title: "Spectre 1.2 final",
      draft: false,
      prerelease: false,
    });
    await service.write("release_delete", "m00nk0d3/spectre", {
      tag: "v1.1.0",
      cleanupTag: true,
    });
    await service.write("workflow_run_rerun", "m00nk0d3/spectre", {
      runId: 123,
      failedOnly: true,
    });
    await service.write("workflow_run_cancel", "m00nk0d3/spectre", {
      runId: 124,
    });

    expect(commands).toContainEqual([
      "release",
      "edit",
      "v1.2.0",
      "--repo",
      "m00nk0d3/spectre",
      "--title",
      "Spectre 1.2 final",
      "--draft=false",
      "--prerelease=false",
    ]);
    expect(commands).toContainEqual([
      "release",
      "delete",
      "v1.1.0",
      "--repo",
      "m00nk0d3/spectre",
      "--yes",
      "--cleanup-tag",
    ]);
    expect(commands).toContainEqual([
      "run",
      "rerun",
      "123",
      "--repo",
      "m00nk0d3/spectre",
      "--failed",
    ]);
    expect(commands).toContainEqual([
      "run",
      "cancel",
      "124",
      "--repo",
      "m00nk0d3/spectre",
    ]);
  });

  it("confirms and clones an owned repository into an approved root", async () => {
    const temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "spectre-clone-"),
    );
    temporaryDirectories.push(temporaryDirectory);
    const projectRoot = path.join(temporaryDirectory, "dev");
    await mkdir(projectRoot);
    const commands: string[][] = [];
    const plans: GitHubWritePlan[] = [];
    const service = new GitHubService({
      projectRoots: [projectRoot],
      runner: runner((args) => {
        commands.push(args);
        return "";
      }),
      confirm: async (plan) => {
        plans.push(plan);
        return true;
      },
    });

    await expect(service.write(
      "repository_clone",
      "Normandy",
      {},
    )).resolves.toEqual({
      success: true,
      repository: "m00nk0d3/Normandy",
      destination: path.join(projectRoot, "Normandy"),
    });
    expect(plans[0]).toMatchObject({
      operation: "repository_clone",
      repository: "m00nk0d3/Normandy",
      payload: {
        destination: path.join(projectRoot, "Normandy"),
      },
    });
    expect(commands).toEqual([[
      "repo",
      "clone",
      "m00nk0d3/Normandy",
      path.join(projectRoot, "Normandy"),
    ]]);
  });

  it("rejects clone destinations outside approved project roots", async () => {
    const temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "spectre-clone-"),
    );
    temporaryDirectories.push(temporaryDirectory);
    const projectRoot = path.join(temporaryDirectory, "dev");
    const outsideRoot = path.join(temporaryDirectory, "elsewhere");
    await mkdir(projectRoot);
    await mkdir(outsideRoot);
    const confirm = vi.fn(async () => true);
    const service = new GitHubService({
      projectRoots: [projectRoot],
      runner: runner(() => ""),
      confirm,
    });

    await expect(service.write(
      "repository_clone",
      "Normandy",
      { root: outsideRoot },
    )).rejects.toThrow("must be an approved project root");
    expect(confirm).not.toHaveBeenCalled();
  });

  it("builds release and Actions commands only after confirmation", async () => {
    const commands: string[][] = [];
    const service = new GitHubService({
      runner: runner((args) => {
        commands.push(args);
        return "";
      }),
      confirm: async () => true,
    });

    await service.write("release_create", "m00nk0d3/spectre", {
      tag: "v1.2.0",
      title: "Spectre 1.2",
      notes: "Release notes",
      draft: true,
    });
    await service.write("workflow_dispatch", "m00nk0d3/spectre", {
      workflow: "release.yml",
      ref: "main",
      fields: { channel: "stable", publish: true },
    });

    expect(commands).toContainEqual([
      "release",
      "create",
      "v1.2.0",
      "--repo",
      "m00nk0d3/spectre",
      "--title",
      "Spectre 1.2",
      "--notes",
      "Release notes",
      "--draft",
    ]);
    expect(commands).toContainEqual([
      "workflow",
      "run",
      "release.yml",
      "--repo",
      "m00nk0d3/spectre",
      "--ref",
      "main",
      "-f",
      "channel=stable",
      "-f",
      "publish=true",
    ]);
  });
});
