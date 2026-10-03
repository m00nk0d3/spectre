import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readdir,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
  SandcastleIssuePlan,
  SandcastleProject,
  SandcastleStartResult,
  SandcastleWorkflow,
} from "@/types/sandcastle";

const execFileAsync = promisify(execFile);
const DEFAULT_PLAN_TTL_MS = 15 * 60 * 1000;
const PROJECT_CACHE_TTL_MS = 10_000;
const IGNORED_DIRECTORIES = new Set([
  ".cache",
  ".git",
  ".local",
  "node_modules",
  "out",
  "dist",
  "build",
]);

export interface SandcastleCommandRunner {
  (
    command: string,
    args: string[],
    options: { cwd: string },
  ): Promise<string>;
}

export interface SandcastleServiceOptions {
  projectRoots?: string[];
  command?: string;
  runner?: SandcastleCommandRunner;
  now?: () => Date;
  planTtlMs?: number;
  planDirectory?: string;
}

interface SandcastleStatusResponse {
  workflows?: unknown;
}

interface SandcastleStartResponse {
  workflow?: unknown;
}

interface SandcastleCapabilities {
  draft_pull_requests?: unknown;
}

function defaultProjectRoots(): string[] {
  const configured = process.env.SPECTRE_PROJECT_ROOTS
    ?.split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return configured?.length ? configured : [path.join(os.homedir(), "dev")];
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function positiveInteger(value: unknown, name: string): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 1
  ) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function parseWorkflow(value: unknown): SandcastleWorkflow {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Sandcastle returned an invalid workflow");
  }
  const workflow = value as Partial<SandcastleWorkflow>;
  requireString(workflow.id, "workflow.id");
  requireString(workflow.title, "workflow.title");
  requireString(workflow.status, "workflow.status");
  requireString(workflow.repo, "workflow.repo");
  requireString(workflow.current_step, "workflow.current_step");
  if (!workflow.progress || typeof workflow.progress.percent !== "number") {
    throw new Error("Sandcastle returned invalid workflow progress");
  }
  return {
    ...workflow,
    worktree_path: workflow.worktree_path ?? workflow.repo,
    branch: workflow.branch ?? "",
    default_agent: workflow.default_agent ?? "opencode",
    github: workflow.github ?? { issue: null, pull_request: null },
    agents: Array.isArray(workflow.agents) ? workflow.agents : [],
    steps: Array.isArray(workflow.steps) ? workflow.steps : [],
    started_at: workflow.started_at ?? "",
    updated_at: workflow.updated_at ?? "",
    kind: workflow.kind ?? "unknown",
    pid: typeof workflow.pid === "number" ? workflow.pid : null,
    source: workflow.source ?? "unknown",
  } as SandcastleWorkflow;
}

function parseJson(output: string, source: string): unknown {
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`${source} returned invalid JSON`);
  }
}

async function defaultRunner(
  command: string,
  args: string[],
  options: { cwd: string },
): Promise<string> {
  const result = await execFileAsync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: 30_000,
    env: {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      LANG: process.env.LANG,
      LC_ALL: process.env.LC_ALL,
      DISPLAY: process.env.DISPLAY,
      WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY,
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
      DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
      XDG_CURRENT_DESKTOP: process.env.XDG_CURRENT_DESKTOP,
      SHELL: process.env.SHELL,
      TERM: process.env.TERM,
      USER: process.env.USER,
      LOGNAME: process.env.LOGNAME,
    },
  });
  return result.stdout.trim();
}

export class SandcastleService {
  private readonly roots: string[];
  private readonly command: string;
  private readonly runner: SandcastleCommandRunner;
  private readonly now: () => Date;
  private readonly planTtlMs: number;
  private readonly planDirectory: string;
  private readonly plans = new Map<string, SandcastleIssuePlan>();
  private projectCache: SandcastleProject[] = [];
  private projectCacheAt = 0;

  constructor(options: SandcastleServiceOptions = {}) {
    this.roots = (options.projectRoots ?? defaultProjectRoots())
      .map((root) => path.resolve(root));
    this.command = options.command ?? "grove-sandcastle";
    this.runner = options.runner ?? defaultRunner;
    this.now = options.now ?? (() => new Date());
    this.planTtlMs = options.planTtlMs ?? DEFAULT_PLAN_TTL_MS;
    this.planDirectory = options.planDirectory
      ?? path.join(os.tmpdir(), "spectre-workflow-plans");
  }

