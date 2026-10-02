import { CONTEXT_MESSAGES } from "@/ai/messages/context";

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

export async function* streamLMStudioResponse(
  prompt: string,
  config: LMStudioConfig = {},
): AsyncGenerator<string> {
  const baseUrl = config.baseUrl
    ?? process.env.LM_STUDIO_BASE_URL
    ?? "http://127.0.0.1:1234/v1";
  const model = config.model
    ?? process.env.LM_STUDIO_MODEL
    ?? "qwen/qwen3.5-9b";
  const apiKey = config.apiKey
    ?? process.env.LM_STUDIO_API_KEY
    ?? "lm-studio";

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      stream: true,
      temperature: 0.65,
      reasoning_effort: "none",
      chat_template_kwargs: {
        enable_thinking: false,
      },
      messages: [
        ...CONTEXT_MESSAGES,
        { role: "user", content: prompt },
      ],
    }),
    signal: config.signal,
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(
      `LM Studio returned ${response.status}: ${details || response.statusText}`,
    );
  }
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
