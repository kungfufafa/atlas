import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runWithUserConfigDir } from "@atlas/core";
import type { JsonRpcStdioProcess } from "../jsonrpc-stdio";
import { setChatgptRuntimeForTests } from "../runtimes";
import {
  listSubscriptionSessionDeletionCandidates,
  readSubscriptionSession,
  withSubscriptionSessionLease,
  writeSubscriptionSession,
} from "../session-store";
import {
  CodexAppServer,
  type CodexInputModality,
  type CodexTurnInput,
} from "./app-server";
import { createChatgptProvider } from "./provider";
import { ChatgptSubscriptionRuntime } from "./runtime";

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

class FakeProcess extends EventEmitter implements JsonRpcStdioProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  pid = 1;

  kill(): void {
    this.emit("exit", 0);
  }
}

function writeResponse(process: FakeProcess, payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function withTemporaryUserConfig<T>(
  prefix: string,
  operation: () => Promise<T>
): Promise<T> {
  const configDirectory = await mkdtemp(`/tmp/${prefix}-`);
  try {
    return await runWithUserConfigDir(configDirectory, operation);
  } finally {
    await rm(configDirectory, { force: true, recursive: true });
  }
}

class FakeCodexServer extends CodexAppServer {
  readonly deletedThreads: string[] = [];
  readonly resumeInputs: Array<{ developerInstructions?: string; id: string }> =
    [];
  readonly threadOptions: Array<Parameters<CodexAppServer["startThread"]>[0]> =
    [];
  readonly turnInputs: Array<CodexTurnInput[] | string> = [];
  readonly turnOptions: Array<{
    effort?: string;
    model?: string;
    summary?: string;
  }> = [];
  failTurn = false;
  private startedThreads = 0;

  override isConnected(): boolean {
    return true;
  }

  override async account() {
    return { email: "user@example.com", type: "chatgpt" };
  }

  override async listModels() {
    return [
      {
        defaultReasoningEffort: "medium",
        id: "gpt-test",
        inputModalities: ["text", "image"] as CodexInputModality[],
        isDefault: true,
        reasoningEffortValues: ["low", "medium", "high"],
      },
    ];
  }

  override async readModelProviderCapabilities() {
    return {
      imageGeneration: false,
      namespaceTools: false,
      webSearch: false,
    };
  }

  override async startThread(
    options: Parameters<CodexAppServer["startThread"]>[0]
  ): Promise<string> {
    this.threadOptions.push(options);
    this.startedThreads += 1;
    return `thread-${this.startedThreads}`;
  }

  override async deleteThread(threadId: string): Promise<void> {
    this.deletedThreads.push(threadId);
  }

  override async resumeThread(
    threadId: string,
    options: Parameters<CodexAppServer["resumeThread"]>[1]
  ): Promise<string> {
    this.resumeInputs.push({
      developerInstructions: options.developerInstructions,
      id: threadId,
    });
    return threadId;
  }

  override async startTurn(
    options: Parameters<CodexAppServer["startTurn"]>[0]
  ): ReturnType<CodexAppServer["startTurn"]> {
    if (this.failTurn) {
      throw new Error("turn failed");
    }
    this.turnInputs.push(options.input);
    this.turnOptions.push({
      ...(options.effort ? { effort: options.effort } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.summary ? { summary: options.summary } : {}),
    });
    const text =
      this.turnInputs.length === 1
        ? [
            "I will search.",
            "```atlas-tool-call",
            '{"name":"knowledge_base_search","arguments":{"query":"atlas"}}',
            "```",
          ].join("\n")
        : "The result is 42.";
    options.onDelta?.(text);
    return { text, thinking: "" };
  }
}

class ModelCodexServer extends FakeCodexServer {
  constructor(
    private readonly advertisedEfforts: string[] | undefined,
    private readonly modelId = "gpt-5.6-sol",
    private readonly modalities: CodexInputModality[] | undefined,
    private readonly imageGeneration = false,
    private readonly defaultReasoningEffort?: string
  ) {
    super();
  }

  override async listModels() {
    return [
      {
        displayName: "GPT-5.6 Sol",
        id: this.modelId,
        isDefault: true,
        ...(this.defaultReasoningEffort
          ? { defaultReasoningEffort: this.defaultReasoningEffort }
          : {}),
        ...(this.modalities ? { inputModalities: this.modalities } : {}),
        ...(this.advertisedEfforts
          ? { reasoningEffortValues: this.advertisedEfforts }
          : {}),
      },
    ];
  }

  override async readModelProviderCapabilities() {
    return {
      imageGeneration: this.imageGeneration,
      namespaceTools: false,
      webSearch: false,
    };
  }
}

class ImageGenerationCodexServer extends FakeCodexServer {
  deleteFailure: Error | null = null;
  generatedImages: NonNullable<
    Awaited<ReturnType<CodexAppServer["startTurn"]>>["generatedImages"]
  > = [
    {
      data: Uint8Array.from(Buffer.from(TINY_PNG_BASE64, "base64")),
      height: 1,
      id: "generated-1",
      mediaType: "image/png",
      revisedPrompt: "A refined prompt",
      status: "completed",
      width: 1,
    },
  ];
  logoutCalls = 0;
  turnFailure: Error | null = null;

  override async readModelProviderCapabilities() {
    return {
      imageGeneration: true,
      namespaceTools: false,
      webSearch: false,
    };
  }

  override async startTurn(
    options: Parameters<CodexAppServer["startTurn"]>[0]
  ): ReturnType<CodexAppServer["startTurn"]> {
    if (this.turnFailure) {
      throw this.turnFailure;
    }
    this.turnInputs.push(options.input);
    return {
      generatedImages: this.generatedImages,
      text: "",
      thinking: "",
    };
  }

  override async deleteThread(threadId: string): Promise<void> {
    this.deletedThreads.push(threadId);
    if (this.deleteFailure) {
      throw this.deleteFailure;
    }
  }

  override async logout(): Promise<void> {
    this.logoutCalls += 1;
  }
}

class ControlledOneShotCodexServer extends FakeCodexServer {
  readonly events: string[] = [];
  private markTurnStarted: () => void = () => undefined;
  private releaseTurn: () => void = () => undefined;
  readonly turnStarted = new Promise<void>((resolve) => {
    this.markTurnStarted = resolve;
  });
  private readonly turnRelease = new Promise<void>((resolve) => {
    this.releaseTurn = resolve;
  });

  override async startTurn(
    options: Parameters<CodexAppServer["startTurn"]>[0]
  ): ReturnType<CodexAppServer["startTurn"]> {
    this.events.push("turn:start");
    this.markTurnStarted();
    await this.turnRelease;
    this.events.push("turn:end");
    return await super.startTurn(options);
  }

  override async deleteThread(threadId: string): Promise<void> {
    this.events.push(`delete:${threadId}`);
    await super.deleteThread(threadId);
  }

  override async logout(): Promise<void> {
    this.events.push("logout");
  }

  completeTurn(): void {
    this.releaseTurn();
  }
}

class ControlledImageGenerationCodexServer extends ImageGenerationCodexServer {
  readonly events: string[] = [];
  private markTurnStarted: () => void = () => undefined;
  private releaseTurn: () => void = () => undefined;
  readonly turnStarted = new Promise<void>((resolve) => {
    this.markTurnStarted = resolve;
  });
  private readonly turnRelease = new Promise<void>((resolve) => {
    this.releaseTurn = resolve;
  });

  override async startTurn(
    options: Parameters<CodexAppServer["startTurn"]>[0]
  ): ReturnType<CodexAppServer["startTurn"]> {
    this.events.push("turn:start");
    this.markTurnStarted();
    await this.turnRelease;
    this.events.push("turn:end");
    return await super.startTurn(options);
  }

  override async deleteThread(threadId: string): Promise<void> {
    this.events.push(`delete:${threadId}`);
    await super.deleteThread(threadId);
  }

  override async logout(): Promise<void> {
    this.events.push("logout");
    await super.logout();
  }

  completeTurn(): void {
    this.releaseTurn();
  }
}

class LoginCodexServer extends CodexAppServer {
  accountValue: { email?: string; type: string } | null = null;
  private resolveLoginWait: () => void = () => undefined;
  private readonly loginWait = new Promise<void>((resolve) => {
    this.resolveLoginWait = resolve;
  });

  override isConnected(): boolean {
    return true;
  }

  override async account() {
    return this.accountValue;
  }

  override async startLogin() {
    return { loginId: "login-1" };
  }

  override cancelLogin(): Promise<void> {
    return Promise.resolve();
  }

  override waitForLogin(
    _loginId: string,
    signal?: AbortSignal
  ): Promise<boolean> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        if (error) {
          reject(error);
        } else {
          resolve(true);
        }
      };
      const onAbort = () => finish(new Error("Login cancelled."));
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      void this.loginWait.then(() => finish());
    });
  }

  completeLogin(): void {
    this.resolveLoginWait();
  }
}

