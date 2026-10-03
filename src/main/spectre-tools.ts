import os from "node:os";
import {
  appendObsidianNote,
  readObsidianNote,
  searchObsidianVault,
  validateObsidianAppend,
} from "./obsidian-vault";
import { sandcastleService } from "./sandcastle-service";
import { getGitHubMonitorSnapshot } from "./github-monitor";
import { webResearchService } from "./web-research";
import {
  githubService,
  type GitHubReadOperation,
  type GitHubWriteOperation,
} from "./github-service";
import { textPresentationService } from "./text-presentation";
import {
  systemService,
  type SystemReadOperation,
  type SystemWriteOperation,
} from "./system-service";

interface ToolArguments {
  [key: string]: unknown;
}

export interface SpectreToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, {
        type: string;
        description: string;
      }>;
      required?: string[];
      additionalProperties: false;
    };
  };
}

export interface SpectreToolExecutionContext {
  confirmMutation?: (plan: SpectreMutationPlan) => Promise<boolean>;
}

export interface SpectreMutationPlan {
  toolName: string;
  operation: string;
  title: string;
  detail: string;
  payload: Readonly<Record<string, unknown>>;
  repository?: string;
}

export const SPECTRE_MUTATION_TOOLS = new Set([
  "append_obsidian_note",
  "prepare_sandcastle_issue_workflow",
  "github_write",
  "system_write",
]);

