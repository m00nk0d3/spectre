import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type {
  GitHubMonitorSnapshot,
  GitHubPullRequestEvent,
  GitHubPullRequestEventKind,
} from "@/types/github-monitor";

const execFileAsync = promisify(execFile);
const STATE_VERSION = 1;
const MAX_EVENTS = 100;
const MAX_PULL_REQUESTS_PER_REPOSITORY = 50;
const DEFAULT_POLL_INTERVAL_MS = 60_000;
const MIN_POLL_INTERVAL_MS = 15_000;

interface GitHubRepository {
  nameWithOwner: string;
  isArchived?: boolean;
  url?: string;
}

interface GitHubPullRequestResponse {
  number?: unknown;
  title?: unknown;
  html_url?: unknown;
  state?: unknown;
  draft?: unknown;
  updated_at?: unknown;
  user?: { login?: unknown };
  head?: { sha?: unknown };
  requested_reviewers?: Array<{ login?: unknown }>;
}

interface PullRequestFingerprint {
  number: number;
  title: string;
  url: string;
  author: string;
  state: string;
  draft: boolean;
  updatedAt: string;
  headSha: string;
  requestedReviewers: string[];
}

interface RepositoryMonitorState {
  etag: string | null;
  initialized: boolean;
  pullRequests: Record<string, PullRequestFingerprint>;
}

interface StoredMonitorState {
  version: 1;
  account: string | null;
  repositories: Record<string, RepositoryMonitorState>;
  events: GitHubPullRequestEvent[];
  lastCheckedAt: string | null;
}

interface IncludedResponse {
  status: number;
  etag: string | null;
  body: string;
}

export interface GitHubCommandRunner {
  (command: string, args: string[]): Promise<string>;
}

export interface GitHubMonitorOptions {
  statePath: string;
  runner?: GitHubCommandRunner;
  now?: () => Date;
  pollIntervalMs?: number;
}

function configuredPollInterval(): number {
  const value = Number(process.env.SPECTRE_GITHUB_POLL_INTERVAL_MS);
  return Number.isFinite(value) && value >= MIN_POLL_INTERVAL_MS
    ? value
    : DEFAULT_POLL_INTERVAL_MS;
}

async function defaultRunner(
  command: string,
  args: string[],
): Promise<string> {
  try {
    const result = await execFileAsync(command, args, {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
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
  } catch (error) {
    const notModified = extractNotModifiedOutput(error);
    if (notModified !== null) return notModified;
    throw error;
  }
}

export function extractNotModifiedOutput(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("stdout" in error)) return null;
  const stdout = error.stdout;
  if (
    typeof stdout !== "string"
    || !/^HTTP\/\S+\s+304(?:\s|$)/im.test(stdout)
  ) {
    return null;
  }
  return stdout;
}

function emptyState(): StoredMonitorState {
  return {
    version: STATE_VERSION,
    account: null,
    repositories: {},
    events: [],
    lastCheckedAt: null,
  };
}

function parseJson<T>(value: string, source: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`${source} returned invalid JSON`);
  }
}

function parseIncludedResponse(output: string): IncludedResponse {
  const separator = output.search(/\r?\n\r?\n/);
  if (separator < 0) {
    throw new Error("GitHub API response omitted HTTP headers");
  }
  const matchedSeparator = output.slice(separator).match(/^\r?\n\r?\n/)?.[0]
    ?? "\n\n";
  const headers = output.slice(0, separator);
  const body = output.slice(separator + matchedSeparator.length).trim();
  const statusMatch = headers.match(/^HTTP\/\S+\s+(\d{3})/im);
  if (!statusMatch) {
    throw new Error("GitHub API response omitted an HTTP status");
  }
  const etagMatch = headers.match(/^etag:\s*(.+)$/im);
  return {
    status: Number(statusMatch[1]),
    etag: etagMatch?.[1]?.trim() ?? null,
    body,
  };
}

function parsePullRequest(
  value: GitHubPullRequestResponse,
): PullRequestFingerprint {
  if (
    typeof value.number !== "number"
    || typeof value.title !== "string"
    || typeof value.html_url !== "string"
    || typeof value.state !== "string"
    || typeof value.draft !== "boolean"
    || typeof value.updated_at !== "string"
    || typeof value.user?.login !== "string"
    || typeof value.head?.sha !== "string"
  ) {
    throw new Error("GitHub returned invalid pull request metadata");
  }
  return {
    number: value.number,
    title: value.title,
    url: value.html_url,
    author: value.user.login,
    state: value.state,
    draft: value.draft,
    updatedAt: value.updated_at,
    headSha: value.head.sha,
    requestedReviewers: (value.requested_reviewers ?? [])
      .map((reviewer) => reviewer.login)
      .filter((login): login is string => typeof login === "string")
      .sort(),
  };
}