  async listProjects(force = false): Promise<SandcastleProject[]> {
    const now = this.now().getTime();
    if (
      !force
      && this.projectCache.length > 0
      && now - this.projectCacheAt < PROJECT_CACHE_TTL_MS
    ) {
      return this.projectCache;
    }
    const repositories: string[] = [];
    for (const configuredRoot of this.roots) {
      let root: string;
      try {
        root = await realpath(configuredRoot);
      } catch {
        continue;
      }
      await this.findRepositories(root, root, 0, repositories);
    }

    const unique = [...new Set(repositories)].sort();
    this.projectCache = await Promise.all(
      unique.map((repository) => this.describeProject(repository)),
    );
    this.projectCacheAt = now;
    return this.projectCache;
  }

  async listWorkflows(projectReference: string): Promise<SandcastleWorkflow[]> {
    const project = await this.resolveProject(projectReference);
    const output = await this.runner(
      this.command,
      ["status"],
      { cwd: project.path },
    );
    const response = parseJson(output, this.command) as SandcastleStatusResponse;
    if (!Array.isArray(response.workflows)) {
      throw new Error("Sandcastle status omitted workflows");
    }
    return response.workflows.map(parseWorkflow);
  }

  async prepareIssueWorkflow(
    projectReference: string,
    issueValue: number,
  ): Promise<SandcastleIssuePlan> {
    const issue = positiveInteger(issueValue, "issue");
    const project = await this.resolveProject(projectReference, true);
    const now = this.now();
    const id = `plan_${randomUUID()}`;
    const payload = {
      id,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.planTtlMs).toISOString(),
      project,
      issue,
      agent: "opencode" as const,
      title: `Implement issue #${issue} in ${project.name}`,
      summary:
        "Run the existing Sandcastle implementation workflow in a visible Herdr pane.",
      effects: [
        "Synchronize the repository default branch with origin.",
        "Create and preserve a dedicated implementation worktree and branch.",
        "Run planning, implementation, tests, verification, and specialist review agents.",
        "Commit and push the implementation branch.",
        "Open a draft pull request, or update an existing pull request, linked to the issue.",
        "Pause for the workflow's existing interactive review decisions.",
      ],
    };
    const hash = createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex");
    const plan: SandcastleIssuePlan = { ...payload, hash };
    this.plans.set(id, plan);
    return plan;
  }

  async validateIssueWorkflow(
    projectReference: string,
    issueValue: number,
  ): Promise<{ project: SandcastleProject; issue: number }> {
    return {
      project: await this.resolveProject(projectReference, true),
      issue: positiveInteger(issueValue, "issue"),
    };
  }

  listPlans(): SandcastleIssuePlan[] {
    this.removeExpiredPlans();
    return [...this.plans.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  getPlan(id: string, hash: string): SandcastleIssuePlan {
    this.removeExpiredPlans();
    const plan = this.plans.get(id);
    if (!plan || plan.hash !== hash) {
      throw new Error("Workflow plan is missing, expired, or has changed");
    }
    return plan;
  }

  async startPlan(id: string, hash: string): Promise<SandcastleStartResult> {
    const plan = this.getPlan(id, hash);
    const project = await this.resolveProject(plan.project.path, true);
    if (
      project.path !== plan.project.path
      || project.branch !== plan.project.branch
      || project.remote !== plan.project.remote
    ) {
      throw new Error(
        "Project state changed after the workflow plan was prepared",
      );
    }
    let capabilitiesOutput: string;
    try {
      capabilitiesOutput = await this.runner(
        this.command,
        ["capabilities"],
        { cwd: project.path },
      );
    } catch {
      throw new Error(
        "Installed Sandcastle runtime does not advertise draft pull request support; update it before starting this plan",
      );
    }
    const capabilities = parseJson(
      capabilitiesOutput,
      `${this.command} capabilities`,
    ) as SandcastleCapabilities;
    if (capabilities.draft_pull_requests !== true) {
      throw new Error(
        "Installed Sandcastle runtime does not support draft pull requests; update it before starting this plan",
      );
    }
    const output = await this.runner(
      this.command,
      [
        "workflow",
        "start",
        "--kind",
        "imp",
        "--issue",
        String(plan.issue),
        "--draft",
        "--repo",
        project.path,
        "--agent",
        plan.agent,
        "--source",
        "spectre",
      ],
      { cwd: project.path },
    );
    const response = parseJson(output, this.command) as SandcastleStartResponse;
    const workflow = parseWorkflow(response.workflow);
    this.plans.delete(id);
    return { workflow };
  }

  async stopWorkflow(
    projectReference: string,
    runId: string,
  ): Promise<{ removed: string; stopped: boolean }> {
    if (!/^run_[A-Za-z0-9_-]+$/.test(runId)) {
      throw new Error("Invalid Sandcastle workflow run ID");
    }
    const project = await this.resolveProject(projectReference, true);
    const output = await this.runner(
      this.command,
      [
        "workflow",
        "remove",
        runId,
        "--repo",
        project.path,
        "--stop",
      ],
      { cwd: project.path },
    );
    const result = parseJson(output, this.command);
    if (
      !result
      || typeof result !== "object"
      || (result as { removed?: unknown }).removed !== runId
    ) {
      throw new Error("Sandcastle returned an invalid stop result");
    }
    return result as { removed: string; stopped: boolean };
  }

  async writePlanFile(id: string, hash: string): Promise<string> {
    const plan = this.getPlan(id, hash);
    await mkdir(this.planDirectory, { recursive: true, mode: 0o700 });
    const destination = path.join(this.planDirectory, `${plan.hash}.md`);
    const content = [
      `# ${plan.title}`,
      "",
      `Plan ID: \`${plan.id}\``,
      `Plan hash: \`${plan.hash}\``,
      `Created: ${plan.createdAt}`,
      `Expires: ${plan.expiresAt}`,
      "",
      "## Target",
      "",
      `- Project: \`${plan.project.path}\``,
      `- Branch: \`${plan.project.branch || "(detached)"}\``,
      `- Remote: ${plan.project.remote ?? "(none)"}`,
      `- Issue: #${plan.issue}`,
      `- Agent: ${plan.agent}`,
      "",
      "## Effects",
      "",
      ...plan.effects.map((effect) => `- ${effect}`),
      "",
      "This file is a read-only rendering of the immutable workflow plan.",
      "Approval is valid only for the exact plan hash above.",
      "",
    ].join("\n");
    try {
      await chmod(destination, 0o600);
    } catch (error) {
      const code = error !== null && typeof error === "object" && "code" in error
        ? String(error.code)
        : "";
      if (code !== "ENOENT") throw error;
    }
    await writeFile(destination, content, { mode: 0o400 });
    await chmod(destination, 0o400);
    return destination;
  }

  private async resolveProject(
    reference: string,
    force = false,
  ): Promise<SandcastleProject> {
    const requested = requireString(reference, "project").trim();
    const projects = await this.listProjects(force);
    const resolvedRequest = path.resolve(requested);
    const matches = projects.filter((project) =>
      project.path === resolvedRequest
      || project.name.toLowerCase() === requested.toLowerCase()
    );
    if (matches.length === 0) {
      throw new Error(`Project is not inside an approved root: ${requested}`);
    }
    if (matches.length > 1) {
      throw new Error(`Project name is ambiguous; use an absolute path: ${requested}`);
    }
    return matches[0];
  }

  private async findRepositories(
    root: string,
    directory: string,
    depth: number,
    repositories: string[],
  ): Promise<void> {
    if (!isWithin(root, directory) || depth > 3) return;
    try {
      const gitMarker = path.join(directory, ".git");
      if ((await stat(gitMarker)).isDirectory() || (await stat(gitMarker)).isFile()) {
        repositories.push(directory);
        return;
      }
    } catch {
      // Continue searching below non-repository directories.
    }

    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(entries
      .filter((entry) =>
        entry.isDirectory()
        && !entry.isSymbolicLink()
        && !IGNORED_DIRECTORIES.has(entry.name)
        && !entry.name.startsWith("."),
      )
      .map((entry) => this.findRepositories(
        root,
        path.join(directory, entry.name),
        depth + 1,
        repositories,
      )));
  }

  private async describeProject(repository: string): Promise<SandcastleProject> {
    const [branch, remote] = await Promise.all([
      this.gitValue(repository, ["branch", "--show-current"]),
      this.gitValue(repository, ["remote", "get-url", "origin"]),
    ]);
    return {
      name: path.basename(repository),
      path: repository,
      branch,
      remote: remote || null,
    };
  }

  private async gitValue(repository: string, args: string[]): Promise<string> {
    try {
      return await this.runner("git", args, { cwd: repository });
    } catch {
      return "";
    }
  }

  private removeExpiredPlans(): void {
    const now = this.now().getTime();
    for (const [id, plan] of this.plans) {
      if (Date.parse(plan.expiresAt) <= now) this.plans.delete(id);
    }
  }
}

export const sandcastleService = new SandcastleService();