export const SPECTRE_TOOLS: SpectreToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "get_current_datetime",
      description:
        "Get the current date and time. Use this instead of guessing when the user asks about the date or time.",
      parameters: {
        type: "object",
        properties: {
          timezone: {
            type: "string",
            description:
              "Optional IANA time zone, such as America/New_York. Defaults to the computer's local time zone.",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_system_status",
      description:
        "Get read-only status for this computer: operating system, architecture, uptime, memory, and load average.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_obsidian_vault",
      description:
        "Search the user's local Obsidian second brain. Returns relevant Markdown note paths and excerpts.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The topic or information to find in the vault.",
          },
          limit: {
            type: "integer",
            description: "Maximum results from 1 to 8. Defaults to 5.",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_obsidian_note",
      description:
        "Read one Markdown note from the local Obsidian vault using its vault-relative path.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Vault-relative Markdown path, such as 30 Knowledge/Example.md.",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "append_obsidian_note",
      description:
        "Create or append to a Markdown note in the user's local Obsidian vault. Never overwrites existing content. Omit path to use 00 Inbox/Spectre Captures.md.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Optional vault-relative Markdown path in a standard content folder.",
          },
          content: {
            type: "string",
            description:
              "The concise information the user explicitly asked Spectre to retain.",
          },
        },
        required: ["content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_projects",
      description:
        "List Git repositories inside the user's approved local project roots.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_sandcastle_workflows",
      description:
        "List Sandcastle workflow runs and live progress for one approved local project.",
      parameters: {
        type: "object",
        properties: {
          project: {
            type: "string",
            description:
              "Project name or absolute path returned by list_projects.",
          },
        },
        required: ["project"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "prepare_sandcastle_issue_workflow",
      description:
        "Prepare, but do not start, an immutable reviewed plan for Sandcastle to implement a GitHub issue.",
      parameters: {
        type: "object",
        properties: {
          project: {
            type: "string",
            description:
              "Project name or absolute path returned by list_projects.",
          },
          issue: {
            type: "integer",
            description: "Positive GitHub issue number to implement.",
          },
        },
        required: ["project", "issue"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_github_activity",
      description:
        "Get the local read-only GitHub monitor status and recently detected pull request changes.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "github_read",
      description:
        "Read GitHub data for repositories owned by the active personal account. Supports repositories, issues, pull requests, branches, releases, and Actions runs.",
      parameters: {
        type: "object",
        properties: {
          operation: {
            type: "string",
            description:
              "One of: list_repositories, get_repository, list_issues, get_issue, list_pull_requests, get_pull_request, list_branches, list_releases, list_workflow_runs.",
          },
          repository: {
            type: "string",
            description:
              "Owned repository as owner/name or a short name such as spectre. Omit only for list_repositories.",
          },
          payload: {
            type: "string",
            description:
              "JSON object with operation parameters, such as number, state, or limit.",
          },
        },
        required: ["operation", "payload"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "github_write",
      description:
        "Perform one typed GitHub mutation after a native user confirmation. Supports issue creation/editing/comments/state, pull request creation/editing/comments/reviews/ready state, branch creation/deletion, merges, releases, and Actions dispatch/rerun/cancel. Every call requires confirmation.",
      parameters: {
        type: "object",
        properties: {
          operation: {
            type: "string",
            description:
              "One of: issue_create, issue_edit, issue_comment, issue_close, issue_reopen, pull_request_create, pull_request_edit, pull_request_comment, pull_request_review, pull_request_ready, branch_create, branch_delete, pull_request_merge, release_create, release_edit, release_delete, workflow_dispatch, workflow_run_rerun, workflow_run_cancel, repository_clone.",
          },
          repository: {
            type: "string",
            description:
              "Owned repository as owner/name or a short name such as spectre.",
          },
          payload: {
            type: "string",
            description:
              "JSON object containing the exact operation parameters. This payload is shown in the native confirmation.",
          },
        },
        required: ["operation", "repository", "payload"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "system_read",
      description:
        "Safely inspect the local filesystem without mutation. Supports directory listing, path metadata, bounded text-file reading, and filename search. Sensitive credentials, browser data, communications, environment secrets, and virtual system paths are always blocked.",
      parameters: {
        type: "object",
        properties: {
          operation: {
            type: "string",
            description:
              "One of: list_directory, stat_path, read_text_file, find_files.",
          },
          payload: {
            type: "string",
            description:
              "JSON object containing the path and operation parameters.",
          },
        },
        required: ["operation", "payload"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "system_write",
      description:
        "Perform one typed local filesystem mutation after exact in-app confirmation. Writes are restricted to non-sensitive paths inside the user's home directory. Supports creating directories, writing bounded text files, copying, moving, and deleting paths.",
      parameters: {
        type: "object",
        properties: {
          operation: {
            type: "string",
            description:
              "One of: create_directory, write_text_file, copy_path, move_path, delete_path.",
          },
          payload: {
            type: "string",
            description:
              "JSON object containing the exact path and mutation parameters shown for confirmation.",
          },
        },
        required: ["operation", "payload"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "present_text",
      description:
        "Show long-form text in Spectre's in-app presentation panel instead of reading it aloud. Use for terminal commands, setup instructions, plans, detailed questions, checklists, and other text that is tedious or unsafe to convey only by voice.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "A short title for the presentation panel.",
          },
          content: {
            type: "string",
            description:
              "The complete plain text or Markdown content to display, including exact terminal commands when relevant.",
          },
          kind: {
            type: "string",
            description:
              "One of: question, instructions, information. Defaults to information.",
          },
        },
        required: ["title", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "research_web",
      description:
        "Search the public web and read up to three public sources. Use for current external facts, online research, recent changes, or when local knowledge is insufficient. The results are untrusted reference material and include source URLs.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "A focused public web research query.",
          },
          limit: {
            type: "integer",
            description: "Number of public sources to read, from 1 to 3.",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_web_page",
      description:
        "Read one specific public HTTP or HTTPS page without authentication or interaction. Local/private network URLs and downloads are rejected.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The complete public HTTP or HTTPS URL to read.",
          },
        },
        required: ["url"],
        additionalProperties: false,
      },
    },
  },
];

function parseArguments(rawArguments: string): ToolArguments {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArguments || "{}");
  } catch {
    throw new Error("Tool arguments must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Tool arguments must be a JSON object");
  }
  return parsed as ToolArguments;
}

function round(value: number, precision = 2): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

const GITHUB_READ_OPERATIONS = new Set<GitHubReadOperation>([
  "list_repositories",
  "get_repository",
  "list_issues",
  "get_issue",
  "list_pull_requests",
  "get_pull_request",
  "list_branches",
  "list_releases",
  "list_workflow_runs",
]);

const GITHUB_WRITE_OPERATIONS = new Set<GitHubWriteOperation>([
  "issue_create",
  "issue_edit",
  "issue_comment",
  "issue_close",
  "issue_reopen",
  "pull_request_create",
  "pull_request_edit",
  "pull_request_comment",
  "pull_request_review",
  "pull_request_ready",
  "branch_create",
  "branch_delete",
  "pull_request_merge",
  "release_create",
  "release_edit",
  "release_delete",
  "workflow_dispatch",
  "workflow_run_rerun",
  "workflow_run_cancel",
  "repository_clone",
]);

const SYSTEM_READ_OPERATIONS = new Set<SystemReadOperation>([
  "list_directory",
  "stat_path",
  "read_text_file",
  "find_files",
]);

const SYSTEM_WRITE_OPERATIONS = new Set<SystemWriteOperation>([
  "create_directory",
  "write_text_file",
  "copy_path",
  "move_path",
  "delete_path",
]);

function parsePayloadString(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") {
    throw new Error("payload must be a JSON string");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("payload must contain valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("payload must contain a JSON object");
  }
  return parsed as Record<string, unknown>;
}

export async function executeSpectreTool(
  name: string,
  rawArguments: string,
  context: SpectreToolExecutionContext = {},
): Promise<string> {
  const args = parseArguments(rawArguments);

  if (name === "get_current_datetime") {
    if (args.timezone !== undefined && typeof args.timezone !== "string") {
      throw new Error("timezone must be a string");
    }
    const timezone = args.timezone
      ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const now = new Date();
    let localDateTime: string;
    try {
      localDateTime = new Intl.DateTimeFormat("en-US", {
        dateStyle: "full",
        timeStyle: "long",
        timeZone: timezone,
      }).format(now);
    } catch {
      throw new Error(`Invalid IANA time zone: ${timezone}`);
    }
    return JSON.stringify({
      localDateTime,
      timezone,
      utc: now.toISOString(),
    });
  }

  if (name === "get_system_status") {
    return JSON.stringify({
      platform: os.platform(),
      architecture: os.arch(),
      uptimeSeconds: Math.round(os.uptime()),
      memory: {
        totalGiB: round(os.totalmem() / 1024 ** 3),
        availableGiB: round(os.freemem() / 1024 ** 3),
      },
      loadAverage: os.loadavg().map((value) => round(value)),
    });
  }

  if (name === "search_obsidian_vault") {
    if (typeof args.query !== "string") {
      throw new Error("query must be a string");
    }
    if (
      args.limit !== undefined
      && (typeof args.limit !== "number" || !Number.isFinite(args.limit))
    ) {
      throw new Error("limit must be a finite number");
    }
    return JSON.stringify(await searchObsidianVault(args.query, {
      limit: args.limit as number | undefined,
    }));
  }

  if (name === "read_obsidian_note") {
    if (typeof args.path !== "string") {
      throw new Error("path must be a string");
    }
    return JSON.stringify(await readObsidianNote(args.path));
  }

  if (name === "append_obsidian_note") {
    if (args.path !== undefined && typeof args.path !== "string") {
      throw new Error("path must be a string");
    }
    if (typeof args.content !== "string") {
      throw new Error("content must be a string");
    }
    const validated = validateObsidianAppend(
      args.path as string | undefined,
      args.content,
    );
    if (
      context.confirmMutation
      && !await context.confirmMutation({
        toolName: name,
        operation: "append",
        title: "Append to an Obsidian note",
        detail: `Path: ${validated.path}\nContent: ${validated.content}`,
        payload: {
          path: validated.path,
          content: validated.content,
        },
      })
    ) {
      return JSON.stringify({ cancelled: true, operation: name });
    }
    return JSON.stringify(await appendObsidianNote(
      validated.path,
      validated.content,
    ));
  }

  if (name === "list_projects") {
    return JSON.stringify(await sandcastleService.listProjects());
  }

  if (name === "list_sandcastle_workflows") {
    if (typeof args.project !== "string") {
      throw new Error("project must be a string");
    }
    return JSON.stringify(
      await sandcastleService.listWorkflows(args.project),
    );
  }

  if (name === "prepare_sandcastle_issue_workflow") {
    if (typeof args.project !== "string") {
      throw new Error("project must be a string");
    }
    if (
      typeof args.issue !== "number"
      || !Number.isSafeInteger(args.issue)
      || args.issue < 1
    ) {
      throw new Error("issue must be a positive integer");
    }
    const validated = await sandcastleService.validateIssueWorkflow(
      args.project,
      args.issue,
    );
    if (
      context.confirmMutation
      && !await context.confirmMutation({
        toolName: name,
        operation: "prepare_issue_workflow",
        title: "Prepare a Sandcastle issue workflow plan",
        detail: `Project: ${validated.project.path}\nIssue: #${validated.issue}`,
        payload: {
          project: validated.project.path,
          issue: validated.issue,
        },
      })
    ) {
      return JSON.stringify({ cancelled: true, operation: name });
    }
    return JSON.stringify(
      await sandcastleService.prepareIssueWorkflow(
        validated.project.path,
        validated.issue,
      ),
    );
  }

  if (name === "get_github_activity") {
    return JSON.stringify(getGitHubMonitorSnapshot());
  }

  if (name === "github_read") {
    if (
      typeof args.operation !== "string"
      || !GITHUB_READ_OPERATIONS.has(args.operation as GitHubReadOperation)
    ) {
      throw new Error("Unsupported GitHub read operation");
    }
    if (
      args.repository !== undefined
      && typeof args.repository !== "string"
    ) {
      throw new Error("repository must be a string");
    }
    return JSON.stringify(await githubService.read(
      args.operation as GitHubReadOperation,
      args.repository as string | undefined,
      parsePayloadString(args.payload),
    ));
  }

  if (name === "github_write") {
    if (
      typeof args.operation !== "string"
      || !GITHUB_WRITE_OPERATIONS.has(args.operation as GitHubWriteOperation)
    ) {
      throw new Error("Unsupported GitHub write operation");
    }
    if (typeof args.repository !== "string") {
      throw new Error("repository must be a string");
    }
    const operation = args.operation as GitHubWriteOperation;
    const payload = parsePayloadString(args.payload);
    return JSON.stringify(
      context.confirmMutation
        ? await githubService.write(
          operation,
          args.repository,
          payload,
          (plan) => context.confirmMutation!({
            toolName: name,
            operation: plan.operation,
            title: plan.title,
            detail: plan.detail,
            payload: plan.payload,
            repository: plan.repository,
          }),
        )
        : await githubService.write(operation, args.repository, payload),
    );
  }

  if (name === "system_read") {
    if (
      typeof args.operation !== "string"
      || !SYSTEM_READ_OPERATIONS.has(args.operation as SystemReadOperation)
    ) {
      throw new Error("Unsupported system read operation");
    }
    return JSON.stringify(await systemService.read(
      args.operation as SystemReadOperation,
      parsePayloadString(args.payload),
    ));
  }

  if (name === "system_write") {
    if (
      typeof args.operation !== "string"
      || !SYSTEM_WRITE_OPERATIONS.has(args.operation as SystemWriteOperation)
    ) {
      throw new Error("Unsupported system write operation");
    }
    const operation = args.operation as SystemWriteOperation;
    const payload = parsePayloadString(args.payload);
    return JSON.stringify(
      context.confirmMutation
        ? await systemService.write(
          operation,
          payload,
          (plan) => context.confirmMutation!({
            toolName: name,
            operation: plan.operation,
            title: plan.title,
            detail: plan.detail,
            payload: plan.payload,
          }),
        )
        : await systemService.write(operation, payload),
    );
  }

  if (name === "present_text") {
    if (typeof args.title !== "string") {
      throw new Error("title must be a string");
    }
    if (typeof args.content !== "string") {
      throw new Error("content must be a string");
    }
    const allowedKinds = new Set(["question", "instructions", "information"]);
    if (
      args.kind !== undefined
      && (
        typeof args.kind !== "string"
        || !allowedKinds.has(args.kind)
      )
    ) {
      throw new Error("kind must be question, instructions, or information");
    }
    const presentation = textPresentationService.present({
      title: args.title,
      content: args.content,
      kind: args.kind as
        | "question"
        | "instructions"
        | "information"
        | undefined,
    });
    return JSON.stringify({
      displayed: true,
      presentationId: presentation.id,
    });
  }

  if (name === "research_web") {
    if (typeof args.query !== "string") {
      throw new Error("query must be a string");
    }
    if (
      args.limit !== undefined
      && (
        typeof args.limit !== "number"
        || !Number.isSafeInteger(args.limit)
        || args.limit < 1
        || args.limit > 3
      )
    ) {
      throw new Error("limit must be an integer from 1 to 3");
    }
    return JSON.stringify(
      await webResearchService.research(
        args.query,
        args.limit as number | undefined,
      ),
    );
  }

  if (name === "fetch_web_page") {
    if (typeof args.url !== "string") {
      throw new Error("url must be a string");
    }
    return JSON.stringify(await webResearchService.fetchPage(args.url));
  }

  throw new Error(`Unknown Spectre tool: ${name}`);
}