function classifyEvent(
  previous: PullRequestFingerprint | undefined,
  current: PullRequestFingerprint,
  account: string,
): GitHubPullRequestEventKind | null {
  if (!previous) return "opened";
  if (previous.state !== current.state) {
    if (current.state === "closed") return "closed";
    if (previous.state === "closed" && current.state === "open") {
      return "reopened";
    }
  }
  if (
    current.requestedReviewers.includes(account)
    && !previous.requestedReviewers.includes(account)
  ) {
    return "review_requested";
  }
  if (previous.draft && !current.draft) return "ready_for_review";
  if (previous.headSha !== current.headSha) return "synchronized";
  if (
    previous.title !== current.title
    || previous.updatedAt !== current.updatedAt
    || previous.draft !== current.draft
    || previous.requestedReviewers.join("\0")
      !== current.requestedReviewers.join("\0")
  ) {
    return "updated";
  }
  return null;
}

export class GitHubMonitor {
  private readonly statePath: string;
  private readonly runner: GitHubCommandRunner;
  private readonly now: () => Date;
  private readonly pollIntervalMs: number;
  private state = emptyState();
  private status: GitHubMonitorSnapshot["status"] = "idle";
  private error: string | null = null;
  private nextCheckAt: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling: Promise<void> | null = null;
  private readonly updateListeners = new Set<
    (snapshot: GitHubMonitorSnapshot) => void
  >();
  private readonly eventListeners = new Set<
    (event: GitHubPullRequestEvent) => void
  >();

  constructor(options: GitHubMonitorOptions) {
    this.statePath = options.statePath;
    this.runner = options.runner ?? defaultRunner;
    this.now = options.now ?? (() => new Date());
    this.pollIntervalMs = Math.max(
      options.pollIntervalMs ?? configuredPollInterval(),
      MIN_POLL_INTERVAL_MS,
    );
  }

  async start(): Promise<void> {
    try {
      await this.load();
    } catch (error) {
      this.status = "error";
      this.error = error instanceof Error ? error.message : String(error);
      this.emitUpdate();
      return;
    }
    try {
      await this.poll();
    } catch (error) {
      console.error(
        "[GITHUB-MONITOR] Initial poll failed:",
        error instanceof Error ? error.message : String(error),
      );
    }
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.poll().catch((error) => {
        console.error(
          "[GITHUB-MONITOR] Poll failed:",
          error instanceof Error ? error.message : String(error),
        );
      });
    }, this.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.nextCheckAt = null;
    this.emitUpdate();
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

  getSnapshot(): GitHubMonitorSnapshot {
    return {
      status: this.status,
      account: this.state.account,
      repositoryCount: Object.keys(this.state.repositories).length,
      lastCheckedAt: this.state.lastCheckedAt,
      nextCheckAt: this.nextCheckAt,
      error: this.error,
      events: [...this.state.events],
    };
  }

  onUpdate(
    listener: (snapshot: GitHubMonitorSnapshot) => void,
  ): () => void {
    this.updateListeners.add(listener);
    return () => this.updateListeners.delete(listener);
  }

  onEvent(
    listener: (event: GitHubPullRequestEvent) => void,
  ): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  private async performPoll(): Promise<void> {
    this.status = "polling";
    this.error = null;
    this.nextCheckAt = null;
    this.emitUpdate();
    try {
      const login = (
        await this.runner("gh", ["api", "user", "--jq", ".login"])
      ).trim();
      if (!login) throw new Error("GitHub CLI returned an empty account login");
      this.state.account = login;

      const repositories = parseJson<GitHubRepository[]>(
        await this.runner("gh", [
          "repo",
          "list",
          login,
          "--limit",
          "1000",
          "--json",
          "nameWithOwner,isArchived,url",
        ]),
        "gh repo list",
      ).filter((repository) =>
        typeof repository.nameWithOwner === "string"
        && !repository.isArchived,
      );

      for (let index = 0; index < repositories.length; index += 4) {
        await Promise.all(
          repositories
            .slice(index, index + 4)
            .map((repository) => this.pollRepository(repository.nameWithOwner)),
        );
      }

      const activeNames = new Set(
        repositories.map((repository) => repository.nameWithOwner),
      );
      for (const name of Object.keys(this.state.repositories)) {
        if (!activeNames.has(name)) delete this.state.repositories[name];
      }

      this.state.lastCheckedAt = this.now().toISOString();
      this.status = "ready";
      this.nextCheckAt = new Date(
        this.now().getTime() + this.pollIntervalMs,
      ).toISOString();
      await this.save();
      this.emitUpdate();
    } catch (error) {
      this.status = "error";
      this.error = error instanceof Error ? error.message : String(error);
      this.nextCheckAt = new Date(
        this.now().getTime() + this.pollIntervalMs,
      ).toISOString();
      this.emitUpdate();
      throw error;
    }
  }

