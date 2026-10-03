import { CONTEXT_MESSAGES } from "@/ai/messages/context";
import {
  executeSpectreTool,
  SPECTRE_TOOLS,
  type SpectreToolExecutionContext,
} from "./spectre-tools";
import { shouldPresentInEditor } from "./text-presenter";
import { createUntrustedDataEnvelope } from "./discord-security";

export interface LMStudioConfig {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  signal?: AbortSignal;
  memoryContext?: string;
  onStructuredResult?: (result: StructuredToolResult) => void | Promise<void>;
  onProgress?: (update: AgentProgressUpdate) => void | Promise<void>;
  onToolCall?: (name: string) => void | Promise<void>;
  callerPolicy?: LMStudioCallerPolicy;
}

export interface LMStudioCallerPolicy {
  allowedToolNames: readonly string[];
  additionalSystemInstructions?: string;
  toolExecutionContext?: SpectreToolExecutionContext;
  wrapUntrustedInput?: boolean;
  treatToolResultsAsUntrusted?: boolean;
  exposeToolErrors?: boolean;
}

export interface AgentProgressUpdate {
  step: number;
  message: string;
  spokenHint?: string;
}

export interface StructuredToolResult {
  title: string;
  content: string;
  spokenHint: string;
  memoryText: string;
}

interface ChatCompletionChunk {
  choices?: Array<{
    delta?: {
      content?: string;
    };
  }>;
}

interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface ToolSelectionResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: ToolCall[];
    };
  }>;
}

interface LMStudioModelsResponse {
  models?: Array<{
    type?: string;
    loaded_instances?: Array<{
      id?: string;
    }>;
  }>;
}

type ChatMessage =
  | { role: "system" | "user" | "assistant"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls: ToolCall[];
    }
  | {
      role: "tool";
      content: string;
      tool_call_id: string;
    };

const MAX_TOOL_CALLS_PER_ROUND = 4;
const MAX_TOOL_ROUNDS = 12;
const MAX_TOTAL_TOOL_CALLS = 32;
const MAX_TOOL_SELECTION_TOKENS = 768;
const MAX_RESPONSE_TOKENS = 256;

interface ToolExecutionMetadata {
  webAttempted: boolean;
  readableWebSources: string[];
  structuredResult?: StructuredToolResult;
}

