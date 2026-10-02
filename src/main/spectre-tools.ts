import os from "node:os";

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

  throw new Error(`Unknown Spectre tool: ${name}`);
}
