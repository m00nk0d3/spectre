import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isUsableLongFormPresentation,
  routeDirectToolCalls,
  streamLMStudioResponse,
} from "../src/main/lm-studio";
import { sandcastleService } from "../src/main/sandcastle-service";
import { webResearchService } from "../src/main/web-research";
import { githubService } from "../src/main/github-service";
import { systemService } from "../src/main/system-service";

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

function noToolSelectionResponse(): Response {
  return Response.json({
    choices: [{
      message: {
        role: "assistant",
        content: "No web research is needed.",
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
  it("enforces an empty caller tool policy before model selection or execution", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      streamingResponse([{
        choices: [{ delta: { content: "I can't access tools here." } }],
      }]),
    );

    let output = "";
    for await (const chunk of streamLMStudioResponse(
      "What time is it and inspect my files?",
      {
        model: "test-model",
        callerPolicy: {
          allowedToolNames: [],
          additionalSystemInstructions: "Conversational chat only.",
          wrapUntrustedInput: true,
          treatToolResultsAsUntrusted: true,
          exposeToolErrors: false,
        },
      },
    )) {
      output += chunk;
    }

    expect(output).toBe("I can't access tools here.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0][1];
    const body = JSON.parse(String(request?.body)) as {
      messages: Array<{ role: string; content: string }>;
      tools?: unknown;
    };
    expect(body.tools).toBeUndefined();
    expect(body.messages[0].content).toContain("Conversational chat only.");
    expect(body.messages.at(-1)?.content).toContain(
      "BEGIN SPECTRE UNTRUSTED DATA",
    );
  });

  it("wraps tool results as untrusted data before returning them to the model", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      streamingResponse([{
        choices: [{ delta: { content: "It is noon." } }],
      }]),
    );

    for await (const chunk of streamLMStudioResponse("What time is it?", {
      model: "test-model",
      callerPolicy: {
        allowedToolNames: ["get_current_datetime"],
        wrapUntrustedInput: true,
        treatToolResultsAsUntrusted: true,
        exposeToolErrors: false,
      },
    })) {
      void chunk;
    }

    const request = fetchMock.mock.calls.at(-1)?.[1];
    const body = JSON.parse(String(request?.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    const tool = body.messages.find((message) => message.role === "tool");
    expect(tool?.content).toContain("BEGIN SPECTRE UNTRUSTED DATA");
    expect(tool?.content).toContain('"instructionAuthority":"none"');
  });

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

  it("routes GitHub activity questions to the local monitor", () => {
    expect(
      routeDirectToolCalls("Are there any new PRs?"),
    ).toMatchObject([{
      function: {
        name: "get_github_activity",
        arguments: "{}",
      },
    }]);
  });

  it("routes personal GitHub repository lists directly", () => {
    expect(
      routeDirectToolCalls("Look at my GitHub repos, please."),
    ).toMatchObject([{
      function: {
        name: "github_read",
        arguments: JSON.stringify({
          operation: "list_repositories",
          payload: '{"limit":100}',
        }),
      },
    }]);
    expect(
      routeDirectToolCalls("Yeah, show me my repos on GitHub."),
    ).toMatchObject([{
      function: {
        name: "github_read",
        arguments: JSON.stringify({
          operation: "list_repositories",
          payload: '{"limit":100}',
        }),
      },
    }]);
  });

  it("retries an on-screen repository request from recent memory", () => {
    const memoryContext = [
      "The following is local conversation memory.",
      "Remembered conversation turns:",
      "[2026-10-03T04:29:00.000Z] User: Yeah, show me my repos on GitHub.",
      "[2026-10-03T04:29:01.000Z] Spectre: I will fetch them.",
    ].join("\n");

    expect(
      routeDirectToolCalls(
        "You didn't put it on screen.",
        memoryContext,
      ),
    ).toMatchObject([{
      function: {
        name: "github_read",
        arguments: JSON.stringify({
          operation: "list_repositories",
          payload: '{"limit":100}',
        }),
      },
    }]);
  });

  it("recovers repository context and routes issue-list corrections", () => {
    const memoryContext = [
      "The following is local conversation memory.",
      "Remembered conversation turns:",
      "[2026-10-03T04:35:00.000Z] User: Show me the details on the first one.",
      "[2026-10-03T04:35:01.000Z] Spectre: I put the repository details on screen.",
      "Repository: m00nk0d3/Grove",
      "[2026-10-03T04:36:00.000Z] User: Show me the issues.",
      "[2026-10-03T04:36:01.000Z] Spectre: <tool_call>broken</tool_call>",
      "[2026-10-03T04:37:00.000Z] User: Yeah, you're showing me the tools again.",
    ].join("\n");

    expect(
      routeDirectToolCalls(
        "I don't want tool calls printed in the transcript. I want the result on screen.",
        memoryContext,
      ),
    ).toMatchObject([{
      function: {
        name: "github_read",
        arguments: JSON.stringify({
          operation: "list_issues",
          repository: "m00nk0d3/Grove",
          payload: '{"state":"all","limit":100}',
        }),
      },
    }]);
  });

  it("routes owned repository clone requests directly", () => {
    expect(
      routeDirectToolCalls(
        "I need you to clone my Normandy project into my dev folder.",
      ),
    ).toMatchObject([{
      function: {
        name: "github_write",
        arguments: JSON.stringify({
          operation: "repository_clone",
          repository: "Normandy",
          payload: "{}",
        }),
      },
    }]);
  });

  it("routes common directory listings directly", () => {
    expect(
      routeDirectToolCalls("Show me my dev directory"),
    ).toMatchObject([{
      function: {
        name: "system_read",
        arguments: JSON.stringify({
          operation: "list_directory",
          payload: '{"path":"~/dev","includeHidden":false}',
        }),
      },
    }]);
  });

  it("routes explicit public web research and URLs directly", () => {
    expect(
      routeDirectToolCalls("Research TypeScript 7 online"),
    ).toMatchObject([{
      function: {
        name: "research_web",
        arguments: expect.stringContaining("TypeScript 7"),
      },
    }]);
    expect(
      routeDirectToolCalls("Do some research online on bananas."),
    ).toMatchObject([{
      function: {
        name: "research_web",
        arguments: '{"query":"bananas","limit":3}',
      },
    }]);
    expect(
      routeDirectToolCalls("Summarize https://example.com/release"),
    ).toMatchObject([{
      function: {
        name: "fetch_web_page",
        arguments: '{"url":"https://example.com/release"}',
      },
    }]);
    expect(
      routeDirectToolCalls(
        "Give me a comprehensive guide on how to use the GH tool",
      ),
    ).toMatchObject([{
      function: {
        name: "research_web",
        arguments: expect.stringContaining("cli.github.com/manual"),
      },
    }]);
  });

  it("routes known time intent directly to the local tool", async () => {
    const progress: string[] = [];
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
    for await (
      const token of streamLMStudioResponse("What time is it?", {
        onProgress: (update) => {
          progress.push(update.message);
        },
      })
    ) {
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
    expect(progress).not.toContain("Starting the requested work");
    expect(progress).not.toContain("Preparing the final result");
  });

  it("offers every safe capability and follows up after tool execution", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(loadedModelsResponse("current-model"))
      .mockResolvedValueOnce(toolSelectionResponse())
      .mockResolvedValueOnce(noToolSelectionResponse())
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
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const selectionRequest = JSON.parse(
      String(fetchMock.mock.calls[1][1]?.body),
    ) as {
      tool_choice: string;
      tools: Array<{ function: { name: string } }>;
    };
    expect(selectionRequest).toMatchObject({
      stream: false,
      tool_choice: "auto",
      tools: expect.any(Array),
    });
    expect(
      selectionRequest.tools.map((tool) => tool.function.name),
    ).toEqual(expect.arrayContaining([
      "github_read",
      "github_write",
      "system_read",
      "system_write",
      "research_web",
      "present_text",
    ]));
  });

  it("can select Sandcastle tools from the general capability set", async () => {
    vi.spyOn(sandcastleService, "listProjects").mockResolvedValue([]);
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(loadedModelsResponse("current-model"))
      .mockResolvedValueOnce(Response.json({
        choices: [{
          message: {
            tool_calls: [{
              id: "call_projects",
              type: "function",
              function: {
                name: "list_projects",
                arguments: "{}",
              },
            }],
          },
        }],
      }))
      .mockResolvedValueOnce(noToolSelectionResponse())
      .mockResolvedValueOnce(streamingResponse([
        { choices: [{ delta: { content: "No projects found." } }] },
      ]));

    let result = "";
    for await (
      const token of streamLMStudioResponse("List my local projects")
    ) {
      result += token;
    }

    expect(result).toBe("No projects found.");
    const selectionRequest = JSON.parse(
      String(fetchMock.mock.calls[1][1]?.body),
    ) as {
      tools: Array<{ function: { name: string } }>;
    };
    expect(
      selectionRequest.tools.map((tool) => tool.function.name),
    ).toEqual(expect.arrayContaining([
      "list_projects",
      "list_sandcastle_workflows",
      "prepare_sandcastle_issue_workflow",
      "github_read",
      "system_read",
      "research_web",
    ]));
  });

  it("can select typed GitHub tools from the general capability set", async () => {
    vi.spyOn(githubService, "read").mockResolvedValue([{
      number: 42,
      title: "Conversation memory",
    }]);
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(loadedModelsResponse("current-model"))
      .mockResolvedValueOnce(Response.json({
        choices: [{
          message: {
            tool_calls: [{
              id: "call_github",
              type: "function",
              function: {
                name: "github_read",
                arguments: JSON.stringify({
                  operation: "list_issues",
                  repository: "m00nk0d3/spectre",
                  payload: '{"state":"open"}',
                }),
              },
            }],
          },
        }],
      }))
      .mockResolvedValueOnce(noToolSelectionResponse())
      .mockResolvedValueOnce(streamingResponse([
        { choices: [{ delta: { content: "Issue 42 is open." } }] },
      ]));

    let result = "";
    for await (
      const token of streamLMStudioResponse(
        "List open GitHub issues in m00nk0d3/spectre",
      )
    ) {
      result += token;
    }

    expect(result).toBe("Issue 42 is open.");
    const selectionRequest = JSON.parse(
      String(fetchMock.mock.calls[1][1]?.body),
    ) as { tools: Array<{ function: { name: string } }> };
    expect(
      selectionRequest.tools.map((tool) => tool.function.name),
    ).toEqual(expect.arrayContaining([
      "get_github_activity",
      "github_read",
      "github_write",
      "system_read",
      "research_web",
    ]));
  });

  it("executes LM Studio text-form tool calls instead of printing them", async () => {
    vi.spyOn(githubService, "read").mockResolvedValue([{
      number: 7,
      title: "Keep tool calls out of the transcript",
      state: "OPEN",
      author: { login: "m00nk0d3" },
      url: "https://github.com/m00nk0d3/Grove/issues/7",
    }]);
    const presented: unknown[] = [];
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(loadedModelsResponse("current-model"))
      .mockResolvedValueOnce(Response.json({
        choices: [{
          message: {
            content: [
              "<tool_call>",
              "<function=github_read>",
              '<parameter=payload>{"owner":"m00nk0d3","name":"Grove"}</parameter>',
              "<parameter=operation>list_issues</parameter>",
              "</function>",
              "</tool_call>",
            ].join(" "),
          },
        }],
      }))
      .mockResolvedValueOnce(noToolSelectionResponse());

    let result = "";
    for await (
      const token of streamLMStudioResponse("Show me the issues.", {
        onStructuredResult: (presentation) => {
          presented.push(presentation);
        },
      })
    ) {
      result += token;
    }

    expect(result).toBe("I put the repository issues on screen.");
    expect(githubService.read).toHaveBeenCalledWith(
      "list_issues",
      "m00nk0d3/Grove",
      {},
    );
    expect(presented).toEqual([expect.objectContaining({
      title: "m00nk0d3/Grove issues",
      content: expect.stringContaining(
        "#7 — Keep tool calls out of the transcript",
      ),
    })]);
  });

  it("fails closed if tool-call markup reaches the final response", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(loadedModelsResponse("current-model"))
      .mockResolvedValueOnce(noToolSelectionResponse())
      .mockResolvedValueOnce(streamingResponse([
        { choices: [{ delta: { content: "<tool_" } }] },
        {
          choices: [{
            delta: {
              content:
                "call><function=github_read></function></tool_call>",
            },
          }],
        },
      ]));

    const consume = async () => {
      for await (
        const token of streamLMStudioResponse("Answer conversationally.")
      ) {
        void token;
      }
    };

    await expect(consume()).rejects.toThrow(
      "LM Studio returned an unexecuted tool call",
    );
  });

  it("lists GitHub repositories without model-based tool selection", async () => {
    const read = vi.spyOn(githubService, "read").mockResolvedValue([{
      nameWithOwner: "m00nk0d3/spectre",
      description: "Local AI assistant",
      isPrivate: false,
      isArchived: false,
      defaultBranchRef: { name: "main" },
      updatedAt: "2026-10-03T00:00:00Z",
    }]);
    const presented: unknown[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(loadedModelsResponse("current-model"));

    let result = "";
    for await (
      const token of streamLMStudioResponse(
        "Look at my GitHub repos, please.",
        {
          onStructuredResult: (presentation) => {
            presented.push(presentation);
          },
        },
      )
    ) {
      result += token;
    }

    expect(result).toBe("I put the repository list on screen.");
    expect(presented).toEqual([{
      title: "GitHub repositories",
      content: [
        "Repositories visible to the active GitHub account: 1",
        "- m00nk0d3/spectre — Public — Default: main — Updated: 2026-10-03T00:00:00Z — Local AI assistant",
      ].join("\n"),
      spokenHint: "I put the repository list on screen.",
      memoryText: [
        "Repositories visible to the active GitHub account: 1",
        "- m00nk0d3/spectre — Public — Default: main — Updated: 2026-10-03T00:00:00Z — Local AI assistant",
      ].join("\n"),
    }]);
    expect(read).toHaveBeenCalledWith(
      "list_repositories",
      undefined,
      { limit: 100 },
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("presents directory listings directly from system results", async () => {
    vi.spyOn(systemService, "read").mockResolvedValue([
      { name: "spectre", path: "/home/user/dev/spectre", type: "directory" },
      { name: "notes.txt", path: "/home/user/dev/notes.txt", type: "file" },
    ]);
    const presented: unknown[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(loadedModelsResponse("current-model"));

    let result = "";
    for await (
      const token of streamLMStudioResponse("Show me my dev directory", {
        onStructuredResult: (presentation) => {
          presented.push(presentation);
        },
      })
    ) {
      result += token;
    }

    expect(result).toBe("I put the directory listing on screen.");
    expect(presented).toEqual([expect.objectContaining({
      title: "Directory: ~/dev",
      content: expect.stringContaining(
        "- spectre — directory — /home/user/dev/spectre",
      ),
    })]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("lets the model autonomously select public web research", async () => {
    const research = vi.spyOn(webResearchService, "research")
      .mockResolvedValue({
        query: "TypeScript 7 changes",
        readableSourceCount: 1,
        sources: [{
          title: "TypeScript 7",
          url: "https://example.com/typescript-7",
          content: "Current release information.",
        }],
      });
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(loadedModelsResponse("current-model"))
      .mockResolvedValueOnce(Response.json({
        choices: [{
          message: {
            tool_calls: [{
              id: "call_web",
              type: "function",
              function: {
                name: "research_web",
                arguments: '{"query":"TypeScript 7 changes","limit":2}',
              },
            }],
          },
        }],
      }))
      .mockResolvedValueOnce(noToolSelectionResponse())
      .mockResolvedValueOnce(streamingResponse([
        { choices: [{ delta: { content: "TypeScript changed." } }] },
      ]));

    let result = "";
    for await (
      const token of streamLMStudioResponse(
        "What changed in TypeScript 7?",
      )
    ) {
      result += token;
    }

    expect(result).toBe(
      "TypeScript changed. Sources: https://example.com/typescript-7.",
    );
    expect(research).toHaveBeenCalledWith("TypeScript 7 changes", 2);
    const selectionRequest = JSON.parse(
      String(fetchMock.mock.calls[1][1]?.body),
    ) as {
      tool_choice: string;
      tools: Array<{ function: { name: string } }>;
    };
    expect(selectionRequest.tool_choice).toBe("auto");
    expect(
      selectionRequest.tools.map((tool) => tool.function.name),
    ).toEqual(expect.arrayContaining([
      "research_web",
      "fetch_web_page",
      "github_read",
      "system_read",
    ]));
    const finalRequest = JSON.parse(
      String(fetchMock.mock.calls[3][1]?.body),
    ) as {
      messages: Array<{
        role: string;
        content?: string;
        tool_call_id?: string;
      }>;
    };
    expect(finalRequest.messages).toContainEqual(
      expect.objectContaining({
        role: "tool",
        tool_call_id: "call_web",
        content: expect.stringContaining("Current release information."),
      }),
    );
    expect(finalRequest.messages[0].content).toContain(
      "apply it directly to the user's actual task",
    );
  });

  it("composes different tools across multiple planning rounds", async () => {
    vi.spyOn(sandcastleService, "listProjects").mockResolvedValue([{
      name: "spectre",
      path: "/home/user/dev/spectre",
      branch: "main",
      remote: "https://github.com/m00nk0d3/spectre.git",
    }]);
    const githubRead = vi.spyOn(githubService, "read").mockResolvedValue([{
      number: 42,
      title: "Agent loop",
    }]);
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(loadedModelsResponse("current-model"))
      .mockResolvedValueOnce(Response.json({
        choices: [{
          message: {
            tool_calls: [{
              id: "call_projects",
              type: "function",
              function: {
                name: "list_projects",
                arguments: "{}",
              },
            }],
          },
        }],
      }))
      .mockResolvedValueOnce(Response.json({
        choices: [{
          message: {
            tool_calls: [{
              id: "call_issues",
              type: "function",
              function: {
                name: "github_read",
                arguments: JSON.stringify({
                  operation: "list_issues",
                  repository: "m00nk0d3/spectre",
                  payload: '{"state":"open"}',
                }),
              },
            }],
          },
        }],
      }))
      .mockResolvedValueOnce(noToolSelectionResponse())
      .mockResolvedValueOnce(streamingResponse([
        {
          choices: [{
            delta: {
              content:
                "I found the local project and issue 42 is open.",
            },
          }],
        },
      ]));

    const progress: Array<{ message: string; spokenHint?: string }> = [];
    let result = "";
    for await (
      const token of streamLMStudioResponse(
        "Find my Spectre project and inspect its open GitHub issues.",
        {
          onProgress: (update) => {
            progress.push({
              message: update.message,
              spokenHint: update.spokenHint,
            });
          },
        },
      )
    ) {
      result += token;
    }

    expect(result).toBe(
      "I found the local project and issue 42 is open.",
    );
    expect(githubRead).toHaveBeenCalledWith(
      "list_issues",
      "m00nk0d3/spectre",
      { state: "open" },
    );
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(progress.map((update) => update.message)).toEqual(
      expect.arrayContaining([
        "Inspecting local projects",
        "Reviewing results and planning the next step",
        "Inspecting GitHub",
        "Preparing the final result",
      ]),
    );
    expect(progress).toEqual(expect.arrayContaining([
      expect.objectContaining({
        message: "Reviewing results and planning the next step",
        spokenHint:
          "I'm working on it, man. Give me a minute.",
      }),
    ]));
    const secondPlanningRequest = JSON.parse(
      String(fetchMock.mock.calls[2][1]?.body),
    ) as {
      messages: Array<{
        role: string;
        tool_call_id?: string;
        content?: string;
      }>;
    };
    expect(secondPlanningRequest.messages).toContainEqual(
      expect.objectContaining({
        role: "tool",
        tool_call_id: "call_projects",
        content: expect.stringContaining("/home/user/dev/spectre"),
      }),
    );
  });

  it("presents one repository from a short owned name", async () => {
    const githubRead = vi.spyOn(githubService, "read").mockResolvedValue({
      nameWithOwner: "m00nk0d3/Grove",
      description: "Local agent orchestrator",
      isPrivate: true,
      isArchived: false,
      defaultBranchRef: { name: "main" },
      url: "https://github.com/m00nk0d3/Grove",
      homepageUrl: "",
      licenseInfo: null,
      repositoryTopics: { nodes: [{ name: "agents" }] },
      viewerPermission: "ADMIN",
    });
    const presented: unknown[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(loadedModelsResponse("current-model"))
      .mockResolvedValueOnce(Response.json({
        choices: [{
          message: {
            tool_calls: [{
              id: "call_repository",
              type: "function",
              function: {
                name: "github_read",
                arguments: JSON.stringify({
                  operation: "get_repository",
                  repository: "Grove",
                  payload: "{}",
                }),
              },
            }],
          },
        }],
      }))
      .mockResolvedValueOnce(noToolSelectionResponse());

    let result = "";
    for await (
      const token of streamLMStudioResponse(
        "Inspect my Grove repository and put the details on screen.",
        {
          onStructuredResult: (presentation) => {
            presented.push(presentation);
          },
        },
      )
    ) {
      result += token;
    }

    expect(result).toBe("I put the repository details on screen.");
    expect(githubRead).toHaveBeenCalledWith(
      "get_repository",
      "Grove",
      {},
    );
    expect(presented).toEqual([expect.objectContaining({
      title: "m00nk0d3/Grove",
      content: expect.stringContaining(
        "- Description — Local agent orchestrator",
      ),
    })]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("blocks repeated identical tool calls and asks the planner to adapt", async () => {
    const listProjects = vi.spyOn(sandcastleService, "listProjects")
      .mockResolvedValue([]);
    const repeatedSelection = Response.json({
      choices: [{
        message: {
          tool_calls: [{
            id: "call_projects_2",
            type: "function",
            function: {
              name: "list_projects",
              arguments: "{}",
            },
          }],
        },
      }],
    });
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(loadedModelsResponse("current-model"))
      .mockResolvedValueOnce(Response.json({
        choices: [{
          message: {
            tool_calls: [{
              id: "call_projects_1",
              type: "function",
              function: {
                name: "list_projects",
                arguments: "{}",
              },
            }],
          },
        }],
      }))
      .mockResolvedValueOnce(repeatedSelection)
      .mockResolvedValueOnce(noToolSelectionResponse())
      .mockResolvedValueOnce(streamingResponse([
        {
          choices: [{
            delta: { content: "I could not resolve the requested project." },
          }],
        },
      ]));

    let result = "";
    for await (
      const token of streamLMStudioResponse(
        "Find the relevant project even if my wording is unusual.",
      )
    ) {
      result += token;
    }

    expect(result).toBe("I could not resolve the requested project.");
    expect(listProjects).toHaveBeenCalledOnce();
    const thirdPlanningRequest = JSON.parse(
      String(fetchMock.mock.calls[3][1]?.body),
    ) as {
      messages: Array<{
        role: string;
        content?: string;
        tool_call_id?: string;
      }>;
    };
    expect(thirdPlanningRequest.messages).toContainEqual(
      expect.objectContaining({
        role: "tool",
        tool_call_id: "call_projects_2",
        content: expect.stringContaining(
          "Repeated identical tool call blocked",
        ),
      }),
    );
  });

  it("fails closed when web research retrieves no readable evidence", async () => {
    vi.spyOn(webResearchService, "research").mockResolvedValue({
      query: "bananas",
      readableSourceCount: 0,
      sources: [{
        title: "Blocked source",
        url: "https://example.com/blocked",
        error: "Public web request returned HTTP 403",
      }],
    });

    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(loadedModelsResponse("current-model"));

    let result = "";
    for await (
      const token of streamLMStudioResponse("Research bananas online")
    ) {
      result += token;
    }

    expect(result).toContain(
      "I couldn't access readable public sources",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("allocates a larger response budget for explicit research reports", async () => {
    vi.spyOn(webResearchService, "research").mockResolvedValue({
      query: "bananas",
      readableSourceCount: 1,
      sources: [{
        title: "Bananas",
        url: "https://example.com/bananas",
        content: "Readable banana evidence.",
      }],
    });

    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(loadedModelsResponse("current-model"))
      .mockResolvedValueOnce(streamingResponse([
        { choices: [{ delta: { content: "Detailed report." } }] },
      ]));

    for await (
      const token of streamLMStudioResponse(
        "Do some research online on bananas.",
      )
    ) {
      void token;
    }

    const request = JSON.parse(
      String(fetchMock.mock.calls[1][1]?.body),
    ) as { max_tokens: number };
    expect(request.max_tokens).toBe(2_048);
  });

  it("forces complete long-form guide content for visual presentation", async () => {
    const completeGuide = [
      "GitHub CLI guide",
      "",
      "Authentication",
      "Use gh auth login to authenticate securely and gh auth status to verify the active account.",
      "",
      "Repository workflows",
      "Use gh repo list to inspect repositories, gh repo clone to clone one, and gh repo view to inspect details.",
      "",
      "Pull requests",
      "Use gh pr create, gh pr view, gh pr checkout, gh pr review, and gh pr merge for the normal review lifecycle.",
      "",
      "Issues and Actions",
      "Use gh issue list and gh issue create for issue work. Use gh run list, gh run view, and gh workflow run for Actions.",
      "",
      "Safety and troubleshooting",
      "Check the active account and repository before mutations. Use --help on any command and inspect errors before retrying.",
    ].join("\n");
    const sourceUrl = "https://cli.github.com/manual/";
    const research = vi.spyOn(webResearchService, "research")
      .mockResolvedValue({
        query:
          "site:cli.github.com/manual GitHub CLI official manual commands authentication repositories issues pull requests actions",
        readableSourceCount: 1,
        sources: [{
          title: "GitHub CLI manual",
          url: sourceUrl,
          content: "Official GitHub CLI command reference.",
        }],
      });
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(loadedModelsResponse("current-model"))
      .mockResolvedValueOnce(Response.json({
        choices: [{
          message: {
            content:
              "I have prepared a complete reference document. Please review the material on screen.",
          },
        }],
      }))
      .mockResolvedValueOnce(Response.json({
        choices: [{
          message: { content: completeGuide },
        }],
      }));

    let result = "";
    for await (
      const token of streamLMStudioResponse(
        "Give me a comprehensive guide on how to use the GH tool like GitHub CLI",
      )
    ) {
      result += token;
    }

    expect(result).toBe(`${completeGuide}\n\nSources: ${sourceUrl}`);
    expect(research).toHaveBeenCalledOnce();
    const request = JSON.parse(
      String(fetchMock.mock.calls[1][1]?.body),
    ) as {
      max_tokens: number;
      messages: Array<{ role: string; content: string }>;
    };
    expect(request.max_tokens).toBe(2_048);
    expect(request.messages[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining(
        "Write the complete requested guide",
      ),
    });
    expect(
      request.messages.slice(1).some((message) => message.role === "system"),
    ).toBe(false);
    expect(request.messages).toContainEqual({
      role: "user",
      content:
        "Give me a comprehensive guide on how to use the GH tool like GitHub CLI",
    });
    expect(request.messages.at(-1)).toMatchObject({
      role: "tool",
      content: expect.stringContaining(sourceUrl),
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const retryRequest = JSON.parse(
      String(fetchMock.mock.calls[2][1]?.body),
    ) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(retryRequest.messages.at(-1)?.content).toContain(
      "only a placeholder",
    );
    expect(isUsableLongFormPresentation(completeGuide)).toBe(true);
    expect(isUsableLongFormPresentation(
      "I have prepared a complete reference document. Please review the material on screen.",
    )).toBe(false);
  });

  it("checks tools before streaming an ordinary response", async () => {
    const progress: string[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(loadedModelsResponse("current-model"))
      .mockResolvedValueOnce(noToolSelectionResponse())
      .mockResolvedValueOnce(streamingResponse([
        { choices: [{ delta: { content: "Certainly, " } }] },
        { choices: [{ delta: { content: "sir." } }] },
      ]));

    let result = "";
    for await (
      const token of streamLMStudioResponse("Hello", {
        onProgress: (update) => {
          progress.push(update.message);
        },
      })
    ) {
      result += token;
    }

    expect(result).toBe("Certainly, sir.");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://127.0.0.1:1234/api/v1/models",
    );
    const request = JSON.parse(
      String(fetchMock.mock.calls[2][1]?.body),
    ) as Record<string, unknown>;
    expect(request.tools).toBeUndefined();
    expect(request.model).toBe("current-model");
    expect(request.max_tokens).toBe(256);
    expect(progress).toEqual([]);
  });

  it("places recalled conversation before the current user prompt", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(loadedModelsResponse("current-model"))
      .mockResolvedValueOnce(noToolSelectionResponse())
      .mockResolvedValueOnce(streamingResponse([
        { choices: [{ delta: { content: "I remember." } }] },
      ]));

    for await (
      const token of streamLMStudioResponse("What editor do I use?", {
        memoryContext:
          "Local conversation memory: User previously said Neovim.",
      })
    ) {
      void token;
    }

    const request = JSON.parse(
      String(fetchMock.mock.calls[2][1]?.body),
    ) as { messages: Array<{ role: string; content: string }> };
    expect(request.messages[0]).toMatchObject({
      role: "system",
    });
    expect(request.messages[0].content).toContain(
      "Local conversation memory: User previously said Neovim.",
    );
    expect(request.messages.at(-2)).toEqual({
      role: "assistant",
      content: "Of course. Tell me what you need.",
    });
    expect(request.messages.at(-1)).toEqual({
      role: "user",
      content: "What editor do I use?",
    });
  });

  it("answers normally when the agent decides no tool is needed", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(loadedModelsResponse("current-model"))
      .mockResolvedValueOnce(noToolSelectionResponse())
      .mockResolvedValueOnce(streamingResponse([
        { choices: [{ delta: { content: "No tool was needed." } }] },
      ]));

    let result = "";
    for await (
      const token of streamLMStudioResponse("Answer conversationally.")
    ) {
      result += token;
    }

    expect(result).toBe("No tool was needed.");
    expect(fetchMock).toHaveBeenCalledTimes(3);
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
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(noToolSelectionResponse())
      .mockResolvedValueOnce(streamingResponse([
        { choices: [{ delta: { content: "Ready." } }] },
      ]));

    let result = "";
    for await (
      const token of streamLMStudioResponse("Hello", {
        model: "chosen-model",
      })
    ) {
      result += token;
    }

    expect(result).toBe("Ready.");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const request = JSON.parse(
      String(fetchMock.mock.calls[1][1]?.body),
    ) as Record<string, unknown>;
    expect(request.model).toBe("chosen-model");
  });
});