const DATETIME_INTENT =
  /\b(current (?:date|time)|what (?:day|date|time)|today(?:'s)? date)\b/i;
const SYSTEM_INTENT =
  /\b(system status|computer status|uptime|load average|available memory|memory usage|operating system|system architecture)\b/i;
const DIRECTORY_LIST_INTENT =
  /\b(?:list|show|display|look at|see|what(?:'s| is) in)\b[\s\S]*\b(?:my\s+)?(home|dev|development|downloads|documents|desktop)(?:\s+(?:folder|directory))?\b/i;
const LONG_FORM_PRESENTATION_INTENT =
  /\b(?:guide|manual|reference document|documentation|tutorial|walkthrough)\b/i;
const GITHUB_CLI_GUIDE_INTENT =
  /\b(?:gh(?:\s+(?:tool|cli))?|github\s+cli)\b/i;
const VAULT_INTENT = /\b(vault|obsidian|second brain|my notes?)\b/i;
const VAULT_WRITE_INTENT =
  /\b(?:remember|save|write|add|append|capture|record|note down)\b[\s\S]*\b(?:vault|obsidian|second brain|notes?)\b|\bremember (?:that|this|my)\b/i;
const GITHUB_ACTIVITY_INTENT =
  /\b(?:github activity|new (?:pull requests?|prs?)|pull request updates?|pr updates?)\b/i;
const GITHUB_REPOSITORY_LIST_INTENT =
  /\b(?:list|show|display|look at|give me|what are|which are)\b[\s\S]*\b(?:(?:my\s+)?github\s+(?:repositories|repos)|(?:my\s+)?(?:repositories|repos)\s+(?:on|from|in)\s+github)\b/i;
const GITHUB_ISSUE_LIST_INTENT =
  /\b(?:list|show|display|look at|see|find|what are|which are)\b[\s\S]*\bissues\b/i;
const SCREEN_CORRECTION_INTENT =
  /\b(?:you didn'?t|did not|still didn'?t|not)\b[\s\S]*\b(?:put|show|display|open)\b[\s\S]*\b(?:it|that|them|those|the details?|the list)?\s*(?:on|in)\s+(?:the\s+)?screen\b|\bput (?:it|that|them|those|the details?|the list) on (?:the )?screen\b/i;
const TOOL_OUTPUT_CORRECTION_INTENT =
  /\b(?:don'?t|do not|didn'?t|not)\b[\s\S]*\btool calls?\b[\s\S]*\b(?:transcript|screen)\b|\bshowing\b[\s\S]*\btools?\b|\bresults?\b[\s\S]*\bon (?:the )?screen\b/i;
const GITHUB_REPOSITORY_CLONE_INTENT =
  /\bclone\s+(?:my\s+)?([A-Za-z0-9_.-]+)(?:\s+(?:project|repo|repository))?\s+(?:into|to)\s+(?:my\s+)?(?:dev|development)(?:\s+(?:folder|directory))?\b/i;
const WEB_RESEARCH_INTENT =
  /\b(?:web research|research\b[\s\S]*\bonline|search (?:the )?(?:web|internet|online)|look (?:this|that|it) up online|find (?:this|that|it) online|latest (?:news|release|version|information)|current (?:news|release|version|information))\b/i;
const PUBLIC_URL_PATTERN = /https?:\/\/[^\s<>"']+/i;
const ALL_TOOL_NAMES = SPECTRE_TOOLS.map((tool) => tool.function.name);
const LONG_FORM_PRESENTATION_INSTRUCTION = [
  "The application will place your entire response in a visual presentation panel.",
  "Write the complete requested guide, manual, reference, documentation, tutorial, or walkthrough now.",
  "Use clear headings, concise explanations, bullet lists, and exact examples where useful.",
  "Base factual claims on retrieved web evidence when it is provided and include the source URLs.",
  "Do not say that you prepared, displayed, opened, or placed material on screen.",
  "Do not replace the requested content with a completion acknowledgement.",
].join(" ");
export const NO_WEB_EVIDENCE_MESSAGE =
  "I couldn't access readable public sources for that research, so I won't invent or substitute unsupported information.";

export function isExplicitWebResearchRequest(prompt: string): boolean {
  return WEB_RESEARCH_INTENT.test(prompt);
}

export function isLongFormPresentationRequest(prompt: string): boolean {
  return LONG_FORM_PRESENTATION_INTENT.test(prompt);
}

export function isUsableLongFormPresentation(content: string): boolean {
  const normalized = content.trim();
  if (normalized.length < 400) return false;
  return !/\b(?:i (?:have|'ve) prepared|review (?:the )?material|on screen|for your reference|reference document outlining)\b/i
    .test(normalized);
}

function webResearchQuery(prompt: string): string {
  return prompt
    .replace(
      /^\s*(?:please\s+)?(?:do\s+(?:some\s+)?research\s+online\s+(?:on|about)|research\s+(?:this\s+)?online|search\s+(?:the\s+)?(?:web|internet|online)\s+(?:for|about)|look\s+(?:this|that|it)\s+up\s+online|find\s+(?:this|that|it)\s+online)\s*/i,
      "",
    )
    .replace(
      /\s+(?:and|then)\s+(?:tell|explain|summarize|compare|show|give)\b[\s\S]*$/i,
      "",
    )
    .replace(/[.?!]+$/, "")
    .trim() || prompt.trim();
}

function rememberedUserTurns(memoryContext?: string): string[] {
  if (!memoryContext) return [];
  return [
    ...memoryContext.matchAll(
      /^\[[^\]]+\] User: (.+)$/gm,
    ),
  ].flatMap((match) => match[1]?.trim() ? [match[1].trim()] : []);
}

function mostRecentActionableUserTurn(memoryContext?: string): string {
  const turns = rememberedUserTurns(memoryContext);
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (
      !SCREEN_CORRECTION_INTENT.test(turn)
      && !TOOL_OUTPUT_CORRECTION_INTENT.test(turn)
      && (
        GITHUB_ISSUE_LIST_INTENT.test(turn)
        || GITHUB_REPOSITORY_LIST_INTENT.test(turn)
        || /\b(?:repository|repo|pull requests?|prs?|branches|releases|workflows?)\b/i
          .test(turn)
      )
    ) {
      return turn;
    }
  }
  return "";
}

function mostRecentRememberedRepository(memoryContext?: string): string {
  if (!memoryContext) return "";
  const repositoryDetails = [
    ...memoryContext.matchAll(
      /^Repository:\s+([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\s*$/gm,
    ),
  ];
  if (repositoryDetails.length > 0) {
    return repositoryDetails.at(-1)?.[1] ?? "";
  }
  const ownedRepositories = [
    ...memoryContext.matchAll(
      /\b(m00nk0d3\/[A-Za-z0-9_.-]+)\b/g,
    ),
  ];
  return ownedRepositories.at(-1)?.[1] ?? "";
}

export function routeDirectToolCalls(
  prompt: string,
  memoryContext?: string,
): ToolCall[] {
  const toolCalls: ToolCall[] = [];
  const contextualCorrection =
    SCREEN_CORRECTION_INTENT.test(prompt)
    || TOOL_OUTPUT_CORRECTION_INTENT.test(prompt);
  const contextualPrompt = contextualCorrection
    ? mostRecentActionableUserTurn(memoryContext)
    : "";
  const routingPrompt = contextualPrompt
    ? `${contextualPrompt}\n${prompt}`
    : prompt;
  if (DATETIME_INTENT.test(routingPrompt)) {
    const timezone =
      routingPrompt.match(/\b[A-Z][a-z]+\/[A-Z][A-Za-z_]+\b/)?.[0];
    toolCalls.push({
      id: "spectre-tool-datetime",
      type: "function",
      function: {
        name: "get_current_datetime",
        arguments: JSON.stringify(timezone ? { timezone } : {}),
      },
    });
  }
  if (SYSTEM_INTENT.test(routingPrompt)) {
    toolCalls.push({
      id: "spectre-tool-system-status",
      type: "function",
      function: {
        name: "get_system_status",
        arguments: "{}",
      },
    });
  }
  const directoryMatch = routingPrompt.match(DIRECTORY_LIST_INTENT);
  if (directoryMatch) {
    const requestedDirectory = directoryMatch[1].toLowerCase();
    const directoryPaths: Record<string, string> = {
      home: "~",
      dev: "~/dev",
      development: "~/dev",
      downloads: "~/Downloads",
      documents: "~/Documents",
      desktop: "~/Desktop",
    };
    toolCalls.push({
      id: "spectre-tool-system-directory",
      type: "function",
      function: {
        name: "system_read",
        arguments: JSON.stringify({
          operation: "list_directory",
          payload: JSON.stringify({
            path: directoryPaths[requestedDirectory],
            includeHidden: false,
          }),
        }),
      },
    });
  }
  if (
    VAULT_INTENT.test(routingPrompt)
    && !VAULT_WRITE_INTENT.test(routingPrompt)
  ) {
    const wikilink =
      routingPrompt.match(/\[\[([^\]#]+)(?:#[^\]]*)?\]\]/)?.[1];
    if (wikilink) {
      toolCalls.push({
        id: "spectre-tool-vault-read",
        type: "function",
        function: {
          name: "read_obsidian_note",
          arguments: JSON.stringify({
            path: wikilink.endsWith(".md") ? wikilink : `${wikilink}.md`,
          }),
        },
      });
    } else {
      toolCalls.push({
        id: "spectre-tool-vault-search",
        type: "function",
        function: {
          name: "search_obsidian_vault",
          arguments: JSON.stringify({ query: routingPrompt, limit: 5 }),
        },
      });
    }
  }
  if (GITHUB_ACTIVITY_INTENT.test(routingPrompt)) {
    toolCalls.push({
      id: "spectre-tool-github-activity",
      type: "function",
      function: {
        name: "get_github_activity",
        arguments: "{}",
      },
    });
  }
  if (GITHUB_REPOSITORY_LIST_INTENT.test(routingPrompt)) {
    toolCalls.push({
      id: "spectre-tool-github-repositories",
      type: "function",
      function: {
        name: "github_read",
        arguments: JSON.stringify({
          operation: "list_repositories",
          payload: '{"limit":100}',
        }),
      },
    });
  }
  if (
    contextualCorrection
    && GITHUB_ISSUE_LIST_INTENT.test(routingPrompt)
  ) {
    const repository =
      routingPrompt.match(
        /\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\b/,
      )?.[1]
      ?? mostRecentRememberedRepository(memoryContext);
    if (repository) {
      toolCalls.push({
        id: "spectre-tool-github-issues",
        type: "function",
        function: {
          name: "github_read",
          arguments: JSON.stringify({
            operation: "list_issues",
            repository,
            payload: '{"state":"all","limit":100}',
          }),
        },
      });
    }
  }
  const cloneMatch = routingPrompt.match(GITHUB_REPOSITORY_CLONE_INTENT);
  if (cloneMatch) {
    toolCalls.push({
      id: "spectre-tool-github-clone",
      type: "function",
      function: {
        name: "github_write",
        arguments: JSON.stringify({
          operation: "repository_clone",
          repository: cloneMatch[1],
          payload: "{}",
        }),
      },
    });
  }
  const publicUrl = routingPrompt.match(PUBLIC_URL_PATTERN)?.[0];
  if (publicUrl) {
    toolCalls.push({
      id: "spectre-tool-web-page",
      type: "function",
      function: {
        name: "fetch_web_page",
        arguments: JSON.stringify({ url: publicUrl }),
      },
    });
  } else if (isExplicitWebResearchRequest(routingPrompt)) {
    toolCalls.push({
      id: "spectre-tool-web-research",
      type: "function",
      function: {
        name: "research_web",
        arguments: JSON.stringify({
          query: webResearchQuery(routingPrompt),
          limit: 3,
        }),
      },
    });
  } else if (
    isLongFormPresentationRequest(routingPrompt)
    && GITHUB_CLI_GUIDE_INTENT.test(routingPrompt)
  ) {
    toolCalls.push({
      id: "spectre-tool-github-cli-guide-research",
      type: "function",
      function: {
        name: "research_web",
        arguments: JSON.stringify({
          query:
            "site:cli.github.com/manual GitHub CLI official manual commands authentication repositories issues pull requests actions",
          limit: 3,
        }),
      },
    });
  }
  return toolCalls;
}

async function readError(response: Response): Promise<never> {
  const details = await response.text();
  throw new Error(
    `LM Studio returned ${response.status}: ${details || response.statusText}`,
  );
}

async function resolveLoadedModel(
  baseUrl: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<string> {
  const serverUrl = baseUrl.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
  const response = await fetch(`${serverUrl}/api/v1/models`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    signal,
  });
  if (!response.ok) await readError(response);

  const body = await response.json() as LMStudioModelsResponse;
  const loadedModels = (body.models ?? [])
    .filter((model) => model.type === "llm")
    .flatMap((model) => model.loaded_instances ?? [])
    .map((instance) => instance.id?.trim())
    .filter((id): id is string => Boolean(id));

  if (loadedModels.length === 0) {
    throw new Error("LM Studio has no loaded LLM");
  }
  if (loadedModels.length > 1) {
    throw new Error(
      "LM Studio has multiple loaded LLMs; set LM_STUDIO_MODEL to choose one",
    );
  }
  return loadedModels[0];
}

async function appendToolResults(
  messages: ChatMessage[],
  toolCalls: ToolCall[],
  onProgress?: (update: AgentProgressUpdate) => void | Promise<void>,
  completedToolCalls = 0,
  seenToolCalls?: Set<string>,
  executionContext?: SpectreToolExecutionContext,
  onToolCall?: (name: string) => void | Promise<void>,
  treatToolResultsAsUntrusted = false,
  exposeToolErrors = true,
): Promise<ToolExecutionMetadata> {
  const metadata: ToolExecutionMetadata = {
    webAttempted: false,
    readableWebSources: [],
  };
  messages.push({
    role: "assistant",
    content: null,
    tool_calls: toolCalls,
  });
  for (const [index, toolCall] of toolCalls.entries()) {
    let content: string;
    const signature =
      `${toolCall.function.name}:${toolCall.function.arguments}`;
    if (seenToolCalls?.has(signature)) {
      await onProgress?.({
        step: completedToolCalls + index + 1,
        message: "Correcting a repeated tool step",
      });
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: treatToolResultsAsUntrusted
          ? createUntrustedDataEnvelope(
            `tool-result:${toolCall.function.name}`,
            JSON.stringify({
              error: [
                "Repeated identical tool call blocked.",
                "Use the prior result, correct the arguments, or choose a different tool.",
              ].join(" "),
            }),
          )
          : JSON.stringify({
          error: [
            "Repeated identical tool call blocked.",
            "Use the prior result, correct the arguments, or choose a different tool.",
          ].join(" "),
          }),
      });
      continue;
    }
    seenToolCalls?.add(signature);
    try {
      const step = completedToolCalls + index + 1;
      const message = describeToolCall(toolCall);
      await onProgress?.({
        step,
        message,
        spokenHint: step > 1 && step % 4 === 0
          ? `I'm still working on it, man. ${message}.`
          : undefined,
      });
      console.info(`[SPECTRE-TOOL] Running ${toolCall.function.name}`);
      await onToolCall?.(toolCall.function.name);
      content = await executeSpectreTool(
        toolCall.function.name,
        toolCall.function.arguments,
        executionContext,
      );
      if (toolCall.function.name === "system_read") {
        const args = JSON.parse(toolCall.function.arguments) as {
          operation?: unknown;
          payload?: unknown;
        };
        const result = JSON.parse(content) as unknown;
        if (
          (args.operation === "list_directory"
            || args.operation === "find_files")
          && Array.isArray(result)
        ) {
          const items = result.flatMap((entry) => {
            if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
              return [];
            }
            const record = entry as Record<string, unknown>;
            if (
              typeof record.name !== "string"
              || typeof record.path !== "string"
            ) {
              return [];
            }
            const type = typeof record.type === "string"
              ? record.type
              : "path";
            return [`- ${record.name} — ${type} — ${record.path}`];
          });
          const parsedPayload = typeof args.payload === "string"
            ? JSON.parse(args.payload) as Record<string, unknown>
            : {};
          const root = typeof parsedPayload.path === "string"
            ? parsedPayload.path
            : "requested location";
          const formatted = [
            `${args.operation === "find_files" ? "Matches" : "Contents"} for ${root}: ${items.length}`,
            ...items,
          ].join("\n");
          metadata.structuredResult = {
            title: args.operation === "find_files"
              ? "File search results"
              : `Directory: ${root}`,
            content: formatted,
            spokenHint: args.operation === "find_files"
              ? "I put the file search results on screen."
              : "I put the directory listing on screen.",
            memoryText: formatted,
          };
        }
      } else if (toolCall.function.name === "github_read") {
        const args = JSON.parse(toolCall.function.arguments) as {
          operation?: unknown;
          repository?: unknown;
        };
        const githubResult = JSON.parse(content) as unknown;
        if (
          args.operation === "list_repositories"
          && Array.isArray(githubResult)
        ) {
          const items = githubResult.flatMap((repository) => {
            if (
              !repository
              || typeof repository !== "object"
              || Array.isArray(repository)
            ) {
              return [];
            }
            const record = repository as Record<string, unknown>;
            if (typeof record.nameWithOwner !== "string") return [];
            const details = [
              record.isPrivate === true ? "Private" : "Public",
              record.isArchived === true ? "Archived" : undefined,
              record.defaultBranchRef
                && typeof record.defaultBranchRef === "object"
                && !Array.isArray(record.defaultBranchRef)
                && typeof (
                  record.defaultBranchRef as Record<string, unknown>
                ).name === "string"
                ? `Default: ${
                  (record.defaultBranchRef as Record<string, unknown>).name
                }`
                : undefined,
              typeof record.updatedAt === "string"
                ? `Updated: ${record.updatedAt}`
                : undefined,
              typeof record.description === "string"
                && record.description.trim()
                ? record.description.trim()
                : undefined,
            ].filter((value): value is string => Boolean(value));
            return [`- ${record.nameWithOwner} — ${details.join(" — ")}`];
          });
          if (items.length > 0) {
            const formatted = [
              `Repositories visible to the active GitHub account: ${items.length}`,
              ...items,
            ].join("\n");
            metadata.structuredResult = {
              title: "GitHub repositories",
              content: formatted,
              spokenHint: "I put the repository list on screen.",
              memoryText: formatted,
            };
          }
        } else if (
          args.operation === "get_repository"
          && githubResult
          && typeof githubResult === "object"
          && !Array.isArray(githubResult)
        ) {
          const repository = githubResult as Record<string, unknown>;
          if (typeof repository.nameWithOwner === "string") {
            const defaultBranch = repository.defaultBranchRef
              && typeof repository.defaultBranchRef === "object"
              && !Array.isArray(repository.defaultBranchRef)
              && typeof (
                repository.defaultBranchRef as Record<string, unknown>
              ).name === "string"
              ? (repository.defaultBranchRef as Record<string, unknown>).name
              : "Unavailable";
            const repositoryTopics = repository.repositoryTopics;
            const rawTopicNodes = Array.isArray(repositoryTopics)
              ? repositoryTopics
              : repositoryTopics
                  && typeof repositoryTopics === "object"
                ? (repositoryTopics as Record<string, unknown>).nodes
                : undefined;
            const topicNodes: unknown[] = Array.isArray(rawTopicNodes)
              ? rawTopicNodes
              : [];
            const topics = topicNodes
              .flatMap((topic) =>
                topic
                  && typeof topic === "object"
                  && !Array.isArray(topic)
                  && typeof (topic as Record<string, unknown>).name === "string"
                  ? [(topic as Record<string, unknown>).name as string]
                  : [])
              .join(", ");
            const formatted = [
              `Repository: ${repository.nameWithOwner}`,
              `- Visibility — ${
                repository.isPrivate === true ? "Private" : "Public"
              }`,
              `- Archived — ${repository.isArchived === true ? "Yes" : "No"}`,
              `- Default branch — ${defaultBranch}`,
              `- Description — ${
                typeof repository.description === "string"
                  && repository.description.trim()
                  ? repository.description.trim()
                  : "None"
              }`,
              `- URL — ${
                typeof repository.url === "string"
                  ? repository.url
                  : "Unavailable"
              }`,
              `- Homepage — ${
                typeof repository.homepageUrl === "string"
                  && repository.homepageUrl.trim()
                  ? repository.homepageUrl
                  : "None"
              }`,
              `- License — ${
                repository.licenseInfo
                && typeof repository.licenseInfo === "object"
                && !Array.isArray(repository.licenseInfo)
                && typeof (
                  repository.licenseInfo as Record<string, unknown>
                ).name === "string"
                  ? (repository.licenseInfo as Record<string, unknown>).name
                  : "None"
              }`,
              `- Topics — ${topics || "None"}`,
              `- Your permission — ${
                typeof repository.viewerPermission === "string"
                  ? repository.viewerPermission
                  : "Unavailable"
              }`,
            ].join("\n");
            metadata.structuredResult = {
              title: repository.nameWithOwner,
              content: formatted,
              spokenHint: "I put the repository details on screen.",
              memoryText: formatted,
            };
          }
        } else if (
          args.operation === "list_issues"
          && typeof args.repository === "string"
          && Array.isArray(githubResult)
          && (
            toolCall.id === "spectre-tool-github-issues"
            || toolCall.id.startsWith("spectre-text-tool-")
          )
        ) {
          const items = githubResult.flatMap((issue) => {
            if (!issue || typeof issue !== "object" || Array.isArray(issue)) {
              return [];
            }
            const record = issue as Record<string, unknown>;
            if (
              typeof record.number !== "number"
              || typeof record.title !== "string"
            ) {
              return [];
            }
            const details = [
              typeof record.state === "string" ? record.state : undefined,
              record.author
                && typeof record.author === "object"
                && !Array.isArray(record.author)
                && typeof (
                  record.author as Record<string, unknown>
                ).login === "string"
                ? `by ${(record.author as Record<string, unknown>).login}`
                : undefined,
              typeof record.url === "string" ? record.url : undefined,
            ].filter((value): value is string => Boolean(value));
            return [
              `- #${record.number} — ${record.title} — ${details.join(" — ")}`,
            ];
          });
          const formatted = [
            `Issues for ${args.repository}: ${items.length}`,
            ...items,
          ].join("\n");
          metadata.structuredResult = {
            title: `${args.repository} issues`,
            content: formatted,
            spokenHint: "I put the repository issues on screen.",
            memoryText: formatted,
          };
        }
      } else if (toolCall.function.name === "research_web") {
        metadata.webAttempted = true;
        const research = JSON.parse(content) as {
          sources?: Array<{ url?: unknown; content?: unknown }>;
        };
        metadata.readableWebSources.push(
          ...(research.sources ?? [])
            .filter((source) =>
              typeof source.url === "string"
              && typeof source.content === "string"
              && source.content.trim().length > 0)
            .map((source) => source.url as string),
        );
      } else if (toolCall.function.name === "fetch_web_page") {
        metadata.webAttempted = true;
        const page = JSON.parse(content) as {
          url?: unknown;
          content?: unknown;
        };
        if (
          typeof page.url === "string"
          && typeof page.content === "string"
          && page.content.trim()
        ) {
          metadata.readableWebSources.push(page.url);
        }
      }
    } catch (error) {
      if (
        toolCall.function.name === "research_web"
        || toolCall.function.name === "fetch_web_page"
      ) {
        metadata.webAttempted = true;
      }
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        exposeToolErrors
          ? `[SPECTRE-TOOL] ${toolCall.function.name} failed: ${message}`
          : `[SPECTRE-TOOL] ${toolCall.function.name} failed safely`,
      );
      content = JSON.stringify({
        error: exposeToolErrors
          ? message
          : "The tool request failed safely.",
      });
    }
    messages.push({
      role: "tool",
      tool_call_id: toolCall.id,
      content: treatToolResultsAsUntrusted
        ? createUntrustedDataEnvelope(
          `tool-result:${toolCall.function.name}`,
          content,
        )
        : content,
    });
  }
  metadata.readableWebSources = [...new Set(metadata.readableWebSources)];
  return metadata;
}

function describeToolCall(toolCall: ToolCall): string {
  const labels: Record<string, string> = {
    get_current_datetime: "Checking the date and time",
    get_system_status: "Inspecting system status",
    search_obsidian_vault: "Searching Obsidian",
    read_obsidian_note: "Reading an Obsidian note",
    append_obsidian_note: "Updating Obsidian",
    list_projects: "Inspecting local projects",
    list_sandcastle_workflows: "Checking workflow progress",
    prepare_sandcastle_issue_workflow: "Preparing the requested workflow",
    get_github_activity: "Checking recent GitHub activity",
    github_read: "Inspecting GitHub",
    github_write: "Preparing a confirmed GitHub action",
    system_read: "Inspecting the local filesystem",
    system_write: "Preparing a confirmed system change",
    present_text: "Preparing content for the screen",
    research_web: "Researching public sources",
    fetch_web_page: "Reading a public source",
  };
  return labels[toolCall.function.name] ?? "Working on the next step";
}

async function selectOptionalTools(
  messages: ChatMessage[],
  endpoint: string,
  model: string,
  apiKey: string,
  allowedToolNames: string[],
  signal?: AbortSignal,
): Promise<ToolCall[]> {
  return selectTools(
    messages,
    endpoint,
    model,
    apiKey,
    allowedToolNames,
    "auto",
    signal,
  );
}

async function selectTools(
  messages: ChatMessage[],
  endpoint: string,
  model: string,
  apiKey: string,
  allowedToolNames: string[],
  toolChoice: "required" | "auto",
  signal?: AbortSignal,
): Promise<ToolCall[]> {
  const tools = SPECTRE_TOOLS.filter(
    (tool) => allowedToolNames.includes(tool.function.name),
  );
  if (tools.length === 0) {
    throw new Error("No eligible Spectre tools were provided");
  }
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      stream: false,
      temperature: 0,
      max_tokens: MAX_TOOL_SELECTION_TOKENS,
      reasoning_effort: "none",
      chat_template_kwargs: {
        enable_thinking: false,
      },
      messages,
      tools,
      tool_choice: toolChoice,
    }),
    signal,
  });
  if (!response.ok) await readError(response);

  const selection = await response.json() as ToolSelectionResponse;
  const assistant = selection.choices?.[0]?.message;
  const toolCalls = assistant?.tool_calls?.length
    ? assistant.tool_calls
    : parseTextToolCalls(assistant?.content, allowedToolNames);
  if (toolCalls.length === 0 && toolChoice === "required") {
    throw new Error("LM Studio did not return the required tool call");
  }
  if (toolCalls.length > MAX_TOOL_CALLS_PER_ROUND) {
    throw new Error(
      `LM Studio exceeded ${MAX_TOOL_CALLS_PER_ROUND} tool calls in one round`,
    );
  }

  for (const toolCall of toolCalls) {
    if (
      !toolCall.id
      || toolCall.type !== "function"
      || !toolCall.function?.name
      || typeof toolCall.function.arguments !== "string"
    ) {
      throw new Error("LM Studio returned an incomplete tool call");
    }
    if (!allowedToolNames.includes(toolCall.function.name)) {
      throw new Error(
        `LM Studio selected an unavailable tool: ${toolCall.function.name}`,
      );
    }
  }

  return toolCalls;
}

function parseTextToolCalls(
  content: string | null | undefined,
  allowedToolNames: string[],
): ToolCall[] {
  if (!content) return [];
  const calls = [
    ...content.matchAll(
      /<tool_call>\s*<function=([A-Za-z0-9_]+)>([\s\S]*?)<\/function>\s*<\/tool_call>/gi,
    ),
  ];
  return calls.flatMap((call, index) => {
    const name = call[1];
    if (!allowedToolNames.includes(name)) return [];
    const args: Record<string, unknown> = {};
    for (
      const parameter of call[2].matchAll(
        /<parameter=([A-Za-z0-9_]+)>([\s\S]*?)<\/parameter>/gi,
      )
    ) {
      const rawValue = parameter[2].trim();
      try {
        args[parameter[1]] = JSON.parse(rawValue) as unknown;
      } catch {
        args[parameter[1]] = rawValue;
      }
    }
    if (
      (name === "github_read" || name === "github_write")
      && args.payload
      && typeof args.payload === "object"
      && !Array.isArray(args.payload)
    ) {
      const payload = { ...(args.payload as Record<string, unknown>) };
      if (
        typeof args.repository !== "string"
        && typeof payload.owner === "string"
        && typeof payload.name === "string"
      ) {
        args.repository = `${payload.owner}/${payload.name}`;
        delete payload.owner;
        delete payload.name;
      }
      args.payload = JSON.stringify(payload);
    }
    return [{
      id: `spectre-text-tool-${index + 1}`,
      type: "function" as const,
      function: {
        name,
        arguments: JSON.stringify(args),
      },
    }];
  });
}

function containsToolControlMarkup(content: string): boolean {
  return /<\s*(?:tool_call|function=|parameter=)/i.test(content);
}

export async function* streamLMStudioResponse(
  prompt: string,
  config: LMStudioConfig = {},
): AsyncGenerator<string> {
  const baseUrl = (
    config.baseUrl
    ?? process.env.LM_STUDIO_BASE_URL
    ?? "http://127.0.0.1:1234/v1"
  ).replace(/\/+$/, "");
  const apiKey = config.apiKey
    ?? process.env.LM_STUDIO_API_KEY
    ?? "lm-studio";
  const configuredModel = config.model?.trim()
    || process.env.LM_STUDIO_MODEL?.trim();
  const model = configuredModel
    || await resolveLoadedModel(baseUrl, apiKey, config.signal);
  const endpoint = `${baseUrl}/chat/completions`;
  const memoryContext = config.memoryContext?.trim();
  const allowedToolNames = config.callerPolicy
    ? [...config.callerPolicy.allowedToolNames]
    : ALL_TOOL_NAMES;
  const longFormPresentation = isLongFormPresentationRequest(prompt);
  const messages: ChatMessage[] = CONTEXT_MESSAGES.map((message, index) => {
    if (index !== 0 || message.role !== "system") {
      return { ...message };
    }
    const additions = [
      config.callerPolicy?.wrapUntrustedInput ? undefined : memoryContext,
      config.callerPolicy?.additionalSystemInstructions,
      longFormPresentation
        ? LONG_FORM_PRESENTATION_INSTRUCTION
        : undefined,
    ].filter((addition): addition is string => Boolean(addition));
    if (additions.length === 0) return { ...message };
    return {
      ...message,
      content: [message.content, ...additions].join("\n\n"),
    };
  });
  if (config.callerPolicy?.wrapUntrustedInput && memoryContext) {
    messages.push({
      role: "user",
      content: createUntrustedDataEnvelope(
        "discord-conversation-memory",
        memoryContext,
      ),
    });
  }
  messages.push({
    role: "user",
    content: config.callerPolicy?.wrapUntrustedInput
      ? createUntrustedDataEnvelope("discord-current-request", prompt)
      : prompt,
  });

  let toolCalls = routeDirectToolCalls(prompt, memoryContext).filter(
    (toolCall) => allowedToolNames.includes(toolCall.function.name),
  );
  const seenToolCalls = new Set<string>();
  const toolMetadata: ToolExecutionMetadata = {
    webAttempted: false,
    readableWebSources: [],
  };
  const extendedProgressRequested = (
    longFormPresentation
    || isExplicitWebResearchRequest(prompt)
    || shouldPresentInEditor(prompt)
  );
  let showFinalProgress = extendedProgressRequested;
  if (toolCalls.length > 0) {
    if (extendedProgressRequested || toolCalls.length > 1) {
      showFinalProgress = true;
      await config.onProgress?.({
        step: 0,
        message: "Starting the requested work",
        spokenHint: "I'm working on it, man. Give me a minute.",
      });
    }
    Object.assign(
      toolMetadata,
      await appendToolResults(
        messages,
        toolCalls,
        config.onProgress,
        0,
        seenToolCalls,
        config.callerPolicy?.toolExecutionContext,
        config.onToolCall,
        config.callerPolicy?.treatToolResultsAsUntrusted,
        config.callerPolicy?.exposeToolErrors,
      ),
    );
  } else if (allowedToolNames.length > 0) {
    let totalToolCalls = 0;
    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      if (round === 0 && extendedProgressRequested) {
        await config.onProgress?.({
          step: 0,
          message: "Planning how to complete this request",
        });
      }
      toolCalls = await selectOptionalTools(
        messages,
        endpoint,
        model,
        apiKey,
        allowedToolNames,
        config.signal,
      );
      if (toolCalls.length === 0) break;
      if (toolMetadata.structuredResult) {
        toolMetadata.structuredResult = undefined;
      }
      const continuingWork = totalToolCalls > 0;
      const nextTotalToolCalls = totalToolCalls + toolCalls.length;
      if (continuingWork) {
        showFinalProgress = true;
        await config.onProgress?.({
          step: totalToolCalls,
          message: "Reviewing results and planning the next step",
          spokenHint: "I'm working on it, man. Give me a minute.",
        });
      } else if (extendedProgressRequested || toolCalls.length > 1) {
        showFinalProgress = true;
        await config.onProgress?.({
          step: 0,
          message: "Work is underway",
          spokenHint: "I'm working on it, man. Give me a minute.",
        });
      }
      totalToolCalls = nextTotalToolCalls;
      if (totalToolCalls > MAX_TOTAL_TOOL_CALLS) {
        throw new Error(
          `LM Studio exceeded ${MAX_TOTAL_TOOL_CALLS} total tool calls`,
        );
      }
      const completedBeforeRound = totalToolCalls - toolCalls.length;
      const roundMetadata = await appendToolResults(
        messages,
        toolCalls,
        config.onProgress,
        completedBeforeRound,
        seenToolCalls,
        config.callerPolicy?.toolExecutionContext,
        config.onToolCall,
        config.callerPolicy?.treatToolResultsAsUntrusted,
        config.callerPolicy?.exposeToolErrors,
      );
      toolMetadata.webAttempted ||= roundMetadata.webAttempted;
      toolMetadata.readableWebSources.push(
        ...roundMetadata.readableWebSources,
      );
      if (roundMetadata.structuredResult) {
        toolMetadata.structuredResult = roundMetadata.structuredResult;
      }
    }
    toolMetadata.readableWebSources = [
      ...new Set(toolMetadata.readableWebSources),
    ];
  }
  if (toolMetadata.structuredResult) {
    await config.onStructuredResult?.(toolMetadata.structuredResult);
    yield toolMetadata.structuredResult.spokenHint;
    return;
  }
  if (
    toolMetadata.webAttempted
    && toolMetadata.readableWebSources.length === 0
  ) {
    yield NO_WEB_EVIDENCE_MESSAGE;
    return;
  }
  if (showFinalProgress) {
    await config.onProgress?.({
      step: 0,
      message: "Preparing the final result",
    });
  }

  if (longFormPresentation) {
    const requestLongForm = async (
      requestMessages: ChatMessage[],
    ): Promise<string> => {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          stream: false,
          temperature: 0.55,
          max_tokens: 2_048,
          reasoning_effort: "none",
          chat_template_kwargs: {
            enable_thinking: false,
          },
          messages: requestMessages,
        }),
        signal: config.signal,
      });
      if (!response.ok) await readError(response);
      const body = await response.json() as ToolSelectionResponse;
      return body.choices?.[0]?.message?.content?.trim() ?? "";
    };

    let generatedText = await requestLongForm(messages);
    if (!isUsableLongFormPresentation(generatedText)) {
      generatedText = await requestLongForm([
        ...messages,
        {
          role: "assistant",
          content: generatedText || "I did not provide the requested content.",
        },
        {
          role: "user",
          content: [
            "That response was only a placeholder and did not contain the requested material.",
            "Write the actual complete guide now.",
            "Include substantive sections, practical examples, common workflows, safety notes, and troubleshooting.",
            "Return only the guide content and do not mention preparing, displaying, opening, or reviewing it on screen.",
          ].join(" "),
        },
      ]);
    }
    if (!isUsableLongFormPresentation(generatedText)) {
      throw new Error(
        "LM Studio did not produce substantive long-form presentation content",
      );
    }
    yield generatedText;
    const missingSources = toolMetadata.readableWebSources.filter(
      (url) => !generatedText.includes(url),
    );
    if (missingSources.length > 0) {
      yield `\n\nSources: ${missingSources.join("; ")}`;
    }
    return;
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      stream: true,
      temperature: 0.65,
      max_tokens: (
        shouldPresentInEditor(prompt)
        || isExplicitWebResearchRequest(prompt)
        || isLongFormPresentationRequest(prompt)
      )
        ? 2_048
        : MAX_RESPONSE_TOKENS,
      reasoning_effort: "none",
      chat_template_kwargs: {
        enable_thinking: false,
      },
      messages,
    }),
    signal: config.signal,
  });
  if (!response.ok) await readError(response);
  if (!response.body) {
    throw new Error("LM Studio returned no response stream");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let generatedText = "";

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });

    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const payload = line.trim();
      if (!payload.startsWith("data:")) continue;

      const data = payload.slice(5).trim();
      if (!data || data === "[DONE]") continue;

      const chunk = JSON.parse(data) as ChatCompletionChunk;
      const content = chunk.choices?.[0]?.delta?.content;
      if (content) {
        generatedText += content;
      }
    }

    if (done) break;
  }
  if (containsToolControlMarkup(generatedText)) {
    throw new Error(
      "LM Studio returned an unexecuted tool call instead of a final response",
    );
  }
  if (generatedText) yield generatedText;
  const missingSources = toolMetadata.readableWebSources.filter(
    (url) => !generatedText.includes(url),
  );
  if (missingSources.length > 0) {
    yield ` Sources: ${missingSources.join("; ")}.`;
  }
}
