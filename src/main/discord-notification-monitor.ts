import { execFile } from "node:child_process";
import {
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { sandcastleService } from "./sandcastle-service";
import type {
  DiscordNotification,
  DiscordNotificationKind,
} from "./discord-transport";

const execFileAsync = promisify(execFile);
const STATE_VERSION = 1;
const DEFAULT_POLL_INTERVAL_MS = 60_000;
const MIN_POLL_INTERVAL_MS = 30_000;
const MAX_SEEN_GITHUB_IDS = 500;

interface GitHubNotificationResponse {
  id?: unknown;
  reason?: unknown;
  subject?: {
    title?: unknown;
    type?: unknown;
    url?: unknown;
  };
  repository?: {
    full_name?: unknown;
    html_url?: unknown;
  };
}

interface NotificationMonitorState {
  version: 1;
  seenGitHubIds: string[];
  workflowStatuses: Record<string, string>;
  workflowBaselineEstablished: boolean;
}

interface GitHubCheckSuiteResponse {
  conclusion?: unknown;
  html_url?: unknown;
}

export interface DiscordNotificationMonitorOptions {
  statePath: string;
  notify: (notification: DiscordNotification) => Promise<boolean>;
  runner?: (command: string, args: string[]) => Promise<string>;
  pollIntervalMs?: number;
}

function emptyState(): NotificationMonitorState {
  return {
    version: STATE_VERSION,
    seenGitHubIds: [],
    workflowStatuses: {},
    workflowBaselineEstablished: false,
  };
}

function configuredPollInterval(): number {
  const value = Number(
    process.env.SPECTRE_DISCORD_NOTIFICATION_POLL_INTERVAL_MS,
  );
  return Number.isFinite(value) && value >= MIN_POLL_INTERVAL_MS
    ? value
    : DEFAULT_POLL_INTERVAL_MS;
}

async function defaultRunner(
  command: string,
  args: string[],
): Promise<string> {
  const result = await execFileAsync(command, args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: 30_000,
    env: {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      GH_HOST: process.env.GH_HOST,
      GH_CONFIG_DIR: process.env.GH_CONFIG_DIR,
      LANG: process.env.LANG,
      LC_ALL: process.env.LC_ALL,
    },
  });
  return result.stdout;
}

function parseJson<T>(value: string, source: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`${source} returned invalid JSON`);
  }
}

function notificationKind(
  reason: string,
): DiscordNotificationKind | null {
  if (reason === "review_requested") return "review_requested";
  if (reason === "assign") return "issue_assigned";
  if (reason === "mention" || reason === "team_mention") {
    return "github_mention";
  }
  return null;
}

function webUrl(
  repositoryUrl: string,
  subjectType: string,
  subjectApiUrl: string,
): string {
  const number = subjectApiUrl.match(/\/(\d+)$/)?.[1];
  if (!number) return repositoryUrl;
  if (subjectType === "PullRequest") return `${repositoryUrl}/pull/${number}`;
  if (subjectType === "Issue") return `${repositoryUrl}/issues/${number}`;
  if (subjectType === "CheckSuite") return `${repositoryUrl}/actions`;
  return repositoryUrl;
}

function isTerminalWorkflowStatus(status: string): boolean {
  return [
    "completed",
    "complete",
    "succeeded",
    "success",
    "failed",
    "cancelled",
    "canceled",
  ].includes(status.toLowerCase());
}

export class DiscordNotificationMonitor {
  private readonly runner: (command: string, args: string[]) => Promise<string>;
  private readonly pollIntervalMs: number;
  private state = emptyState();
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling: Promise<void> | null = null;
  private loaded = false;

  constructor(private readonly options: DiscordNotificationMonitorOptions) {
    this.runner = options.runner ?? defaultRunner;
    this.pollIntervalMs = Math.max(
      options.pollIntervalMs ?? configuredPollInterval(),
      MIN_POLL_INTERVAL_MS,
    );
  }

  async start(): Promise<void> {
    await this.load();
    await this.poll();
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.poll().catch((error) => {
        void error;
        console.error("[DISCORD] Notification poll failed safely");
      });
    }, this.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async poll(): Promise<void> {
    if (this.polling) return this.polling;
    this.polling = this.performPoll();
    try {
      await this.polling;
    } finally {
      this.polling = null;
    }
  }

