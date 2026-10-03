import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const NAME_PATTERN = /^[A-Za-z0-9._/-]+$/;
const MAX_LIMIT = 100;

export type GitHubReadOperation =
  | "list_repositories"
  | "get_repository"
  | "list_issues"
  | "get_issue"
  | "list_pull_requests"
  | "get_pull_request"
  | "list_branches"
  | "list_releases"
  | "list_workflow_runs";

export type GitHubWriteOperation =
  | "issue_create"
  | "issue_edit"
  | "issue_comment"
  | "issue_close"
  | "issue_reopen"
  | "pull_request_create"
  | "pull_request_edit"
  | "pull_request_comment"
  | "pull_request_review"
  | "pull_request_ready"
  | "branch_create"
  | "branch_delete"
  | "pull_request_merge"
  | "release_create"
  | "release_edit"
  | "release_delete"
  | "workflow_dispatch"
  | "workflow_run_rerun"
  | "workflow_run_cancel"
  | "repository_clone";

export interface GitHubWritePlan {
  operation: GitHubWriteOperation;
  repository: string;
  title: string;
  detail: string;
  payload: Record<string, unknown>;
}

export interface GitHubServiceOptions {
  runner?: (
    command: string,
    args: string[],
  ) => Promise<string>;
  confirm?: (plan: GitHubWritePlan) => Promise<boolean>;
  projectRoots?: string[];
}

function defaultProjectRoots(): string[] {
  const configured = process.env.SPECTRE_PROJECT_ROOTS
    ?.split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return configured?.length ? configured : [path.join(os.homedir(), "dev")];
}

function defaultRunner(command: string, args: string[]): Promise<string> {
  return execFileAsync(command, args, {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    timeout: 60_000,
    env: {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      GH_HOST: process.env.GH_HOST,
      GH_CONFIG_DIR: process.env.GH_CONFIG_DIR,
      LANG: process.env.LANG,
      LC_ALL: process.env.LC_ALL,
    },
  }).then((result) => result.stdout);
}

function objectPayload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("GitHub payload must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function stringValue(
  payload: Record<string, unknown>,
  key: string,
  options: { required?: boolean; allowEmpty?: boolean } = {},
): string | undefined {
  const value = payload[key];
  if (value === undefined && !options.required) return undefined;
  if (
    typeof value !== "string"
    || (!options.allowEmpty && value.trim().length === 0)
  ) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value;
}

function integerValue(
  payload: Record<string, unknown>,
  key: string,
  required = true,
): number | undefined {
  const value = payload[key];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${key} must be a positive integer`);
  }
  return value;
}

function booleanValue(
  payload: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = payload[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${key} must be boolean`);
  return value;
}

function stringArray(
  payload: Record<string, unknown>,
  key: string,
): string[] {
  const value = payload[key];
  if (value === undefined) return [];
  if (
    !Array.isArray(value)
    || value.some((item) => typeof item !== "string" || !item.trim())
  ) {
    throw new Error(`${key} must be an array of non-empty strings`);
  }
  return value as string[];
}

function addOption(
  args: string[],
  option: string,
  value: string | undefined,
): void {
  if (value !== undefined) args.push(option, value);
}

function addRepeatedOption(
  args: string[],
  option: string,
  values: string[],
): void {
  for (const value of values) args.push(option, value);
}

function boundedLimit(payload: Record<string, unknown>): number {
  const limit = integerValue(payload, "limit", false) ?? 30;
  return Math.min(limit, MAX_LIMIT);
}

function parseOutput(output: string): unknown {
  const trimmed = output.trim();
  if (!trimmed) return { success: true };
  try {
    return JSON.parse(trimmed);
  } catch {
    return { output: trimmed };
  }
}