class ControlledLogoutCodexServer extends FakeCodexServer {
  readonly events: string[] = [];
  private markLogoutStarted: () => void = () => undefined;
  private releaseLogout: () => void = () => undefined;
  readonly logoutStarted = new Promise<void>((resolve) => {
    this.markLogoutStarted = resolve;
  });
  private readonly logoutRelease = new Promise<void>((resolve) => {
    this.releaseLogout = resolve;
  });

  override async deleteThread(threadId: string): Promise<void> {
    this.events.push(`delete:${threadId}`);
    await super.deleteThread(threadId);
  }

  override async logout(): Promise<void> {
    this.events.push("logout:start");
    this.markLogoutStarted();
    await this.logoutRelease;
    this.events.push("logout:end");
  }

  completeLogout(): void {
    this.releaseLogout();
  }
}

class MissingThreadLogoutCodexServer extends FakeCodexServer {
  logoutCalls = 0;

  override async deleteThread(threadId: string): Promise<void> {
    this.deletedThreads.push(threadId);
    throw new Error(`Thread ${threadId} not found`);
  }

  override async logout(): Promise<void> {
    this.logoutCalls += 1;
  }
}

class PersistenceFailureCodexServer extends FakeCodexServer {
  constructor(private readonly sessionStorePath: string) {
    super();
  }

  override async startTurn(
    options: Parameters<CodexAppServer["startTurn"]>[0]
  ): ReturnType<CodexAppServer["startTurn"]> {
    const result = await super.startTurn(options);
    await writeFile(this.sessionStorePath, '{"sessions":', "utf8");
    return result;
  }

  override async deleteThread(threadId: string): Promise<void> {
    this.deletedThreads.push(threadId);
    await writeFile(
      this.sessionStorePath,
      JSON.stringify({ sessions: {} }),
      "utf8"
    );
    throw new Error("native thread cleanup failed");
  }
}

