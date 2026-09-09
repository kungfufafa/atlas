import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { JsonRpcStdioClient, type JsonRpcStdioProcess } from "../jsonrpc-stdio";
import { CodexAppServer } from "./app-server";

class FakeProcess extends EventEmitter implements JsonRpcStdioProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  pid = 1;

  kill(): void {
    this.emit("exit", 0);
  }
}

interface RpcRequest {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

function observeRequests(
  child: FakeProcess,
  handler: (request: RpcRequest) => void
): void {
  child.stdin.on("data", (chunk) => {
    for (const line of String(chunk).split("\n")) {
      if (!line.trim()) {
        continue;
      }
      const request = JSON.parse(line) as RpcRequest;
      if (typeof request.method === "string") {
        handler(request);
      }
    }
  });
}

function send(child: FakeProcess, message: unknown): void {
  child.stdout.write(`${JSON.stringify(message)}\n`);
}

describe("CodexAppServer protocol", () => {
  const processes: FakeProcess[] = [];
  const tinyPngBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  afterEach(() => {
    for (const child of processes) {
      child.kill();
    }
    processes.length = 0;
  });

  test("preserves model-advertised reasoning efforts in runtime order", async () => {
    const child = new FakeProcess();
    processes.push(child);
    observeRequests(child, (request) => {
      if (request.method !== "model/list") {
        return;
      }
      send(child, {
        id: request.id,
        result: {
          data: [
            {
              defaultReasoningEffort: "medium",
              displayName: "GPT-5.6 Sol",
              id: "gpt-5.6-sol",
              inputModalities: ["text", "image", "image"],
              isDefault: true,
              supportedReasoningEfforts: [
                { description: "Off", reasoningEffort: "none" },
                { description: "Balanced", reasoningEffort: "medium" },
                { description: "Maximum", reasoningEffort: "max" },
              ],
            },
          ],
        },
      });
    });
    const server = new CodexAppServer({
      client: new JsonRpcStdioClient(child),
    });

    await expect(server.listModels()).resolves.toEqual([
      {
        defaultReasoningEffort: "medium",
        displayName: "GPT-5.6 Sol",
        id: "gpt-5.6-sol",
        inputModalities: ["text", "image"],
        isDefault: true,
        reasoningEffortValues: ["none", "medium", "max"],
      },
    ]);
    server.close();
  });

  test("reads model-provider capabilities without inferring them", async () => {
    const child = new FakeProcess();
    processes.push(child);
    observeRequests(child, (request) => {
      if (request.method === "modelProvider/capabilities/read") {
        send(child, {
          id: request.id,
          result: {
            imageGeneration: true,
            namespaceTools: false,
            webSearch: false,
          },
        });
      }
    });
    const server = new CodexAppServer({
      client: new JsonRpcStdioClient(child),
    });

    await expect(server.readModelProviderCapabilities()).resolves.toEqual({
      imageGeneration: true,
      namespaceTools: false,
      webSearch: false,
    });
    server.close();
  });

  test("starts and resumes isolated read-only threads", async () => {
    const child = new FakeProcess();
    processes.push(child);
    const requests: RpcRequest[] = [];
    observeRequests(child, (request) => {
      requests.push(request);
      send(child, {
        id: request.id,
        result: { thread: { id: "thread-1" } },
      });
    });
    const server = new CodexAppServer({
      client: new JsonRpcStdioClient(child),
    });

    await server.startThread({
      cwd: "/tmp/atlas-subscription",
      developerInstructions: "Stay in Atlas.",
      model: "gpt-test",
    });
    await server.resumeThread("thread-1", {
      cwd: "/tmp/atlas-subscription",
      developerInstructions: "Updated instructions.",
      model: "gpt-test-2",
    });

    expect(requests[0]).toMatchObject({
      method: "thread/start",
      params: {
        approvalPolicy: "never",
        config: {
          features: { shell_tool: false, unified_exec: false },
          mcp_servers: {},
          web_search: "disabled",
        },
        sandbox: "read-only",
      },
    });
    expect(requests[1]).toMatchObject({
      method: "thread/resume",
      params: {
        developerInstructions: "Updated instructions.",
        model: "gpt-test-2",
        sandbox: "read-only",
        threadId: "thread-1",
      },
    });
    server.close();
  });

  test("enables only image generation on a dedicated isolated thread", async () => {
    const child = new FakeProcess();
    processes.push(child);
    let start: RpcRequest | undefined;
    observeRequests(child, (request) => {
      if (request.method === "thread/start") {
        start = request;
        send(child, {
          id: request.id,
          result: { thread: { id: "image-thread" } },
        });
      }
    });
    const server = new CodexAppServer({
      client: new JsonRpcStdioClient(child),
    });

    await server.startThread({
      cwd: "/tmp/atlas-subscription",
      ephemeral: true,
      imageGeneration: true,
      model: "gpt-test",
    });

    expect(start).toMatchObject({
      params: {
        approvalPolicy: "never",
        config: {
          features: {
            apps: false,
            browser_use: false,
            computer_use: false,
            image_generation: true,
            in_app_browser: false,
            multi_agent: false,
            plugins: false,
            shell_tool: false,
            skill_search: false,
            unified_exec: false,
            view_image: false,
            workspace_dependencies: false,
          },
          mcp_servers: {},
          web_search: "disabled",
        },
        ephemeral: true,
        sandbox: "read-only",
      },
    });
    server.close();
  });

  test("isolates interleaved notifications by thread and turn", async () => {
    const child = new FakeProcess();
    processes.push(child);
    const starts = new Map<string, RpcRequest>();
    observeRequests(child, (request) => {
      if (request.method !== "turn/start") {
        return;
      }
      const threadId = String(request.params.threadId);
      starts.set(threadId, request);
      send(child, {
        id: request.id,
        result: { turn: { id: `turn-${threadId}` } },
      });
      if (starts.size !== 2) {
        return;
      }
      for (const [currentThreadId] of starts) {
        send(child, {
          method: "item/agentMessage/delta",
          params: {
            delta: currentThreadId === "alpha" ? " alpha " : "beta",
            threadId: currentThreadId,
            turnId: `turn-${currentThreadId}`,
          },
        });
        send(child, {
          method: "item/reasoning/summaryTextDelta",
          params: {
            delta: `think-${currentThreadId}`,
            threadId: currentThreadId,
            turnId: `turn-${currentThreadId}`,
          },
        });
        send(child, {
          method: "thread/tokenUsage/updated",
          params: {
            threadId: currentThreadId,
            tokenUsage: {
              last: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
              modelContextWindow:
                currentThreadId === "alpha" ? 258_400 : 950_000,
              total: {
                inputTokens: 40_000,
                outputTokens: 10_000,
                totalTokens: 50_000,
              },
            },
            turnId: `turn-${currentThreadId}`,
          },
        });
        send(child, {
          method: "turn/completed",
          params: {
            threadId: currentThreadId,
            turn: {
              error: null,
              id: `turn-${currentThreadId}`,
              status: "completed",
            },
          },
        });
      }
    });
    const server = new CodexAppServer({
      client: new JsonRpcStdioClient(child),
      turnTimeoutMs: 1000,
    });
    const alphaChunks: string[] = [];
    const betaChunks: string[] = [];

    const [alpha, beta] = await Promise.all([
      server.startTurn({
        effort: "high",
        input: "one",
        onDelta: (delta) => alphaChunks.push(delta),
        summary: "auto",
        threadId: "alpha",
      }),
      server.startTurn({
        input: "two",
        onDelta: (delta) => betaChunks.push(delta),
        threadId: "beta",
      }),
    ]);

    expect(alpha).toMatchObject({
      contextUsage: { contextWindow: 258_400, usedTokens: 5 },
      text: " alpha ",
      thinking: "think-alpha",
      usage: undefined,
    });
    expect(beta).toMatchObject({
      contextUsage: { contextWindow: 950_000, usedTokens: 5 },
      text: "beta",
      thinking: "think-beta",
    });
    expect(alphaChunks).toEqual([" alpha "]);
    expect(betaChunks).toEqual(["beta"]);
    expect(starts.get("alpha")).toMatchObject({
      params: { effort: "high", summary: "auto" },
    });
    server.close();
  });

  test("keeps the latest native context snapshot when completion reports turn usage", async () => {
    const child = new FakeProcess();
    processes.push(child);
    observeRequests(child, (request) => {
      if (request.method !== "turn/start") {
        return;
      }
      // Notifications can arrive before turn/start's response, including a
      // lower context count after native compaction during the same turn.
      for (const usedTokens of [240_000, 12_000]) {
        send(child, {
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "thread-1",
            tokenUsage: {
              last: { totalTokens: usedTokens },
              modelContextWindow: 258_400,
              total: { totalTokens: 900_000 },
            },
            turnId: "turn-1",
          },
        });
      }
      send(child, {
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thread-1",
          tokenUsage: {
            last: { totalTokens: 99_000 },
            modelContextWindow: 950_000,
          },
          turnId: "old-turn",
        },
      });
      send(child, {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: {
            id: "turn-1",
            status: "completed",
            usage: {
              inputTokens: 15_000,
              outputTokens: 500,
              totalTokens: 15_500,
            },
          },
        },
      });
      send(child, { id: request.id, result: { turn: { id: "turn-1" } } });
    });
    const server = new CodexAppServer({
      client: new JsonRpcStdioClient(child),
    });

    const result = await server.startTurn({
      input: "hi",
      threadId: "thread-1",
    });

    expect(result.contextUsage).toEqual({
      contextWindow: 258_400,
      usedTokens: 12_000,
    });
    expect(result.usage).toEqual({
      inputTokens: 15_000,
      outputTokens: 500,
      totalTokens: 15_500,
    });
    server.close();
  });

  test.each([
    {
      expected: 15,
      last: { inputTokens: 12, outputTokens: 3 },
      modelContextWindow: 258_400,
    },
    { expected: 0, last: { totalTokens: 0 }, modelContextWindow: 258_400 },
    {
      expected: undefined,
      last: { totalTokens: 12 },
      modelContextWindow: null,
    },
    { expected: undefined, last: { totalTokens: 12 }, modelContextWindow: 0 },
    { expected: undefined, last: { totalTokens: 12 }, modelContextWindow: -1 },
    {
      expected: undefined,
      last: { totalTokens: -1 },
      modelContextWindow: 258_400,
    },
    {
      expected: undefined,
      last: { totalTokens: 1.5 },
      modelContextWindow: 258_400,
    },
    { expected: undefined, last: {}, modelContextWindow: 258_400 },
  ])(
    "validates native context metadata %#",
    async ({ last, modelContextWindow, expected }) => {
      const child = new FakeProcess();
      processes.push(child);
      observeRequests(child, (request) => {
        if (request.method !== "turn/start") {
          return;
        }
        send(child, { id: request.id, result: { turn: { id: "turn-1" } } });
        send(child, {
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "thread-1",
            tokenUsage: {
              last,
              modelContextWindow,
              total: { totalTokens: 80_000 },
            },
            turnId: "turn-1",
          },
        });
        send(child, {
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed" },
          },
        });
      });
      const server = new CodexAppServer({
        client: new JsonRpcStdioClient(child),
      });

      const result = await server.startTurn({
        input: "hi",
        threadId: "thread-1",
      });

      expect(result.contextUsage).toEqual(
        expected === undefined
          ? undefined
          : {
              contextWindow: modelContextWindow,
              usedTokens: expected,
            }
      );
      server.close();
    }
  );

  test("passes structured image input to turn/start unchanged", async () => {
    const child = new FakeProcess();
    processes.push(child);
    let start: RpcRequest | undefined;
    observeRequests(child, (request) => {
      if (request.method !== "turn/start") {
        return;
      }
      start = request;
      send(child, {
        id: request.id,
        result: { turn: { id: "turn-image" } },
      });
      send(child, {
        method: "turn/completed",
        params: {
          threadId: "thread-image",
          turn: { id: "turn-image", status: "completed" },
        },
      });
    });
    const server = new CodexAppServer({
      client: new JsonRpcStdioClient(child),
      turnTimeoutMs: 1000,
    });

    await server.startTurn({
      input: [
        { text: "Inspect this image", text_elements: [], type: "text" },
        {
          type: "image",
          url: `data:image/png;base64,${tinyPngBase64}`,
        },
      ],
      threadId: "thread-image",
    });

    expect(start?.params.input).toEqual([
      { text: "Inspect this image", text_elements: [], type: "text" },
      {
        type: "image",
        url: `data:image/png;base64,${tinyPngBase64}`,
      },
    ]);
    server.close();
  });

  test("captures and validates a generated PNG item", async () => {
    const child = new FakeProcess();
    processes.push(child);
    observeRequests(child, (request) => {
      if (request.method !== "turn/start") {
        return;
      }
      send(child, {
        id: request.id,
        result: { turn: { id: "turn-generation" } },
      });
      send(child, {
        method: "item/completed",
        params: {
          item: {
            failure: null,
            id: "image-1",
            model: "gpt-image-custom",
            result: tinyPngBase64,
            revisedPrompt: "A tiny pixel",
            savedPath: "/untrusted/path.png",
            status: "completed",
            type: "imageGeneration",
          },
          threadId: "thread-generation",
          turnId: "turn-generation",
        },
      });
      send(child, {
        method: "item/completed",
        params: {
          item: {
            failure: null,
            id: "image-2",
            result: tinyPngBase64,
            status: "completed",
            type: "imageGeneration",
          },
          threadId: "thread-generation",
          turnId: "turn-generation",
        },
      });
      send(child, {
        method: "turn/completed",
        params: {
          threadId: "thread-generation",
          turn: { id: "turn-generation", status: "completed" },
        },
      });
    });
    const server = new CodexAppServer({
      client: new JsonRpcStdioClient(child),
      turnTimeoutMs: 1000,
    });

    const result = await server.startTurn({
      input: "Generate an image",
      threadId: "thread-generation",
    });

    expect(result.generatedImages).toEqual([
      {
        data: Uint8Array.from(Buffer.from(tinyPngBase64, "base64")),
        height: 1,
        id: "image-1",
        mediaType: "image/png",
        model: "gpt-image-custom",
        revisedPrompt: "A tiny pixel",
        status: "completed",
        width: 1,
      },
      {
        data: Uint8Array.from(Buffer.from(tinyPngBase64, "base64")),
        height: 1,
        id: "image-2",
        mediaType: "image/png",
        model: "gpt-image-2",
        status: "completed",
        width: 1,
      },
    ]);
    expect(result.generatedImages?.[0]).not.toHaveProperty("savedPath");
    server.close();
  });

  test("rejects malformed generated image data", async () => {
    const child = new FakeProcess();
    processes.push(child);
    const requests: RpcRequest[] = [];
    observeRequests(child, (request) => {
      requests.push(request);
      if (request.method === "turn/interrupt") {
        send(child, { id: request.id, result: {} });
        return;
      }
      if (request.method !== "turn/start") {
        return;
      }
      send(child, {
        id: request.id,
        result: { turn: { id: "turn-invalid-image" } },
      });
      send(child, {
        method: "item/completed",
        params: {
          item: {
            failure: null,
            id: "image-invalid",
            result: "not base64!",
            status: "completed",
            type: "imageGeneration",
          },
          threadId: "thread-invalid-image",
          turnId: "turn-invalid-image",
        },
      });
    });
    const server = new CodexAppServer({
      client: new JsonRpcStdioClient(child),
      turnTimeoutMs: 1000,
    });

    await expect(
      server.startTurn({
        input: "Generate an image",
        threadId: "thread-invalid-image",
      })
    ).rejects.toThrow("invalid base64");
    await Bun.sleep(0);
    expect(
      requests.filter((request) => request.method === "turn/interrupt")
    ).toHaveLength(1);
    server.close();
  });

  test("interrupts exactly once when a streaming callback throws", async () => {
    const child = new FakeProcess();
    processes.push(child);
    const requests: RpcRequest[] = [];
    observeRequests(child, (request) => {
      requests.push(request);
      if (request.method === "turn/interrupt") {
        send(child, { id: request.id, result: {} });
        return;
      }
      if (request.method !== "turn/start") {
        return;
      }
      send(child, {
        id: request.id,
        result: { turn: { id: "turn-callback-error" } },
      });
      send(child, {
        method: "item/agentMessage/delta",
        params: {
          delta: "partial",
          threadId: "thread-callback-error",
          turnId: "turn-callback-error",
        },
      });
    });
    const server = new CodexAppServer({
      client: new JsonRpcStdioClient(child),
      turnTimeoutMs: 1000,
    });

    await expect(
      server.startTurn({
        input: "hello",
        onDelta: () => {
          throw new Error("consumer callback failed");
        },
        threadId: "thread-callback-error",
      })
    ).rejects.toThrow("consumer callback failed");
    await Bun.sleep(0);

    expect(
      requests.filter((request) => request.method === "turn/interrupt")
    ).toHaveLength(1);
    server.close();
  });

  test("rejects non-completed terminal statuses", async () => {
    for (const status of ["unknown", "inProgress"]) {
      const child = new FakeProcess();
      processes.push(child);
      const requests: RpcRequest[] = [];
      observeRequests(child, (request) => {
        requests.push(request);
        if (request.method === "turn/interrupt") {
          send(child, { id: request.id, result: {} });
          return;
        }
        if (request.method !== "turn/start") {
          return;
        }
        send(child, {
          id: request.id,
          result: { turn: { id: `turn-${status}` } },
        });
        send(child, {
          method: "turn/completed",
          params: {
            threadId: `thread-${status}`,
            turn: { id: `turn-${status}`, status },
          },
        });
      });
      const server = new CodexAppServer({
        client: new JsonRpcStdioClient(child),
        turnTimeoutMs: 1000,
      });

      await expect(
        server.startTurn({ input: "hello", threadId: `thread-${status}` })
      ).rejects.toThrow(`unexpected status "${status}"`);
      await Bun.sleep(0);
      expect(
        requests.filter((request) => request.method === "turn/interrupt")
      ).toHaveLength(1);
      server.close();
    }
  });

  test("rejects failed turns with the runtime error", async () => {
    const child = new FakeProcess();
    processes.push(child);
    observeRequests(child, (request) => {
      if (request.method !== "turn/start") {
        return;
      }
      send(child, {
        id: request.id,
        result: { turn: { id: "turn-failed" } },
      });
      send(child, {
        method: "turn/completed",
        params: {
          threadId: "thread-failed",
          turn: {
            error: { message: "Model unavailable" },
            id: "turn-failed",
            status: "failed",
          },
        },
      });
    });
    const server = new CodexAppServer({
      client: new JsonRpcStdioClient(child),
      turnTimeoutMs: 1000,
    });

    await expect(
      server.startTurn({ input: "hello", threadId: "thread-failed" })
    ).rejects.toThrow("Model unavailable");
    server.close();
  });

  test("rejects an active turn promptly when the runtime exits", async () => {
    const child = new FakeProcess();
    processes.push(child);
    observeRequests(child, (request) => {
      if (request.method === "turn/start") {
        send(child, {
          id: request.id,
          result: { turn: { id: "turn-exit" } },
        });
        queueMicrotask(() => child.emit("exit", 1));
      }
    });
    const server = new CodexAppServer({
      client: new JsonRpcStdioClient(child),
      turnTimeoutMs: 60_000,
    });

    await expect(
      server.startTurn({ input: "hello", threadId: "thread-exit" })
    ).rejects.toThrow("Runtime process exited.");
    server.close();
  });

  test("does not start a turn when cancelled during delayed connection", async () => {
    const child = new FakeProcess();
    processes.push(child);
    const requests: RpcRequest[] = [];
    observeRequests(child, (request) => {
      requests.push(request);
    });
    const client = new JsonRpcStdioClient(child);
    let resolveConnection: (value: JsonRpcStdioClient) => void = () =>
      undefined;
    const delayedConnection = new Promise<JsonRpcStdioClient>((resolve) => {
      resolveConnection = resolve;
    });
    const server = new CodexAppServer();
    (
      server as unknown as {
        connecting: Promise<JsonRpcStdioClient> | null;
      }
    ).connecting = delayedConnection;
    const controller = new AbortController();
    const turn = server.startTurn({
      input: "hello",
      signal: controller.signal,
      threadId: "thread-connect-cancel",
    });
    await Bun.sleep(0);

    controller.abort();
    await expect(turn).rejects.toThrow("Turn cancelled.");
    resolveConnection(client);
    await Bun.sleep(0);

    expect(
      requests.filter((request) => request.method === "turn/start")
    ).toHaveLength(0);
    server.close();
  });

  test("interrupts a turn whose id arrives after cancellation", async () => {
    const child = new FakeProcess();
    processes.push(child);
    const requests: RpcRequest[] = [];
    let resolveStartSeen: () => void = () => undefined;
    const startSeen = new Promise<void>((resolve) => {
      resolveStartSeen = resolve;
    });
    observeRequests(child, (request) => {
      requests.push(request);
      if (request.method === "turn/start") {
        resolveStartSeen();
      }
      if (request.method === "turn/interrupt") {
        send(child, { id: request.id, result: {} });
      }
    });
    const server = new CodexAppServer({
      client: new JsonRpcStdioClient(child),
      turnTimeoutMs: 60_000,
    });
    const controller = new AbortController();
    const turn = server.startTurn({
      input: "hello",
      signal: controller.signal,
      threadId: "thread-cancel",
    });
    await startSeen;

    controller.abort();
    await expect(turn).rejects.toThrow("Turn cancelled.");

    const start = requests.find((request) => request.method === "turn/start");
    send(child, {
      id: start?.id,
      result: { turn: { id: "turn-late" } },
    });
    await Bun.sleep(0);

    expect(requests).toContainEqual(
      expect.objectContaining({
        method: "turn/interrupt",
        params: {
          threadId: "thread-cancel",
          turnId: "turn-late",
        },
      })
    );
    server.close();
  });

  test("detects login completion even when its notification was missed", async () => {
    const child = new FakeProcess();
    processes.push(child);
    observeRequests(child, (request) => {
      if (request.method === "account/read") {
        send(child, {
          id: request.id,
          result: { account: { type: "chatgpt" } },
        });
      }
    });
    const server = new CodexAppServer({
      client: new JsonRpcStdioClient(child),
    });

    await expect(server.waitForLogin("login-missed")).resolves.toBe(true);
    server.close();
  });
});
