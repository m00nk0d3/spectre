import { CONTEXT_MESSAGES } from "@/ai/messages/context";
import {
  executeSpectreTool,
  SPECTRE_TOOLS,
} from "./spectre-tools";

export interface LMStudioConfig {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  signal?: AbortSignal;
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

const MAX_TOOL_CALLS = 4;
const MAX_RESPONSE_TOKENS = 256;

const DATETIME_INTENT =
  /\b(current (?:date|time)|what (?:day|date|time)|today(?:'s)? date)\b/i;
const SYSTEM_INTENT =
  /\b(system status|computer status|uptime|load average|available memory|memory usage|operating system|system architecture)\b/i;
const EXPLICIT_TOOL_INTENT = /\buse (?:a |your )?tool\b/i;
const VAULT_INTENT = /\b(vault|obsidian|second brain|my notes?)\b/i;
const VAULT_WRITE_INTENT =
  /\b(?:remember|save|write|add|append|capture|record|note down)\b[\s\S]*\b(?:vault|obsidian|second brain|notes?)\b|\bremember (?:that|this|my)\b/i;

export function routeDirectToolCalls(prompt: string): ToolCall[] {
  const toolCalls: ToolCall[] = [];
  if (DATETIME_INTENT.test(prompt)) {
    const timezone = prompt.match(/\b[A-Z][a-z]+\/[A-Z][A-Za-z_]+\b/)?.[0];
    toolCalls.push({
      id: "spectre-tool-datetime",
      type: "function",
      function: {
        name: "get_current_datetime",
        arguments: JSON.stringify(timezone ? { timezone } : {}),
      },
    });
  }
  if (SYSTEM_INTENT.test(prompt)) {
    toolCalls.push({
      id: "spectre-tool-system-status",
      type: "function",
      function: {
        name: "get_system_status",
        arguments: "{}",
      },
    });
  }
  if (VAULT_INTENT.test(prompt) && !VAULT_WRITE_INTENT.test(prompt)) {
    const wikilink = prompt.match(/\[\[([^\]#]+)(?:#[^\]]*)?\]\]/)?.[1];
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
          arguments: JSON.stringify({ query: prompt, limit: 5 }),
        },
      });
    }
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
): Promise<void> {
  messages.push({
    role: "assistant",
    content: null,
    tool_calls: toolCalls,
  });
  for (const toolCall of toolCalls) {
    let content: string;
    try {
      console.info(`[SPECTRE-TOOL] Running ${toolCall.function.name}`);
      content = await executeSpectreTool(
        toolCall.function.name,
        toolCall.function.arguments,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[SPECTRE-TOOL] ${toolCall.function.name} failed: ${message}`,
      );
      content = JSON.stringify({ error: message });
    }
    messages.push({
      role: "tool",
      tool_call_id: toolCall.id,
      content,
    });
  }
}

async function selectRequiredTools(
  messages: ChatMessage[],
  endpoint: string,
  model: string,
  apiKey: string,
  allowedToolNames: string[],
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
      max_tokens: MAX_RESPONSE_TOKENS,
      reasoning_effort: "none",
      chat_template_kwargs: {
        enable_thinking: false,
      },
      messages,
      tools,
      tool_choice: "required",
    }),
    signal,
  });
  if (!response.ok) await readError(response);

  const selection = await response.json() as ToolSelectionResponse;
  const assistant = selection.choices?.[0]?.message;
  const toolCalls = assistant?.tool_calls ?? [];
  if (toolCalls.length === 0) {
    throw new Error("LM Studio did not return the required tool call");
  }
  if (toolCalls.length > MAX_TOOL_CALLS) {
    throw new Error(`LM Studio exceeded ${MAX_TOOL_CALLS} tool calls`);
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
  }

  return toolCalls;
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
  const messages: ChatMessage[] = [
    ...CONTEXT_MESSAGES,
    { role: "user", content: prompt },
  ];

  let toolCalls = routeDirectToolCalls(prompt);
  if (toolCalls.length === 0 && VAULT_WRITE_INTENT.test(prompt)) {
    toolCalls = await selectRequiredTools(
      messages,
      endpoint,
      model,
      apiKey,
      ["append_obsidian_note"],
      config.signal,
    );
  } else if (toolCalls.length === 0 && EXPLICIT_TOOL_INTENT.test(prompt)) {
    toolCalls = await selectRequiredTools(
      messages,
      endpoint,
      model,
      apiKey,
      [
        "get_current_datetime",
        "get_system_status",
        "search_obsidian_vault",
        "read_obsidian_note",
      ],
      config.signal,
    );
  }
  if (toolCalls.length > 0) {
    await appendToolResults(messages, toolCalls);
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
      max_tokens: MAX_RESPONSE_TOKENS,
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
      if (content) yield content;
    }

    if (done) break;
  }
}