describe("ChatGPT subscription runtime", () => {
  test("rejects malformed tool output without streaming protocol text or retaining the native thread", async () => {
    class MalformedToolServer extends FakeCodexServer {
      override async startTurn(): ReturnType<CodexAppServer["startTurn"]> {
        return {
          text: '```atlas-tool-call\n{"name":"read_file","arguments":[]}',
          thinking: "",
        };
      }
    }
    const server = new MalformedToolServer();
    const runtime = new ChatgptSubscriptionRuntime(server);
    const chunks: string[] = [];
    await withTemporaryUserConfig("atlas-malformed-tool", async () => {
      await expect(
        runtime.streamChat(
          {
            conversationId: "malformed-tool",
            messages: [{ content: "Read a file", role: "user" }],
            system: "Atlas",
            tools: [
              {
                description: "Read",
                name: "read_file",
                parameters: { type: "object" },
              },
            ],
          },
          { onChunk: (chunk) => chunks.push(chunk) }
        )
      ).rejects.toMatchObject({ code: "runtime_error" });
      expect(
        await readSubscriptionSession("chatgpt", "malformed-tool")
      ).toBeNull();
    });
    expect(chunks).toEqual([]);
    expect(server.deletedThreads).toEqual(["thread-1"]);
    runtime.close();
  });

  const processes: FakeProcess[] = [];

  afterEach(() => {
    setChatgptRuntimeForTests(null);
    for (const child of processes) {
      child.kill();
    }
    processes.length = 0;
  });

  test("exposes model-advertised reasoning efforts to Atlas", async () => {
    const runtime = new ChatgptSubscriptionRuntime(
      new ModelCodexServer(
        ["low", "medium", "high", "xhigh"],
        "gpt-5.6-sol",
        undefined,
        false,
        "high"
      )
    );

    const [model] = await runtime.listModels();

    expect(model).toMatchObject({
      capabilities: {
        "chat.reasoning": {
          source: "runtime-probe",
          status: "supported",
          verified: true,
        },
        "image.generation": {
          source: "runtime-probe",
          status: "unsupported",
          verified: true,
        },
      },
      default: true,
      defaultReasoningEffort: "high",
      id: "gpt-5.6-sol",
      name: "GPT-5.6 Sol",
      provider: "chatgpt",
      reasoningEffortValues: ["low", "medium", "high", "xhigh"],
      supportsThinking: true,
    });
  });

  test("does not invent capabilities when runtime model metadata is absent", async () => {
    const runtime = new ChatgptSubscriptionRuntime(
      new ModelCodexServer(undefined)
    );

    const [model] = await runtime.listModels();

    expect(model?.reasoningEffortValues).toBeUndefined();
    expect(model?.supportsThinking).toBeUndefined();
    expect(model?.supportsVision).toBeUndefined();
    expect(model?.capabilities?.["chat.reasoning"]).toBeUndefined();
    expect(model?.contextWindow).toBeUndefined();
  });

  test.each(["generateChat", "streamChat"] as const)(
    "%s forwards native context separately from token usage",
    async (method) => {
      await withTemporaryUserConfig("atlas-chatgpt-context", async () => {
        const server = new FakeCodexServer();
        server.startTurn = async (options) => {
          options.onDelta?.("Hello");
          return {
            contextUsage: { contextWindow: 258_400, usedTokens: 12_500 },
            text: "Hello",
            thinking: "",
            usage: {
              inputTokens: 12_000,
              outputTokens: 500,
              totalTokens: 12_500,
            },
          };
        };
        setChatgptRuntimeForTests(new ChatgptSubscriptionRuntime(server));
        const provider = createChatgptProvider({ model: "gpt-test" });
        const input = {
          messages: [{ content: "hi", role: "user" as const }],
          system: "Answer briefly.",
        };
        const chunks: string[] = [];

        const result =
          method === "generateChat"
            ? await provider.generateChat(input)
            : await provider.streamChat(input, {
                onChunk: (chunk) => chunks.push(chunk),
              });

        expect(provider.managesContext).toBe(true);
        expect(result.contextUsage).toEqual({
          contextWindow: 258_400,
          usedTokens: 12_500,
        });
        expect(result.usage).toEqual({
          inputTokens: 12_000,
          outputTokens: 500,
          totalTokens: 12_500,
        });
        if (method === "streamChat") {
          expect(chunks).toEqual(["Hello"]);
        }
        expect(server.deletedThreads).toEqual(["thread-1"]);
      });
    }
  );

  test("maps implemented reasoning, vision, and generation from runtime metadata", async () => {
    const runtime = new ChatgptSubscriptionRuntime(
      new ModelCodexServer(
        ["none", "medium", "ultra"],
        "runtime-model",
        ["text", "image", "audio"],
        true
      )
    );

    const [model] = await runtime.listModels();

    expect(model).toMatchObject({
      capabilities: {
        "chat.input.image": { status: "supported" },
        "chat.reasoning": { status: "supported" },
        "image.generation": {
          constraints: { supportedValues: { size: ["auto"] } },
          status: "supported",
        },
        "image.understanding": { status: "supported" },
      },
      id: "runtime-model",
      reasoningEffortValues: ["none", "medium", "ultra"],
      supportsThinking: true,
      supportsVision: true,
    });
    expect(model?.capabilities?.["chat.input.audio"]).toBeUndefined();
  });

  test("normalizes a stale effort to the selected model runtime default", async () => {
    const server = new ModelCodexServer(
      ["low", "medium", "high"],
      "runtime-model",
      ["text"],
      false,
      "low"
    );
    const runtime = new ChatgptSubscriptionRuntime(server);

    await runtime.generateChat(
      {
        messages: [{ content: "Hello", role: "user" }],
        providerOptions: {
          thinking: { effort: "ultra", enabled: true },
        },
        system: "You are Atlas.",
      },
      "runtime-model"
    );

    expect(server.turnOptions[0]).toMatchObject({
      effort: "low",
      model: "runtime-model",
      summary: "auto",
    });
  });

  test("does not invent an effort when runtime reasoning metadata is absent", async () => {
    const server = new ModelCodexServer(undefined, "runtime-model", ["text"]);
    const runtime = new ChatgptSubscriptionRuntime(server);

    await runtime.generateChat(
      {
        messages: [{ content: "Hello", role: "user" }],
        providerOptions: {
          thinking: { effort: "medium", enabled: true },
        },
        system: "You are Atlas.",
      },
      "runtime-model"
    );

    expect(server.turnOptions[0]).toEqual({ model: "runtime-model" });
  });

  test("reuses an existing ChatGPT Codex account without forcing login", async () => {
    const child = new FakeProcess();
    processes.push(child);
    const inbound: string[] = [];
    child.stdin.on("data", (chunk) => {
      inbound.push(String(chunk));
      for (const line of String(chunk).split("\n")) {
        if (!line.trim()) {
          continue;
        }
        const message = JSON.parse(line) as {
          id?: number;
          method?: string;
        };
        if (
          message.method === "account/read" &&
          typeof message.id === "number"
        ) {
          writeResponse(child, {
            id: message.id,
            result: {
              account: {
                email: "user@example.com",
                planType: "pro",
                type: "chatgpt",
              },
            },
          });
        }
      }
    });

    const server = new CodexAppServer({
      client: new (await import("../jsonrpc-stdio")).JsonRpcStdioClient(child),
    });
    const runtime = new ChatgptSubscriptionRuntime(server);

    const state = await runtime.getAuthState();
    expect(state).toMatchObject({
      authenticated: true,
      email: "user@example.com",
      plan: "pro",
      provider: "chatgpt",
      status: "authenticated",
    });
    expect(inbound.join("")).toContain("account/read");
  });

  test("rejects Codex API-key auth on the ChatGPT subscription path", async () => {
    const child = new FakeProcess();
    processes.push(child);
    child.stdin.on("data", (chunk) => {
      for (const line of String(chunk).split("\n")) {
        if (!line.trim()) {
          continue;
        }
        const message = JSON.parse(line) as {
          id?: number;
          method?: string;
        };
        if (
          message.method === "account/read" &&
          typeof message.id === "number"
        ) {
          writeResponse(child, {
            id: message.id,
            result: { account: { type: "apiKey" } },
          });
        }
      }
    });
    const server = new CodexAppServer({
      client: new (await import("../jsonrpc-stdio")).JsonRpcStdioClient(child),
    });
    const runtime = new ChatgptSubscriptionRuntime(server);

    const state = await runtime.getAuthState();
    expect(state.authenticated).toBe(false);
    expect(state.status).toBe("not_authenticated");
    expect(state.plan).toBeUndefined();
  });

  test("buffers tool syntax and resumes with only new Atlas context", async () => {
    const configDirectory = await mkdtemp("/tmp/atlas-chatgpt-runtime-");
    const server = new FakeCodexServer();
    const runtime = new ChatgptSubscriptionRuntime(server);
    const chunks: string[] = [];
    try {
      await runWithUserConfigDir(configDirectory, async () => {
        const first = await runtime.streamChat(
          {
            conversationId: "conversation-1",
            messages: [{ content: "Find the answer", role: "user" }],
            system: "You are Atlas.",
            tools: [
              {
                description: "Search records",
                name: "knowledge_base_search",
                parameters: { type: "object" },
              },
            ],
          },
          { onChunk: (chunk) => chunks.push(chunk) }
        );
        expect(chunks).toEqual(["I will search."]);
        expect(chunks.join("")).not.toContain("atlas-tool-call");

        await runtime.generateChat({
          conversationId: "conversation-1",
          messages: [
            { content: "Find the answer", role: "user" },
            first.assistantMessage,
            {
              content: "The answer is 42.",
              name: "knowledge_base_search",
              role: "tool",
              toolCallId: first.toolCalls[0]?.id ?? "call-1",
            },
          ],
          system: "Updated Atlas instructions.",
          tools: [
            {
              description: "Search records",
              name: "knowledge_base_search",
              parameters: { type: "object" },
            },
          ],
        });
      });

      expect(server.resumeInputs).toEqual([
        {
          developerInstructions: expect.stringContaining(
            "Updated Atlas instructions."
          ),
          id: "thread-1",
        },
      ]);
      expect(server.threadOptions[0]?.developerInstructions).toMatch(
        /native sandbox, filesystem, approval, and permission settings do not restrict Atlas tools/
      );
      expect(server.resumeInputs[0]?.developerInstructions).toMatch(
        /read-only sandbox applies only to Codex-native/
      );
      expect(server.turnInputs[1]).toEqual([
        {
          text: expect.stringContaining("The answer is 42."),
          text_elements: [],
          type: "text",
        },
      ]);
      expect(JSON.stringify(server.turnInputs[1])).toContain(
        '\\"query\\":\\"atlas\\"'
      );
      expect(JSON.stringify(server.turnInputs[1])).not.toContain(
        "Find the answer"
      );
    } finally {
      runtime.close();
      await rm(configDirectory, { force: true, recursive: true });
    }
  });

  test("sends first-turn and resumed images as native Codex inputs", async () => {
    const configDirectory = await mkdtemp("/tmp/atlas-chatgpt-image-");
    const server = new FakeCodexServer();
    const runtime = new ChatgptSubscriptionRuntime(server);
    try {
      await runWithUserConfigDir(configDirectory, async () => {
        const first = await runtime.generateChat({
          conversationId: "conversation-image",
          messages: [
            {
              content: [
                { text: "What is in this image?", type: "text" },
                {
                  data: TINY_PNG_BASE64,
                  mediaType: "image/png",
                  type: "image",
                },
              ],
              role: "user",
            },
          ],
          providerOptions: {
            thinking: { effort: "high", enabled: true },
          },
          system: "You are Atlas.",
        });

        await runtime.generateChat({
          conversationId: "conversation-image",
          messages: [
            {
              content: [
                { text: "What is in this image?", type: "text" },
                {
                  data: TINY_PNG_BASE64,
                  mediaType: "image/png",
                  type: "image",
                },
              ],
              role: "user",
            },
            first.assistantMessage,
            {
              content: [
                { text: "Compare it with this one.", type: "text" },
                {
                  data: TINY_PNG_BASE64,
                  mediaType: "image/png",
                  type: "image",
                },
              ],
              role: "user",
            },
          ],
          system: "You are Atlas.",
        });
      });

      expect(server.turnInputs[0]).toEqual([
        {
          text: "User:\nWhat is in this image?",
          text_elements: [],
          type: "text",
        },
        {
          detail: "high",
          type: "image",
          url: `data:image/png;base64,${TINY_PNG_BASE64}`,
        },
      ]);
      expect(server.turnInputs[1]).toEqual([
        {
          text: "User:\nCompare it with this one.",
          text_elements: [],
          type: "text",
        },
        {
          detail: "high",
          type: "image",
          url: `data:image/png;base64,${TINY_PNG_BASE64}`,
        },
      ]);
      expect(server.turnOptions[0]).toMatchObject({
        effort: "high",
        summary: "auto",
      });
    } finally {
      runtime.close();
      await rm(configDirectory, { force: true, recursive: true });
    }
  });

  test("fails closed when the selected model omits image input", async () => {
    const server = new FakeCodexServer();
    server.listModels = async () => [
      {
        id: "text-only",
        inputModalities: ["text"],
        isDefault: true,
      },
    ];
    const runtime = new ChatgptSubscriptionRuntime(server);

    await expect(
      runtime.generateChat(
        {
          messages: [
            {
              content: [
                {
                  data: TINY_PNG_BASE64,
                  mediaType: "image/png",
                  type: "image",
                },
              ],
              role: "user",
            },
          ],
          system: "You are Atlas.",
        },
        "text-only"
      )
    ).rejects.toThrow("does not advertise image input");
    expect(server.turnInputs).toEqual([]);
  });

  test("uses and deletes a persisted dedicated thread for one-shot chats", async () => {
    const server = new FakeCodexServer();
    const runtime = new ChatgptSubscriptionRuntime(server);
    try {
      const result = await withTemporaryUserConfig(
        "atlas-chatgpt-one-shot-success",
        () =>
          runtime.generateChat({
            messages: [{ content: "Hello", role: "user" }],
            system: "You are Atlas.",
          })
      );

      expect(result.content).toBe("I will search.");
      expect(server.threadOptions[0]).toMatchObject({ ephemeral: false });
      expect(server.deletedThreads).toEqual(["thread-1"]);
    } finally {
      runtime.close();
    }
  });

  test("deletes a persisted one-shot chat thread after turn failure", async () => {
    const server = new FakeCodexServer();
    server.failTurn = true;
    const runtime = new ChatgptSubscriptionRuntime(server);
    try {
      await withTemporaryUserConfig(
        "atlas-chatgpt-one-shot-failure",
        async () => {
          await expect(
            runtime.generateChat({
              messages: [{ content: "Hello", role: "user" }],
              system: "You are Atlas.",
            })
          ).rejects.toThrow("turn failed");
        }
      );

      expect(server.threadOptions[0]).toMatchObject({ ephemeral: false });
      expect(server.deletedThreads).toEqual(["thread-1"]);
    } finally {
      runtime.close();
    }
  });

  test("drains active one-shot generateText before logout and blocks new work", async () => {
    const server = new ControlledOneShotCodexServer();
    const runtime = new ChatgptSubscriptionRuntime(server);
    setChatgptRuntimeForTests(runtime);
    const provider = createChatgptProvider({ model: "gpt-test" });
    try {
      await withTemporaryUserConfig(
        "atlas-chatgpt-one-shot-logout",
        async () => {
          const activeTurn = provider.generateText({
            prompt: "First",
            system: "You are Atlas.",
          });
          await server.turnStarted;
          let logoutSettled = false;
          const logout = runtime.logout().then((result) => {
            logoutSettled = true;
            return result;
          });

          try {
            await Bun.sleep(0);
            expect(logoutSettled).toBe(false);
            await expect(
              provider.generateText({
                prompt: "Blocked",
                system: "You are Atlas.",
              })
            ).rejects.toThrow("provider is currently being cleared");

            server.completeTurn();
            await activeTurn;
            await logout;

            expect(logoutSettled).toBe(true);
            expect(server.threadOptions).toHaveLength(1);
            expect(server.events).toEqual([
              "turn:start",
              "turn:end",
              "delete:thread-1",
              "logout",
            ]);
          } finally {
            server.completeTurn();
            await Promise.allSettled([activeTurn, logout]);
          }
        }
      );
    } finally {
      runtime.close();
    }
  });

  test("generates one image through an isolated subscription thread and cleans it up", async () => {
    const server = new ImageGenerationCodexServer();
    const runtime = new ChatgptSubscriptionRuntime(server);

    const image = await withTemporaryUserConfig(
      "atlas-chatgpt-image-success",
      () =>
        runtime.generateImage(
          { prompt: "A blue atlas", size: "1024x1024" },
          "gpt-test"
        )
    );

    expect(image).toMatchObject({
      height: 1,
      id: "generated-1",
      mediaType: "image/png",
      revisedPrompt: "A refined prompt",
      status: "completed",
      width: 1,
    });
    expect(server.turnInputs[0]).toEqual([
      expect.objectContaining({
        text: expect.stringContaining("A blue atlas"),
        type: "text",
      }),
    ]);
    expect(server.threadOptions[0]).toMatchObject({
      ephemeral: false,
      imageGeneration: true,
      model: "gpt-test",
    });
    expect(server.deletedThreads).toEqual(["thread-1"]);
  });

  test("fully decodes native image output before returning it", async () => {
    const server = new ImageGenerationCodexServer();
    const corrupted = Buffer.from(TINY_PNG_BASE64, "base64");
    const imageDataOffset = corrupted.indexOf(Buffer.from("IDAT")) + 4;
    corrupted[imageDataOffset] = ((corrupted[imageDataOffset] ?? 0) + 1) % 256;
    server.generatedImages = [
      {
        data: Uint8Array.from(corrupted),
        height: 1,
        id: "corrupt-generated-image",
        mediaType: "image/png",
        model: "gpt-image-2",
        status: "completed",
        width: 1,
      },
    ];
    const runtime = new ChatgptSubscriptionRuntime(server);

    await expect(
      runtime.generateImage(
        { prompt: "A blue atlas", size: "auto" },
        "gpt-test"
      )
    ).rejects.toMatchObject({ status: 502 });
    expect(server.deletedThreads).toEqual(["thread-1"]);
  });

  test("fails image generation without provider fallback and still cleans its thread", async () => {
    const server = new ImageGenerationCodexServer();
    server.generatedImages = [
      {
        failure: {
          limitId: "image_gen",
          resetsAt: 1_800_000_000,
          type: "usageLimitExceeded",
        },
        id: "limited-image",
        status: "failed",
      },
    ];
    const runtime = new ChatgptSubscriptionRuntime(server);

    await withTemporaryUserConfig("atlas-chatgpt-image-limit", async () => {
      await expect(
        runtime.generateImage(
          { prompt: "A blue atlas", size: "auto" },
          "gpt-test"
        )
      ).rejects.toMatchObject({
        code: "subscription_limit_reached",
        message: expect.stringContaining("will not fall back to an API key"),
      });
    });
    expect(server.turnInputs).toHaveLength(1);
    expect(server.deletedThreads).toEqual(["thread-1"]);
  });

  test("returns a generated image when deletion fails and retries cleanup later", async () => {
    const server = new ImageGenerationCodexServer();
    server.deleteFailure = new Error("temporary deletion failure");
    const runtime = new ChatgptSubscriptionRuntime(server);

    await withTemporaryUserConfig(
      "atlas-chatgpt-image-delete-retry",
      async () => {
        await expect(
          runtime.generateImage(
            { prompt: "A blue atlas", size: "auto" },
            "gpt-test"
          )
        ).resolves.toMatchObject({ id: "generated-1", status: "completed" });
        expect(server.deletedThreads).toEqual(["thread-1"]);

        server.deleteFailure = null;
        await runtime.logout();
        expect(server.deletedThreads).toEqual(["thread-1", "thread-1"]);
        expect(server.logoutCalls).toBe(1);
      }
    );
  });

  test("keeps the generation error when deletion also fails and retries cleanup later", async () => {
    const server = new ImageGenerationCodexServer();
    server.turnFailure = new Error("primary image generation failure");
    server.deleteFailure = new Error("temporary deletion failure");
    const runtime = new ChatgptSubscriptionRuntime(server);

    await withTemporaryUserConfig(
      "atlas-chatgpt-image-failure-delete-retry",
      async () => {
        await expect(
          runtime.generateImage(
            { prompt: "A blue atlas", size: "auto" },
            "gpt-test"
          )
        ).rejects.toThrow("primary image generation failure");
        expect(server.deletedThreads).toEqual(["thread-1"]);

        server.deleteFailure = null;
        await runtime.logout();
        expect(server.deletedThreads).toEqual(["thread-1", "thread-1"]);
        expect(server.logoutCalls).toBe(1);
      }
    );
  });

  test("drains active image generation before logout and blocks new work", async () => {
    const server = new ControlledImageGenerationCodexServer();
    const runtime = new ChatgptSubscriptionRuntime(server);
    try {
      await withTemporaryUserConfig("atlas-chatgpt-image-logout", async () => {
        const activeGeneration = runtime.generateImage(
          { prompt: "A blue atlas", size: "auto" },
          "gpt-test"
        );
        await server.turnStarted;
        let logoutSettled = false;
        const logout = runtime.logout().then((result) => {
          logoutSettled = true;
          return result;
        });

        try {
          await Bun.sleep(0);
          expect(logoutSettled).toBe(false);
          await expect(
            runtime.generateImage(
              { prompt: "Blocked", size: "auto" },
              "gpt-test"
            )
          ).rejects.toThrow("provider is currently being cleared");

          server.completeTurn();
          await activeGeneration;
          await logout;

          expect(logoutSettled).toBe(true);
          expect(server.threadOptions).toHaveLength(1);
          expect(server.events).toEqual([
            "turn:start",
            "turn:end",
            "delete:thread-1",
            "logout",
          ]);
        } finally {
          server.completeTurn();
          await Promise.allSettled([activeGeneration, logout]);
        }
      });
    } finally {
      runtime.close();
    }
  });

  test("does not start image generation when the runtime probe says unsupported", async () => {
    const server = new FakeCodexServer();
    const runtime = new ChatgptSubscriptionRuntime(server);

    await expect(
      runtime.generateImage(
        { prompt: "A blue atlas", size: "auto" },
        "gpt-test"
      )
    ).rejects.toMatchObject({ code: "provider_unavailable" });
    expect(server.turnInputs).toEqual([]);
    expect(server.deletedThreads).toEqual([]);
  });

  test("rejects missing or multiple native image results", async () => {
    await withTemporaryUserConfig("atlas-chatgpt-image-count", async () => {
      for (const count of [0, 2]) {
        const server = new ImageGenerationCodexServer();
        server.generatedImages = Array.from({ length: count }, (_, index) => ({
          data: Uint8Array.from([137, 80, 78, 71]),
          height: 1,
          id: `image-${index}`,
          mediaType: "image/png" as const,
          status: "completed",
          width: 1,
        }));
        const runtime = new ChatgptSubscriptionRuntime(server);

        await expect(
          runtime.generateImage(
            { prompt: "A blue atlas", size: "auto" },
            "gpt-test"
          )
        ).rejects.toMatchObject({ code: "runtime_error" });
        expect(server.deletedThreads).toEqual(["thread-1"]);
      }
    });
  });

  test("keeps an explicit cancellation when the login watcher finishes later", async () => {
    const server = new LoginCodexServer();
    const runtime = new ChatgptSubscriptionRuntime(server);
    const started = await runtime.startLogin({ method: "browser" });

    await runtime.cancelLogin(started.loginId);
    server.accountValue = { email: "user@example.com", type: "chatgpt" };
    server.completeLogin();
    await Bun.sleep(0);

    await expect(runtime.getLoginStatus(started.loginId)).resolves.toEqual({
      loginId: started.loginId,
      status: "cancelled",
    });
  });

  test("does not cancel login when only a wait request is aborted", async () => {
    const server = new LoginCodexServer();
    const runtime = new ChatgptSubscriptionRuntime(server);
    const started = await runtime.startLogin({ method: "browser" });
    const controller = new AbortController();
    const wait = runtime.waitForLogin(started.loginId, controller.signal);

    controller.abort();
    await expect(wait).resolves.toEqual({
      loginId: started.loginId,
      status: "cancelled",
    });

    server.accountValue = { email: "user@example.com", type: "chatgpt" };
    server.completeLogin();
    await Bun.sleep(0);
    await expect(
      runtime.getLoginStatus(started.loginId)
    ).resolves.toMatchObject({
      loginId: started.loginId,
      status: "completed",
    });
  });

  test("rejects duplicate pending login attempts", async () => {
    const server = new LoginCodexServer();
    const runtime = new ChatgptSubscriptionRuntime(server);
    const started = await runtime.startLogin({ method: "browser" });

    await expect(runtime.startLogin({ method: "device" })).rejects.toThrow(
      "A ChatGPT login is already in progress."
    );
    await runtime.cancelLogin(started.loginId);
  });

  test("does not evict an active login when the status cache is full", async () => {
    const server = new LoginCodexServer();
    const runtime = new ChatgptSubscriptionRuntime(server);
    const started = await runtime.startLogin({ method: "browser" });
    const pendingLogins = (
      runtime as unknown as { pendingLogins: Map<string, unknown> }
    ).pendingLogins;
    for (let index = 0; index < 127; index += 1) {
      const loginId = `completed-${index}`;
      pendingLogins.set(loginId, {
        loginId,
        method: "browser",
        startedAt: Date.now(),
        status: { loginId, status: "completed" },
      });
    }

    await expect(runtime.startLogin({ method: "device" })).rejects.toThrow(
      "A ChatGPT login is already in progress."
    );
    expect(pendingLogins.has(started.loginId)).toBe(true);
    await runtime.cancelLogin(started.loginId);
  });

  test("fails an unknown unauthenticated login instead of polling forever", async () => {
    const runtime = new ChatgptSubscriptionRuntime(new LoginCodexServer());

    await expect(runtime.getLoginStatus("missing-login")).resolves.toEqual({
      error: "Login session not found or expired.",
      loginId: "missing-login",
      status: "failed",
    });
  });

  test("deletes a stale native thread before replacing its binding", async () => {
    const configDirectory = await mkdtemp("/tmp/atlas-chatgpt-stale-");
    const server = new FakeCodexServer();
    const runtime = new ChatgptSubscriptionRuntime(server);
    try {
      await runWithUserConfigDir(configDirectory, async () => {
        await writeSubscriptionSession("chatgpt", "conversation-stale", {
          historyFingerprint: "stale-history",
          lastMessageCount: 2,
          runtimeSessionId: "thread-stale",
        });
        await withSubscriptionSessionLease(
          "chatgpt",
          "conversation-stale",
          () =>
            runtime.generateChat({
              conversationId: "conversation-stale",
              messages: [{ content: "Fresh prompt", role: "user" }],
              system: "You are Atlas.",
            }),
          (candidate) => server.deleteThread(candidate.runtimeSessionId)
        );
      });

      expect(server.deletedThreads).toContain("thread-stale");
      expect(server.resumeInputs).toEqual([]);
    } finally {
      runtime.close();
      await rm(configDirectory, { force: true, recursive: true });
    }
  });

  test("deletes a newly created native thread when its first turn fails", async () => {
    const configDirectory = await mkdtemp("/tmp/atlas-chatgpt-failure-");
    const server = new FakeCodexServer();
    server.failTurn = true;
    const runtime = new ChatgptSubscriptionRuntime(server);
    try {
      await runWithUserConfigDir(configDirectory, async () => {
        await expect(
          runtime.generateChat({
            conversationId: "conversation-failure",
            messages: [{ content: "Hello", role: "user" }],
            system: "You are Atlas.",
          })
        ).rejects.toThrow("turn failed");
      });

      expect(server.deletedThreads).toEqual(["thread-1"]);
    } finally {
      runtime.close();
      await rm(configDirectory, { force: true, recursive: true });
    }
  });

  test("does not double-delete a thread persisted before a consumer error", async () => {
    const configDirectory = await mkdtemp("/tmp/atlas-chatgpt-consumer-");
    const server = new FakeCodexServer();
    const runtime = new ChatgptSubscriptionRuntime(server);
    try {
      await runWithUserConfigDir(configDirectory, async () => {
        await expect(
          withSubscriptionSessionLease(
            "chatgpt",
            "conversation-consumer-error",
            () =>
              runtime.streamChat(
                {
                  conversationId: "conversation-consumer-error",
                  messages: [{ content: "Search", role: "user" }],
                  system: "You are Atlas.",
                  tools: [
                    {
                      description: "Search records",
                      name: "knowledge_base_search",
                      parameters: { type: "object" },
                    },
                  ],
                },
                {
                  onChunk: () => {
                    throw new Error("consumer failed");
                  },
                }
              ),
            (candidate) => server.deleteThread(candidate.runtimeSessionId)
          )
        ).rejects.toThrow("consumer failed");

        expect(server.deletedThreads).toEqual(["thread-1"]);
        expect(
          await readSubscriptionSession(
            "chatgpt",
            "conversation-consumer-error"
          )
        ).toBeNull();
      });
    } finally {
      runtime.close();
      await rm(configDirectory, { force: true, recursive: true });
    }
  });

  test("coalesces logout and blocks turns until cleanup and logout finish", async () => {
    const configDirectory = await mkdtemp("/tmp/atlas-chatgpt-logout-");
    const server = new ControlledLogoutCodexServer();
    const runtime = new ChatgptSubscriptionRuntime(server);
    try {
      await runWithUserConfigDir(configDirectory, async () => {
        await writeSubscriptionSession("chatgpt", "conversation-logout", {
          lastMessageCount: 1,
          runtimeSessionId: "thread-logout",
        });

        const logout = runtime.logout();
        await server.logoutStarted;
        const concurrentLogout = runtime.logout();

        expect(server.events).toEqual(["delete:thread-logout", "logout:start"]);
        await expect(
          withSubscriptionSessionLease(
            "chatgpt",
            "conversation-during-logout",
            async () => undefined
          )
        ).rejects.toThrow("currently being cleared");

        server.completeLogout();
        await Promise.all([logout, concurrentLogout]);
        expect(server.events).toEqual([
          "delete:thread-logout",
          "logout:start",
          "logout:end",
        ]);
        await expect(
          withSubscriptionSessionLease(
            "chatgpt",
            "conversation-after-logout",
            async () => undefined
          )
        ).resolves.toBeUndefined();
      });
    } finally {
      server.completeLogout();
      runtime.close();
      await rm(configDirectory, { force: true, recursive: true });
    }
  });

  test("fails and retains cleanup when persistence and native deletion fail", async () => {
    const configDirectory = await mkdtemp("/tmp/atlas-chatgpt-persist-");
    const server = new PersistenceFailureCodexServer(
      join(configDirectory, "subscription-sessions.json")
    );
    const runtime = new ChatgptSubscriptionRuntime(server);
    try {
      await runWithUserConfigDir(configDirectory, async () => {
        await expect(
          runtime.generateChat({
            conversationId: "conversation-persist-failure",
            messages: [{ content: "Hello", role: "user" }],
            system: "You are Atlas.",
          })
        ).rejects.toMatchObject({
          code: "runtime_error",
          message: expect.stringContaining("could not persist or delete"),
        });

        expect(server.deletedThreads).toEqual(["thread-1"]);
        expect(
          await listSubscriptionSessionDeletionCandidates(
            "conversation-persist-failure"
          )
        ).toEqual([
          expect.objectContaining({
            kind: "chatgpt",
            runtimeSessionId: "thread-1",
          }),
        ]);
      });
    } finally {
      runtime.close();
      await rm(configDirectory, { force: true, recursive: true });
    }
  });

  test("continues logout when a native thread is already missing", async () => {
    const configDirectory = await mkdtemp("/tmp/atlas-chatgpt-logout-");
    const server = new MissingThreadLogoutCodexServer();
    const runtime = new ChatgptSubscriptionRuntime(server);
    try {
      await runWithUserConfigDir(configDirectory, async () => {
        await writeSubscriptionSession("chatgpt", "conversation-missing", {
          lastMessageCount: 1,
          runtimeSessionId: "thread-missing",
        });

        await runtime.logout();

        expect(server.deletedThreads).toEqual(["thread-missing"]);
        expect(server.logoutCalls).toBe(1);
        expect(
          await readSubscriptionSession("chatgpt", "conversation-missing")
        ).toBeNull();
      });
    } finally {
      runtime.close();
      await rm(configDirectory, { force: true, recursive: true });
    }
  });
});