  private async pollRepository(nameWithOwner: string): Promise<void> {
    const repositoryState = this.state.repositories[nameWithOwner] ?? {
      etag: null,
      initialized: false,
      pullRequests: {},
    };
    const args = [
      "api",
      "--include",
      "--method",
      "GET",
      `repos/${nameWithOwner}/pulls`,
      "-f",
      "state=all",
      "-f",
      "sort=updated",
      "-f",
      "direction=desc",
      "-f",
      `per_page=${MAX_PULL_REQUESTS_PER_REPOSITORY}`,
      "-H",
      "Accept: application/vnd.github+json",
    ];
    if (repositoryState.etag) {
      args.push("-H", `If-None-Match: ${repositoryState.etag}`);
    }
    const response = parseIncludedResponse(await this.runner("gh", args));
    if (response.status === 304) return;
    if (response.status !== 200) {
      throw new Error(
        `GitHub returned ${response.status} while checking ${nameWithOwner}`,
      );
    }
    const pullRequests = parseJson<GitHubPullRequestResponse[]>(
      response.body,
      `GitHub pull requests for ${nameWithOwner}`,
    ).map(parsePullRequest);
    const nextPullRequests = { ...repositoryState.pullRequests };
    for (const pullRequest of pullRequests) {
      const key = String(pullRequest.number);
      if (repositoryState.initialized) {
        const kind = classifyEvent(
          repositoryState.pullRequests[key],
          pullRequest,
          this.state.account ?? "",
        );
        if (kind) this.recordEvent(nameWithOwner, pullRequest, kind);
      }
      nextPullRequests[key] = pullRequest;
    }
    this.state.repositories[nameWithOwner] = {
      etag: response.etag,
      initialized: true,
      pullRequests: nextPullRequests,
    };
  }

  private recordEvent(
    repository: string,
    pullRequest: PullRequestFingerprint,
    kind: GitHubPullRequestEventKind,
  ): void {
    const event: GitHubPullRequestEvent = {
      id: `github-pr-${randomUUID()}`,
      kind,
      repository,
      number: pullRequest.number,
      title: pullRequest.title,
      url: pullRequest.url,
      author: pullRequest.author,
      draft: pullRequest.draft,
      state: pullRequest.state,
      headSha: pullRequest.headSha,
      updatedAt: pullRequest.updatedAt,
      detectedAt: this.now().toISOString(),
    };
    this.state.events = [event, ...this.state.events].slice(0, MAX_EVENTS);
    for (const listener of this.eventListeners) listener(event);
  }

  private async load(): Promise<void> {
    try {
      const parsed = parseJson<StoredMonitorState>(
        await readFile(this.statePath, "utf8"),
        "GitHub monitor state",
      );
      if (
        parsed.version !== STATE_VERSION
        || !parsed.repositories
        || !Array.isArray(parsed.events)
      ) {
        throw new Error("GitHub monitor state has an unsupported format");
      }
      this.state = parsed;
    } catch (error) {
      const code = error !== null && typeof error === "object" && "code" in error
        ? String(error.code)
        : "";
      if (code !== "ENOENT") {
        throw error;
      }
      this.state = emptyState();
    }
  }

  private async save(): Promise<void> {
    await mkdir(path.dirname(this.statePath), {
      recursive: true,
      mode: 0o700,
    });
    const temporary = `${this.statePath}.${process.pid}.tmp`;
    await writeFile(
      temporary,
      `${JSON.stringify(this.state, null, 2)}\n`,
      { mode: 0o600 },
    );
    await rename(temporary, this.statePath);
  }

  private emitUpdate(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.updateListeners) listener(snapshot);
  }
}

let activeGitHubMonitor: GitHubMonitor | null = null;

export function setActiveGitHubMonitor(monitor: GitHubMonitor | null): void {
  activeGitHubMonitor = monitor;
}

export function getGitHubMonitorSnapshot(): GitHubMonitorSnapshot {
  if (!activeGitHubMonitor) {
    throw new Error("GitHub monitor is not ready");
  }
  return activeGitHubMonitor.getSnapshot();
}