  private async performPoll(): Promise<void> {
    await this.load();
    const failures: string[] = [];
    await this.pollGitHub().catch((error) => {
      failures.push(error instanceof Error ? error.message : String(error));
    });
    await this.pollSandcastle().catch((error) => {
      failures.push(error instanceof Error ? error.message : String(error));
    });
    await this.save();
    if (failures.length === 2) {
      throw new Error(`All notification sources failed: ${failures.join("; ")}`);
    }
  }

  private async pollGitHub(): Promise<void> {
    const values = parseJson<GitHubNotificationResponse[]>(
      await this.runner("gh", [
        "api",
        "--method",
        "GET",
        "notifications",
        "-f",
        "all=false",
        "-f",
        "participating=false",
        "-f",
        "per_page=50",
      ]),
      "GitHub notifications",
    );
    const seen = new Set(this.state.seenGitHubIds);
    const currentIds: string[] = [];
    for (const value of values) {
      if (
        typeof value.id !== "string"
        || typeof value.reason !== "string"
        || typeof value.subject?.title !== "string"
        || typeof value.subject.type !== "string"
        || typeof value.subject.url !== "string"
        || typeof value.repository?.full_name !== "string"
        || typeof value.repository.html_url !== "string"
      ) {
        continue;
      }
      currentIds.push(value.id);
      if (seen.has(value.id)) continue;
      let kind = notificationKind(value.reason);
      let checkedUrl: string | undefined;
      if (value.reason === "ci_activity") {
        const check = parseJson<GitHubCheckSuiteResponse>(
          await this.runner("gh", [
            "api",
            "--method",
            "GET",
            value.subject.url,
          ]),
          "GitHub check suite",
        );
        if (
          typeof check.conclusion === "string"
          && ["failure", "timed_out", "startup_failure"].includes(
            check.conclusion,
          )
        ) {
          kind = "ci_failed";
          checkedUrl = typeof check.html_url === "string"
            ? check.html_url
            : undefined;
        }
      }
      if (!kind) continue;
      await this.options.notify({
        kind,
        title: `${value.repository.full_name}: ${value.subject.title}`,
        body: value.reason.replaceAll("_", " "),
        url: checkedUrl ?? webUrl(
          value.repository.html_url,
          value.subject.type,
          value.subject.url,
        ),
      });
    }
    this.state.seenGitHubIds = [
      ...new Set([...currentIds, ...this.state.seenGitHubIds]),
    ].slice(0, MAX_SEEN_GITHUB_IDS);
  }

  private async pollSandcastle(): Promise<void> {
    const nextStatuses: Record<string, string> = {};
    const projects = await sandcastleService.listProjects();
    for (const project of projects) {
      const workflows = await sandcastleService.listWorkflows(project.path);
      for (const workflow of workflows) {
        const key = `${project.path}\0${workflow.id}`;
        nextStatuses[key] = workflow.status;
        const previous = this.state.workflowStatuses[key];
        if (
          this.state.workflowBaselineEstablished
          && previous
          && !isTerminalWorkflowStatus(previous)
          && isTerminalWorkflowStatus(workflow.status)
        ) {
          await this.options.notify({
            kind: "workflow_completed",
            title: `Sandcastle workflow ${workflow.status}`,
            body: `${workflow.title}\n${project.name}`,
          });
        }
      }
    }
    this.state.workflowStatuses = nextStatuses;
    this.state.workflowBaselineEstablished = true;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const parsed = parseJson<NotificationMonitorState>(
        await readFile(this.options.statePath, "utf8"),
        "Discord notification state",
      );
      if (
        parsed.version !== STATE_VERSION
        || !Array.isArray(parsed.seenGitHubIds)
        || typeof parsed.workflowStatuses !== "object"
      ) {
        throw new Error("Discord notification state has an unsupported format");
      }
      this.state = parsed;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "";
      if (code !== "ENOENT") throw error;
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    await mkdir(path.dirname(this.options.statePath), { recursive: true });
    const temporaryPath = `${this.options.statePath}.new`;
    await writeFile(temporaryPath, JSON.stringify(this.state, null, 2), {
      mode: 0o600,
    });
    await rename(temporaryPath, this.options.statePath);
  }
}
