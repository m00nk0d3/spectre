import os from "node:os";
import {
  appendObsidianNote,
  readObsidianNote,
  searchObsidianVault,
} from "./obsidian-vault";

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

export async function executeSpectreTool(
  name: string,
  rawArguments: string,
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
    return JSON.stringify(await appendObsidianNote(
      args.path as string | undefined,
      args.content,
    ));
  }

  throw new Error(`Unknown Spectre tool: ${name}`);
}