function operationTitle(operation: GitHubWriteOperation): string {
  return operation
    .split("_")
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

function hasAny(
  payload: Record<string, unknown>,
  keys: string[],
): boolean {
  return keys.some((key) => payload[key] !== undefined);
}

function assertAllowedKeys(
  payload: Record<string, unknown>,
  allowed: string[],
): void {
  const unexpected = Object.keys(payload).filter(
    (key) => !allowed.includes(key),
  );
  if (unexpected.length > 0) {
    throw new Error(`Unsupported payload field: ${unexpected[0]}`);
  }
}

function gitRefValue(
  payload: Record<string, unknown>,
  key: string,
  required = true,
): string | undefined {
  const value = stringValue(payload, key, { required });
  if (value === undefined) return undefined;
  if (
    !NAME_PATTERN.test(value)
    || value.startsWith("/")
    || value.endsWith("/")
    || value.startsWith(".")
    || value.endsWith(".")
    || value.endsWith(".lock")
    || value.includes("..")
    || value.includes("@{")
    || value.includes("//")
  ) {
    throw new Error(`${key} is not a safe Git ref`);
  }
  return value;
}

export class GitHubService {
  private readonly runner: (
    command: string,
    args: string[],
  ) => Promise<string>;
  private confirm: ((plan: GitHubWritePlan) => Promise<boolean>) | null;
  private readonly projectRoots: string[];
  private login: string | null = null;

  constructor(options: GitHubServiceOptions = {}) {
    this.runner = options.runner ?? defaultRunner;
    this.confirm = options.confirm ?? null;
    this.projectRoots = (options.projectRoots ?? defaultProjectRoots())
      .map((root) => path.resolve(root));
  }

  setConfirmationHandler(
    confirm: ((plan: GitHubWritePlan) => Promise<boolean>) | null,
  ): void {
    this.confirm = confirm;
  }

  async read(
    operation: GitHubReadOperation,
    repository: string | undefined,
    payloadValue: unknown,
  ): Promise<unknown> {
    const payload = objectPayload(payloadValue);
    const login = await this.getLogin();
    if (operation === "list_repositories") {
      return parseOutput(await this.runner("gh", [
        "repo",
        "list",
        login,
        "--limit",
        String(boundedLimit(payload)),
        "--json",
        "nameWithOwner,description,isPrivate,isArchived,defaultBranchRef,url,updatedAt",
      ]));
    }
    const repo = this.normalizeOwnedRepository(repository, login);
    const number = integerValue(payload, "number", false);
    let args: string[];
    switch (operation) {
      case "get_repository":
        args = [
          "repo",
          "view",
          repo,
          "--json",
          "nameWithOwner,description,isPrivate,isArchived,defaultBranchRef,url,homepageUrl,licenseInfo,repositoryTopics,viewerPermission",
        ];
        break;
      case "list_issues":
        args = [
          "issue",
          "list",
          "--repo",
          repo,
          "--state",
          stringValue(payload, "state") ?? "all",
          "--limit",
          String(boundedLimit(payload)),
          "--json",
          "number,title,state,author,assignees,labels,createdAt,updatedAt,url",
        ];
        break;
      case "get_issue":
        args = [
          "issue",
          "view",
          String(number ?? integerValue(payload, "number")),
          "--repo",
          repo,
          "--json",
          "number,title,body,state,author,assignees,labels,comments,createdAt,updatedAt,url",
        ];
        break;
      case "list_pull_requests":
        args = [
          "pr",
          "list",
          "--repo",
          repo,
          "--state",
          stringValue(payload, "state") ?? "all",
          "--limit",
          String(boundedLimit(payload)),
          "--json",
          "number,title,state,isDraft,author,headRefName,baseRefName,reviewDecision,statusCheckRollup,updatedAt,url",
        ];
        break;
      case "get_pull_request":
        args = [
          "pr",
          "view",
          String(number ?? integerValue(payload, "number")),
          "--repo",
          repo,
          "--json",
          "number,title,body,state,isDraft,author,headRefName,baseRefName,mergeable,reviewDecision,reviews,comments,statusCheckRollup,files,commits,updatedAt,url",
        ];
        break;
      case "list_branches":
        args = [
          "api",
          "--method",
          "GET",
          `repos/${repo}/branches`,
          "-f",
          `per_page=${boundedLimit(payload)}`,
        ];
        break;
      case "list_releases":
        args = [
          "release",
          "list",
          "--repo",
          repo,
          "--limit",
          String(boundedLimit(payload)),
          "--json",
          "tagName,name,isDraft,isPrerelease,isLatest,publishedAt,createdAt",
        ];
        break;
      case "list_workflow_runs":
        args = [
          "run",
          "list",
          "--repo",
          repo,
          "--limit",
          String(boundedLimit(payload)),
          "--json",
          "databaseId,name,workflowName,status,conclusion,event,headBranch,headSha,createdAt,updatedAt,url",
        ];
        break;
      default:
        throw new Error(`Unsupported GitHub read operation: ${operation}`);
    }
    return parseOutput(await this.runner("gh", args));
  }

  async write(
    operation: GitHubWriteOperation,
    repository: string,
    payloadValue: unknown,
    confirmOverride?: (plan: GitHubWritePlan) => Promise<boolean>,
  ): Promise<unknown> {
    const payload = objectPayload(payloadValue);
    const login = await this.getLogin();
    const repo = this.normalizeOwnedRepository(repository, login);
    this.validateWritePayload(operation, payload);
    const cloneDestination = operation === "repository_clone"
      ? await this.resolveCloneDestination(repo, payload)
      : undefined;
    const planPayload = cloneDestination
      ? { ...payload, destination: cloneDestination }
      : payload;
    const plan: GitHubWritePlan = {
      operation,
      repository: repo,
      title: `${operationTitle(operation)} on ${repo}`,
      detail: this.describeWrite(operation, planPayload),
      payload: planPayload,
    };
    const confirm = confirmOverride ?? this.confirm;
    if (!confirm) {
      throw new Error("GitHub write confirmation is not available");
    }
    if (!await confirm(plan)) {
      return { cancelled: true, operation, repository: repo };
    }
    this.validateWritePayload(operation, payload);
    if (cloneDestination) {
      const revalidatedDestination = await this.resolveCloneDestination(
        repo,
        payload,
      );
      if (revalidatedDestination !== cloneDestination) {
        throw new Error("Clone destination changed before confirmation");
      }
    }
    if (cloneDestination) {
      await this.runner("gh", [
        "repo",
        "clone",
        repo,
        cloneDestination,
      ]);
      return {
        success: true,
        repository: repo,
        destination: cloneDestination,
      };
    }
    return parseOutput(await this.executeWrite(operation, repo, payload));
  }

  private async getLogin(): Promise<string> {
    if (this.login) return this.login;
    const login = (
      await this.runner("gh", ["api", "user", "--jq", ".login"])
    ).trim();
    if (!login) throw new Error("GitHub CLI returned an empty account login");
    this.login = login;
    return login;
  }

  private validateRepository(
    repository: string | undefined,
    login: string,
  ): string {
    if (!repository || !REPOSITORY_PATTERN.test(repository)) {
      throw new Error("repository must use the owner/name format");
    }
    const [owner] = repository.split("/");
    if (owner.toLowerCase() !== login.toLowerCase()) {
      throw new Error(
        `GitHub repository must be owned by the active account ${login}`,
      );
    }
    return repository;
  }

  private normalizeOwnedRepository(
    repository: string | undefined,
    login: string,
  ): string {
    if (!repository) {
      throw new Error("repository must use a short name or owner/name format");
    }
    if (/^[A-Za-z0-9_.-]+$/.test(repository)) {
      return `${login}/${repository}`;
    }
    return this.validateRepository(repository, login);
  }

  private async resolveCloneDestination(
    repository: string,
    payload: Record<string, unknown>,
  ): Promise<string> {
    const requestedRoot = stringValue(payload, "root");
    const configuredRoot = requestedRoot
      ? path.resolve(requestedRoot.replace(/^~(?=$|\/)/, os.homedir()))
      : this.projectRoots[0];
    if (!this.projectRoots.includes(configuredRoot)) {
      throw new Error("Clone destination must be an approved project root");
    }
    const root = await realpath(configuredRoot);
    const repositoryName = repository.split("/")[1];
    const destination = path.join(root, repositoryName);
    try {
      await lstat(destination);
      throw new Error(`Clone destination already exists: ${destination}`);
    } catch (error) {
      if (
        error instanceof Error
        && "code" in error
        && error.code === "ENOENT"
      ) {
        return destination;
      }
      throw error;
    }
  }

  private describeWrite(
    operation: GitHubWriteOperation,
    payload: Record<string, unknown>,
  ): string {
    const lines = [`Operation: ${operation}`];
    for (const [key, value] of Object.entries(payload)) {
      const rendered = typeof value === "string"
        ? value
        : JSON.stringify(value);
      lines.push(`${key}: ${rendered.slice(0, 1_000)}`);
    }
    return lines.join("\n");
  }

  private validateWritePayload(
    operation: GitHubWriteOperation,
    payload: Record<string, unknown>,
  ): void {
    switch (operation) {
      case "issue_create":
        assertAllowedKeys(payload, ["title", "body", "labels", "assignees"]);
        stringValue(payload, "title", { required: true });
        stringValue(payload, "body", { required: true, allowEmpty: true });
        stringArray(payload, "labels");
        stringArray(payload, "assignees");
        break;
      case "issue_edit":
        assertAllowedKeys(payload, [
          "number",
          "title",
          "body",
          "addLabels",
          "removeLabels",
          "addAssignees",
          "removeAssignees",
        ]);
        integerValue(payload, "number");
        if (!hasAny(payload, [
          "title",
          "body",
          "addLabels",
          "removeLabels",
          "addAssignees",
          "removeAssignees",
        ])) {
          throw new Error("issue_edit has no changes");
        }
        stringValue(payload, "title");
        stringValue(payload, "body", { allowEmpty: true });
        stringArray(payload, "addLabels");
        stringArray(payload, "removeLabels");
        stringArray(payload, "addAssignees");
        stringArray(payload, "removeAssignees");
        break;
      case "pull_request_edit":
        assertAllowedKeys(payload, [
          "number",
          "title",
          "body",
          "base",
          "addLabels",
          "removeLabels",
          "addReviewers",
          "removeReviewers",
        ]);
        integerValue(payload, "number");
        if (!hasAny(payload, [
          "title",
          "body",
          "base",
          "addLabels",
          "removeLabels",
          "addReviewers",
          "removeReviewers",
        ])) {
          throw new Error("pull_request_edit has no changes");
        }
        stringValue(payload, "title");
        stringValue(payload, "body", { allowEmpty: true });
        gitRefValue(payload, "base", false);
        stringArray(payload, "addLabels");
        stringArray(payload, "removeLabels");
        stringArray(payload, "addReviewers");
        stringArray(payload, "removeReviewers");
        break;
      case "issue_comment":
      case "pull_request_comment":
        assertAllowedKeys(payload, ["number", "body"]);
        integerValue(payload, "number");
        stringValue(payload, "body", { required: true });
        break;
      case "issue_close":
      case "issue_reopen":
        assertAllowedKeys(payload, ["number"]);
        integerValue(payload, "number");
        break;
      case "pull_request_ready":
        assertAllowedKeys(payload, ["number", "ready"]);
        integerValue(payload, "number");
        booleanValue(payload, "ready");
        break;
      case "pull_request_create":
        assertAllowedKeys(payload, [
          "title",
          "body",
          "head",
          "base",
          "draft",
          "labels",
          "reviewers",
        ]);
        stringValue(payload, "title", { required: true });
        stringValue(payload, "body", { required: true, allowEmpty: true });
        gitRefValue(payload, "head");
        gitRefValue(payload, "base");
        booleanValue(payload, "draft");
        stringArray(payload, "labels");
        stringArray(payload, "reviewers");
        break;
      case "pull_request_review": {
        assertAllowedKeys(payload, ["number", "action", "body"]);
        integerValue(payload, "number");
        const action = stringValue(payload, "action", { required: true });
        if (!["approve", "request_changes", "comment"].includes(action!)) {
          throw new Error(
            "action must be approve, request_changes, or comment",
          );
        }
        const body = stringValue(payload, "body", { allowEmpty: true });
        if (action === "request_changes" && !body?.trim()) {
          throw new Error("body is required when requesting changes");
        }
        break;
      }
      case "branch_create":
        assertAllowedKeys(payload, ["branch", "fromRef"]);
        gitRefValue(payload, "branch");
        gitRefValue(payload, "fromRef", false);
        break;
      case "branch_delete":
        assertAllowedKeys(payload, ["branch"]);
        gitRefValue(payload, "branch");
        break;
      case "pull_request_merge": {
        assertAllowedKeys(payload, ["number", "method", "deleteBranch"]);
        integerValue(payload, "number");
        const method = stringValue(payload, "method") ?? "squash";
        if (!["merge", "squash", "rebase"].includes(method)) {
          throw new Error("method must be merge, squash, or rebase");
        }
        booleanValue(payload, "deleteBranch");
        break;
      }
      case "release_create":
        assertAllowedKeys(payload, [
          "tag",
          "title",
          "notes",
          "target",
          "draft",
          "prerelease",
        ]);
        stringValue(payload, "tag", { required: true });
        stringValue(payload, "title", { required: true });
        stringValue(payload, "notes", { required: true, allowEmpty: true });
        stringValue(payload, "target");
        booleanValue(payload, "draft");
        booleanValue(payload, "prerelease");
        break;
      case "release_edit":
        assertAllowedKeys(payload, [
          "tag",
          "title",
          "notes",
          "target",
          "draft",
          "prerelease",
        ]);
        stringValue(payload, "tag", { required: true });
        if (!hasAny(payload, [
          "title",
          "notes",
          "target",
          "draft",
          "prerelease",
        ])) {
          throw new Error("release_edit has no changes");
        }
        stringValue(payload, "title");
        stringValue(payload, "notes", { allowEmpty: true });
        stringValue(payload, "target");
        booleanValue(payload, "draft");
        booleanValue(payload, "prerelease");
        break;
      case "release_delete":
        assertAllowedKeys(payload, ["tag", "cleanupTag"]);
        stringValue(payload, "tag", { required: true });
        booleanValue(payload, "cleanupTag");
        break;
      case "workflow_dispatch": {
        assertAllowedKeys(payload, ["workflow", "ref", "fields"]);
        const workflow = stringValue(payload, "workflow", { required: true })!;
        if (!NAME_PATTERN.test(workflow)) {
          throw new Error("workflow contains unsupported characters");
        }
        gitRefValue(payload, "ref", false);
        if (payload.fields !== undefined) {
          const fields = objectPayload(payload.fields);
          for (const [key, value] of Object.entries(fields)) {
            if (
              !/^[A-Za-z0-9_.-]+$/.test(key)
              || !["string", "number", "boolean"].includes(typeof value)
            ) {
              throw new Error(
                "workflow fields must contain primitive values and safe keys",
              );
            }
          }
        }
        break;
      }
      case "workflow_run_rerun":
        assertAllowedKeys(payload, ["runId", "failedOnly"]);
        integerValue(payload, "runId");
        booleanValue(payload, "failedOnly");
        break;
      case "workflow_run_cancel":
        assertAllowedKeys(payload, ["runId"]);
        integerValue(payload, "runId");
        break;
      case "repository_clone":
        assertAllowedKeys(payload, ["root"]);
        stringValue(payload, "root");
        break;
      default:
        throw new Error(`Unsupported GitHub write operation: ${operation}`);
    }
  }

  private async executeWrite(
    operation: GitHubWriteOperation,
    repo: string,
    payload: Record<string, unknown>,
  ): Promise<string> {
    const number = integerValue(payload, "number", false);
    let args: string[];
    switch (operation) {
      case "issue_create":
        args = [
          "issue",
          "create",
          "--repo",
          repo,
          "--title",
          stringValue(payload, "title", { required: true })!,
          "--body",
          stringValue(payload, "body", {
            required: true,
            allowEmpty: true,
          })!,
        ];
        addRepeatedOption(args, "--label", stringArray(payload, "labels"));
        addRepeatedOption(args, "--assignee", stringArray(payload, "assignees"));
        break;
      case "issue_edit":
        args = [
          "issue",
          "edit",
          String(number ?? integerValue(payload, "number")),
          "--repo",
          repo,
        ];
        addOption(args, "--title", stringValue(payload, "title"));
        addOption(args, "--body", stringValue(payload, "body", {
          allowEmpty: true,
        }));
        addRepeatedOption(args, "--add-label", stringArray(payload, "addLabels"));
        addRepeatedOption(
          args,
          "--remove-label",
          stringArray(payload, "removeLabels"),
        );
        addRepeatedOption(
          args,
          "--add-assignee",
          stringArray(payload, "addAssignees"),
        );
        addRepeatedOption(
          args,
          "--remove-assignee",
          stringArray(payload, "removeAssignees"),
        );
        if (args.length === 5) throw new Error("issue_edit has no changes");
        break;
      case "issue_comment":
        args = [
          "issue",
          "comment",
          String(number ?? integerValue(payload, "number")),
          "--repo",
          repo,
          "--body",
          stringValue(payload, "body", { required: true })!,
        ];
        break;
      case "issue_close":
      case "issue_reopen":
        args = [
          "issue",
          operation === "issue_close" ? "close" : "reopen",
          String(number ?? integerValue(payload, "number")),
          "--repo",
          repo,
        ];
        break;
      case "pull_request_create":
        args = [
          "pr",
          "create",
          "--repo",
          repo,
          "--title",
          stringValue(payload, "title", { required: true })!,
          "--body",
          stringValue(payload, "body", {
            required: true,
            allowEmpty: true,
          })!,
          "--head",
          stringValue(payload, "head", { required: true })!,
          "--base",
          stringValue(payload, "base", { required: true })!,
        ];
        if (booleanValue(payload, "draft")) args.push("--draft");
        addRepeatedOption(args, "--label", stringArray(payload, "labels"));
        addRepeatedOption(args, "--reviewer", stringArray(payload, "reviewers"));
        break;
      case "pull_request_edit":
        args = [
          "pr",
          "edit",
          String(number ?? integerValue(payload, "number")),
          "--repo",
          repo,
        ];
        addOption(args, "--title", stringValue(payload, "title"));
        addOption(args, "--body", stringValue(payload, "body", {
          allowEmpty: true,
        }));
        addOption(args, "--base", stringValue(payload, "base"));
        addRepeatedOption(args, "--add-label", stringArray(payload, "addLabels"));
        addRepeatedOption(
          args,
          "--remove-label",
          stringArray(payload, "removeLabels"),
        );
        addRepeatedOption(
          args,
          "--add-reviewer",
          stringArray(payload, "addReviewers"),
        );
        addRepeatedOption(
          args,
          "--remove-reviewer",
          stringArray(payload, "removeReviewers"),
        );
        if (args.length === 5) {
          throw new Error("pull_request_edit has no changes");
        }
        break;
      case "pull_request_comment":
        args = [
          "pr",
          "comment",
          String(number ?? integerValue(payload, "number")),
          "--repo",
          repo,
          "--body",
          stringValue(payload, "body", { required: true })!,
        ];
        break;
      case "pull_request_review": {
        const action = stringValue(payload, "action", { required: true });
        if (!["approve", "request_changes", "comment"].includes(action!)) {
          throw new Error(
            "action must be approve, request_changes, or comment",
          );
        }
        args = [
          "pr",
          "review",
          String(number ?? integerValue(payload, "number")),
          "--repo",
          repo,
          action === "approve"
            ? "--approve"
            : action === "request_changes"
              ? "--request-changes"
              : "--comment",
        ];
        addOption(args, "--body", stringValue(payload, "body", {
          allowEmpty: true,
        }));
        break;
      }
      case "pull_request_ready":
        args = [
          "pr",
          "ready",
          String(number ?? integerValue(payload, "number")),
          "--repo",
          repo,
        ];
        if (booleanValue(payload, "ready") === false) args.push("--undo");
        break;
      case "branch_create": {
        const branch = gitRefValue(payload, "branch")!;
        const fromRef = gitRefValue(payload, "fromRef", false)
          ?? (
            await this.runner("gh", [
              "repo",
              "view",
              repo,
              "--json",
              "defaultBranchRef",
              "--jq",
              ".defaultBranchRef.name",
            ])
          ).trim();
        if (!fromRef) {
          throw new Error("Unable to resolve the repository default branch");
        }
        const sha = (
          await this.runner("gh", [
            "api",
            `repos/${repo}/git/ref/heads/${fromRef}`,
            "--jq",
            ".object.sha",
          ])
        ).trim();
        if (!sha) throw new Error(`Unable to resolve source ref ${fromRef}`);
        args = [
          "api",
          "--method",
          "POST",
          `repos/${repo}/git/refs`,
          "-f",
          `ref=refs/heads/${branch}`,
          "-f",
          `sha=${sha}`,
        ];
        break;
      }
      case "branch_delete": {
        const branch = gitRefValue(payload, "branch")!;
        args = [
          "api",
          "--method",
          "DELETE",
          `repos/${repo}/git/refs/heads/${branch}`,
        ];
        break;
      }
      case "pull_request_merge": {
        const method = stringValue(payload, "method") ?? "squash";
        if (!["merge", "squash", "rebase"].includes(method)) {
          throw new Error("method must be merge, squash, or rebase");
        }
        args = [
          "pr",
          "merge",
          String(number ?? integerValue(payload, "number")),
          "--repo",
          repo,
          `--${method}`,
        ];
        if (booleanValue(payload, "deleteBranch")) args.push("--delete-branch");
        break;
      }
      case "release_create":
        args = [
          "release",
          "create",
          stringValue(payload, "tag", { required: true })!,
          "--repo",
          repo,
          "--title",
          stringValue(payload, "title", { required: true })!,
          "--notes",
          stringValue(payload, "notes", {
            required: true,
            allowEmpty: true,
          })!,
        ];
        addOption(args, "--target", stringValue(payload, "target"));
        if (booleanValue(payload, "draft")) args.push("--draft");
        if (booleanValue(payload, "prerelease")) args.push("--prerelease");
        break;
      case "release_edit":
        args = [
          "release",
          "edit",
          stringValue(payload, "tag", { required: true })!,
          "--repo",
          repo,
        ];
        addOption(args, "--title", stringValue(payload, "title"));
        addOption(args, "--notes", stringValue(payload, "notes", {
          allowEmpty: true,
        }));
        addOption(args, "--target", stringValue(payload, "target"));
        if (booleanValue(payload, "draft") !== undefined) {
          args.push(
            booleanValue(payload, "draft") ? "--draft" : "--draft=false",
          );
        }
        if (booleanValue(payload, "prerelease") !== undefined) {
          args.push(
            booleanValue(payload, "prerelease")
              ? "--prerelease"
              : "--prerelease=false",
          );
        }
        if (args.length === 5) throw new Error("release_edit has no changes");
        break;
      case "release_delete":
        args = [
          "release",
          "delete",
          stringValue(payload, "tag", { required: true })!,
          "--repo",
          repo,
          "--yes",
        ];
        if (booleanValue(payload, "cleanupTag")) args.push("--cleanup-tag");
        break;
      case "workflow_dispatch": {
        const workflow = stringValue(payload, "workflow", { required: true })!;
        if (!NAME_PATTERN.test(workflow)) {
          throw new Error("workflow contains unsupported characters");
        }
        args = ["workflow", "run", workflow, "--repo", repo];
        addOption(args, "--ref", stringValue(payload, "ref"));
        const fields = payload.fields;
        if (fields !== undefined) {
          const record = objectPayload(fields);
          for (const [key, value] of Object.entries(record)) {
            if (
              !/^[A-Za-z0-9_.-]+$/.test(key)
              || !["string", "number", "boolean"].includes(typeof value)
            ) {
              throw new Error(
                "workflow fields must contain primitive values and safe keys",
              );
            }
            args.push("-f", `${key}=${String(value)}`);
          }
        }
        break;
      }
      case "workflow_run_rerun":
        args = [
          "run",
          "rerun",
          String(integerValue(payload, "runId")),
          "--repo",
          repo,
        ];
        if (booleanValue(payload, "failedOnly")) args.push("--failed");
        break;
      case "workflow_run_cancel":
        args = [
          "run",
          "cancel",
          String(integerValue(payload, "runId")),
          "--repo",
          repo,
        ];
        break;
      default:
        throw new Error(`Unsupported GitHub write operation: ${operation}`);
    }
    return this.runner("gh", args);
  }
}

export const githubService = new GitHubService();
