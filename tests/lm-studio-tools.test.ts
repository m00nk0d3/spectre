import { afterEach, describe, expect, it, vi } from "vitest";
import {
  routeDirectToolCalls,
  streamLMStudioResponse,
} from "../src/main/lm-studio";

function streamingResponse(events: object[]): Response {
  const body = events
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("")
    .concat("data: [DONE]\n\n");
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function toolSelectionResponse(): Response {
  return Response.json({
    choices: [{
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: {
            name: "get_current_datetime",
            arguments: '{"timezone":"UTC"}',
          },
        }],
      },
    }],
  });
}

function loadedModelsResponse(...ids: string[]): Response {
  return Response.json({
    models: [{
      type: "llm",
      loaded_instances: ids.map((id) => ({ id })),
    }],
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LM Studio tool calling", () => {
  it("routes vault searches and explicit wikilinks deterministically", () => {
    expect(
      routeDirectToolCalls("What does my vault say about Bonsai?"),
    ).toMatchObject([{
      function: {
        name: "search_obsidian_vault",
        arguments: expect.stringContaining("Bonsai"),
      },
    }]);
    expect(
      routeDirectToolCalls("Read [[30 Knowledge/Bonsai]] from my vault"),
    ).toMatchObject([{
      function: {
        name: "read_obsidian_note",
        arguments: '{"path":"30 Knowledge/Bonsai.md"}',
      },
    }]);
  });

  it("routes known time intent directly to the local tool", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(loadedModelsResponse("current-model"))
      .mockResolvedValueOnce(streamingResponse([
        {
          choices: [{
            delta: { content: "It is Thursday evening, sir." },
          }],
        },
      ]));

    let result = "";
    for await (const token of streamLMStudioResponse("What time is it?")) {
      result += token;
    }

    expect(result).toBe("It is Thursday evening, sir.");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const responseRequest = JSON.parse(
      String(fetchMock.mock.calls[1][1]?.body),
    ) as {
      messages: Array<Record<string, unknown>>;
      max_tokens: number;
      model: string;
      tools?: unknown;
    };
    expect(responseRequest.model).toBe("current-model");
    expect(responseRequest.messages.at(-2)).toMatchObject({
      role: "assistant",
      tool_calls: [{
        id: "spectre-tool-datetime",
        function: {
          name: "get_current_datetime",
          arguments: "{}",
        },
      }],
    });
    expect(responseRequest.messages.at(-1)).toMatchObject({
      role: "tool",
      tool_call_id: "spectre-tool-datetime",
    });
    expect(responseRequest.max_tokens).toBe(256);
    expect(responseRequest.tools).toBeUndefined();
  });

  it("asks the model to select a tool only for ambiguous tool requests", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(loadedModelsResponse("current-model"))
      .mockResolvedValueOnce(toolSelectionResponse())
      .mockResolvedValueOnce(streamingResponse([
        { choices: [{ delta: { content: "It is ready, sir." } }] },
      ]));

    let result = "";
    for await (
      const token of streamLMStudioResponse("Use your tool and report back.")
    ) {
      result += token;
    }

    expect(result).toBe("It is ready, sir.");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const selectionRequest = JSON.parse(
      String(fetchMock.mock.calls[1][1]?.body),
    ) as Record<string, unknown>;
    expect(selectionRequest).toMatchObject({
      stream: false,
      tool_choice: "required",
      tools: expect.any(Array),
    });
  });

  it("streams ordinary responses without a tool-selection request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(loadedModelsResponse("current-model"))
      .mockResolvedValueOnce(streamingResponse([
        { choices: [{ delta: { content: "Certainly, " } }] },
        { choices: [{ delta: { content: "sir." } }] },
      ]));

    let result = "";
    for await (const token of streamLMStudioResponse("Hello")) result += token;

    expect(result).toBe("Certainly, sir.");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://127.0.0.1:1234/api/v1/models",
    );
    const request = JSON.parse(
      String(fetchMock.mock.calls[1][1]?.body),
    ) as Record<string, unknown>;
    expect(request.tools).toBeUndefined();
    expect(request.model).toBe("current-model");
    expect(request.max_tokens).toBe(256);
  });

  it("fails when LM Studio omits a required tool call", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(loadedModelsResponse("current-model"))
      .mockResolvedValueOnce(Response.json({
        choices: [{ message: { role: "assistant", content: "I guessed." } }],
      }));

    const consume = async () => {
      for await (
        const token of streamLMStudioResponse("Use your tool and answer.")
      ) {
        void token;
      }
    };

    await expect(consume()).rejects.toThrow(
      "did not return the required tool call",
    );
  });

  it("requires an explicit override when multiple LLMs are loaded", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      loadedModelsResponse("first-model", "second-model"),
    );

    const consume = async () => {
      for await (const token of streamLMStudioResponse("Hello")) void token;
    };

    await expect(consume()).rejects.toThrow(
      "multiple loaded LLMs; set LM_STUDIO_MODEL",
    );
  });

  it("uses an explicit model override without discovery", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      streamingResponse([
        { choices: [{ delta: { content: "Ready." } }] },
      ]),
    );

    let result = "";
    for await (
      const token of streamLMStudioResponse("Hello", {
        model: "chosen-model",
      })
    ) {
      result += token;
    }

    expect(result).toBe("Ready.");
    expect(fetchMock).toHaveBeenCalledOnce();
    const request = JSON.parse(
      String(fetchMock.mock.calls[0][1]?.body),
    ) as Record<string, unknown>;
    expect(request.model).toBe("chosen-model");
  });
});
