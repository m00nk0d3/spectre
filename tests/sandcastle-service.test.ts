import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SandcastleService,
  type SandcastleCommandRunner,
} from "../src/main/sandcastle-service";

const temporaryDirectories: string[] = [];

async function repository(name = "spectre"): Promise<{
  root: string;
  project: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "spectre-projects-"));
  temporaryDirectories.push(root);
  const project = path.join(root, name);
  await mkdir(path.join(project, ".git"), { recursive: true });
  return { root, project };
}

function workflow(id = "run_test") {
  return {
    id,
    title: "Implement issue #42",
    status: "running",
    repo: "/tmp/spectre",
    worktree_path: "/tmp/spectre-worktree",
    branch: "agent/test",
    default_agent: "opencode",
    current_step: "implementation",
    progress: { completed: 2, total: 5, percent: 40 },
    github: { issue: 42, pull_request: null },
    agents: [],
    steps: [],
    started_at: "2026-10-03T00:00:00.000Z",
    updated_at: "2026-10-03T00:01:00.000Z",
    kind: "imp",
    pid: 123,
    source: "spectre",
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("SandcastleService", () => {
  it("discovers only repositories below approved project roots", async () => {
    const { root, project } = await repository();
    const runner: SandcastleCommandRunner = vi.fn(
      async (command, args) => {
        if (command === "git" && args[0] === "branch") return "main";
        if (command === "git" && args[0] === "remote") {
          return "git@github.com:m00nk0d3/spectre.git";
        }
        throw new Error("unexpected command");
      },
    );
    const service = new SandcastleService({
      projectRoots: [root],
      runner,
    });

    await expect(service.listProjects()).resolves.toEqual([{
      name: "spectre",
      path: project,
      branch: "main",
      remote: "git@github.com:m00nk0d3/spectre.git",
    }]);
    await expect(
      service.prepareIssueWorkflow("/tmp/not-approved", 42),
    ).rejects.toThrow("not inside an approved root");
  });

  it("prepares an immutable expiring plan without starting a workflow", async () => {
    const { root, project } = await repository();
    const runner = vi.fn(async (command: string, args: string[]) => {
      if (command === "git" && args[0] === "branch") return "main";
      if (command === "git" && args[0] === "remote") return "origin-url";
      throw new Error("workflow command should not run while planning");
    });
    const service = new SandcastleService({
      projectRoots: [root],
      runner,
      now: () => new Date("2026-10-03T00:00:00.000Z"),
      planTtlMs: 60_000,
      planDirectory: path.join(root, "plans"),
    });

    const plan = await service.prepareIssueWorkflow(project, 42);

    expect(plan).toMatchObject({
      project: { path: project, branch: "main", remote: "origin-url" },
      issue: 42,
      agent: "opencode",
      expiresAt: "2026-10-03T00:01:00.000Z",
    });
    expect(plan.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(service.listPlans()).toEqual([plan]);
    expect(runner).not.toHaveBeenCalledWith(
      "grove-sandcastle",
      expect.anything(),
      expect.anything(),
    );
    const firstPlanPath = await service.writePlanFile(plan.id, plan.hash);
    const secondPlanPath = await service.writePlanFile(plan.id, plan.hash);
    expect(secondPlanPath).toBe(firstPlanPath);
    await expect(readFile(firstPlanPath, "utf8")).resolves.toContain(plan.hash);
  });

  it("starts only the exact reviewed plan and attributes it to Spectre", async () => {
    const { root, project } = await repository();
    const runner: SandcastleCommandRunner = vi.fn(
      async (command, args) => {
        if (command === "git" && args[0] === "branch") return "main";
        if (command === "git" && args[0] === "remote") return "origin-url";
        if (command === "grove-sandcastle" && args[0] === "capabilities") {
          return JSON.stringify({ draft_pull_requests: true });
        }
        if (command === "grove-sandcastle") {
          return JSON.stringify({ workflow: workflow() });
        }
        throw new Error("unexpected command");
      },
    );
    const service = new SandcastleService({
      projectRoots: [root],
      runner,
    });
    const plan = await service.prepareIssueWorkflow(project, 42);

    await expect(
      service.startPlan(plan.id, "wrong-hash"),
    ).rejects.toThrow("missing, expired, or has changed");

    await expect(service.startPlan(plan.id, plan.hash)).resolves.toMatchObject({
      workflow: { id: "run_test", status: "running" },
    });
    expect(runner).toHaveBeenCalledWith(
      "grove-sandcastle",
      [
        "workflow",
        "start",
        "--kind",
        "imp",
        "--issue",
        "42",
        "--draft",
        "--repo",
        project,
        "--agent",
        "opencode",
        "--source",
        "spectre",
      ],
      { cwd: project },
    );
    expect(service.listPlans()).toEqual([]);
  });

  it("fails closed when the installed runtime cannot guarantee a draft PR", async () => {
    const { root, project } = await repository();
    const runner: SandcastleCommandRunner = vi.fn(
      async (command, args) => {
        if (command === "git" && args[0] === "branch") return "main";
        if (command === "git" && args[0] === "remote") return "origin-url";
        if (command === "grove-sandcastle" && args[0] === "capabilities") {
          return JSON.stringify({ draft_pull_requests: false });
        }
        throw new Error("workflow start must remain blocked");
      },
    );
    const service = new SandcastleService({
      projectRoots: [root],
      runner,
    });
    const plan = await service.prepareIssueWorkflow(project, 42);

    await expect(service.startPlan(plan.id, plan.hash)).rejects.toThrow(
      "does not support draft pull requests",
    );
    expect(service.listPlans()).toEqual([plan]);
  });

  it("fails closed when the installed runtime has no capability command", async () => {
    const { root, project } = await repository();
    const runner: SandcastleCommandRunner = vi.fn(
      async (command, args) => {
        if (command === "git" && args[0] === "branch") return "main";
        if (command === "git" && args[0] === "remote") return "origin-url";
        throw new Error("Usage: grove-sandcastle status");
      },
    );
    const service = new SandcastleService({
      projectRoots: [root],
      runner,
    });
    const plan = await service.prepareIssueWorkflow(project, 42);

    await expect(service.startPlan(plan.id, plan.hash)).rejects.toThrow(
      "does not advertise draft pull request support",
    );
  });

  it("reads live workflows and stops only validated run identifiers", async () => {
    const { root, project } = await repository();
    const runner: SandcastleCommandRunner = vi.fn(
      async (command, args) => {
        if (command === "git" && args[0] === "branch") return "main";
        if (command === "git" && args[0] === "remote") return "origin-url";
        if (args[0] === "status") {
          return JSON.stringify({ workflows: [workflow()] });
        }
        if (args[0] === "workflow" && args[1] === "remove") {
          return JSON.stringify({ removed: "run_test", stopped: true });
        }
        throw new Error("unexpected command");
      },
    );
    const service = new SandcastleService({
      projectRoots: [root],
      runner,
    });

    await expect(service.listWorkflows(project)).resolves.toMatchObject([
      { id: "run_test", progress: { percent: 40 } },
    ]);
    await expect(
      service.stopWorkflow(project, "not a run"),
    ).rejects.toThrow("Invalid Sandcastle workflow run ID");
    await expect(
      service.stopWorkflow(project, "run_test"),
    ).resolves.toEqual({ removed: "run_test", stopped: true });
  });
});
