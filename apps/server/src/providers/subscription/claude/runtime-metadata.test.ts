import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { runWithUserConfigDir, type SubscriptionAuthState } from "@atlas/core";
import {
  type ClaudeAgentSdk,
  type ClaudeQueryHandle,
  ClaudeSubscriptionRuntime,
} from "./runtime";

class AuthenticatedRuntime extends ClaudeSubscriptionRuntime {
  override async getAuthState(): Promise<SubscriptionAuthState> {
    return { authenticated: true, provider: "claude", status: "authenticated" };
  }
}

async function withTemporaryConfig<T>(run: () => Promise<T>): Promise<T> {
  const directory = await mkdtemp("/tmp/atlas-claude-metadata-");
  try {
    return await runWithUserConfigDir(directory, run);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

function resultHandle(
  options: Partial<ClaudeQueryHandle> = {}
): ClaudeQueryHandle {
  return {
    async *[Symbol.asyncIterator]() {
      yield {
        modelUsage: {
          main: {
            cacheCreationInputTokens: 50,
            cacheReadInputTokens: 1000,
            contextWindow: 1_000_000,
            inputTokens: 10,
            outputTokens: 20,
          },
        },
        result: "Hello",
        subtype: "success",
        type: "result",
        usage: { input_tokens: 10, output_tokens: 20 },
      };
    },
    ...options,
  };
}

describe("Claude metadata discovery and native context", () => {
  test("discovers models during initialization without yielding any user prompt", async () => {
    let calls = 0;
    let closed = false;
    let pendingInput: Promise<IteratorResult<unknown>> | undefined;
    let capturedOptions: Record<string, unknown> | undefined;
    const sdk: ClaudeAgentSdk = {
      query({ prompt, options }) {
        calls += 1;
        capturedOptions = options;
        if (typeof prompt === "string") {
          throw new Error("Model discovery must not send a user prompt");
        }
        pendingInput = prompt[Symbol.asyncIterator]().next();
        return resultHandle({
          close: () => {
            closed = true;
          },
          supportedModels: async () => [
            {
              supportedEffortLevels: ["medium", "max"],
              supportsAdaptiveThinking: true,
              value: "runtime-model",
            },
          ],
        });
      },
    };
    const runtime = new AuthenticatedRuntime({ sdk });

    const models = await withTemporaryConfig(async () => {
      const first = await runtime.listModels();
      expect(await runtime.listModels()).toEqual(first);
      return first;
    });

    expect(calls).toBe(1);
    expect(closed).toBe(true);
    expect(await pendingInput).toEqual({ done: true, value: undefined });
    expect(capturedOptions).toMatchObject({
      allowedTools: [],
      mcpServers: {},
      persistSession: false,
      settingSources: [],
      tools: [],
    });
    expect(models[0]).toMatchObject({
      id: "runtime-model",
      reasoningEffortValues: ["medium", "max"],
    });
    expect(models[0]).not.toHaveProperty("contextWindow");
    expect(models[0]).not.toHaveProperty("defaultReasoningEffort");
  });

  test("propagates model discovery failures without replacing them with a fabricated catalog", async () => {
    let closed = false;
    const runtime = new AuthenticatedRuntime({
      sdk: {
        query: () =>
          resultHandle({
            close: () => {
              closed = true;
            },
            supportedModels: async () => {
              throw new Error("discovery failed");
            },
          }),
      },
    });

    await withTemporaryConfig(async () => {
      await expect(runtime.listModels()).rejects.toThrow();
    });
    expect(closed).toBe(true);
  });

  test("reads native context before closing the successful query", async () => {
    const events: string[] = [];
    let capturedModel: unknown;
    let firstInput: Promise<IteratorResult<unknown>> | undefined;
    const runtime = new AuthenticatedRuntime({
      sdk: {
        query({ prompt, options }) {
          capturedModel = options?.model;
          if (typeof prompt !== "string") {
            firstInput = prompt[Symbol.asyncIterator]().next();
          }
          return resultHandle({
            close: () => {
              events.push("close");
            },
            getContextUsage: async () => {
              events.push("context");
              return {
                maxTokens: 180_000,
                rawMaxTokens: 200_000,
                totalTokens: 5000,
              };
            },
          });
        },
      },
    });

    const result = await withTemporaryConfig(() =>
      runtime.generateChat(
        {
          messages: [{ content: "hello", role: "user" }],
          system: "Atlas",
        },
        "exact-requested-model"
      )
    );

    expect(capturedModel).toBe("exact-requested-model");
    expect((await firstInput)?.done).toBe(false);
    expect(events).toEqual(["context", "close"]);
    expect(result.content).toBe("Hello");
    expect(result.contextUsage).toEqual({
      contextWindow: 180_000,
      usedTokens: 5000,
    });
    expect(result.usage).toEqual({
      inputTokens: 1060,
      outputTokens: 20,
      totalTokens: 1080,
    });
  });

  test("unavailable native context remains unknown despite cumulative model usage", async () => {
    const runtime = new AuthenticatedRuntime({
      sdk: {
        query: () =>
          resultHandle({
            getContextUsage: async () => {
              throw new Error("unsupported control request");
            },
          }),
      },
    });

    const result = await withTemporaryConfig(() =>
      runtime.streamChat(
        {
          messages: [{ content: "hello", role: "user" }],
          system: "Atlas",
        },
        { onChunk: () => {} },
        "claude-model"
      )
    );

    expect(result.content).toBe("Hello");
    expect(result.contextUsage).toBeUndefined();
    expect(result.usage?.inputTokens).toBe(1060);
  });

  test("validates exact runtime effort metadata before issuing the requested model turn", async () => {
    const optionsSeen: Array<Record<string, unknown> | undefined> = [];
    const sdk: ClaudeAgentSdk = {
      query({ options }) {
        optionsSeen.push(options);
        return resultHandle({
          supportedModels: async () => [
            {
              resolvedModel: "claude-exact-model",
              supportedEffortLevels: ["low", "max"],
              supportsAdaptiveThinking: true,
              value: "sonnet",
            },
          ],
        });
      },
    };
    const runtime = new AuthenticatedRuntime({ sdk });

    await withTemporaryConfig(async () => {
      await expect(
        runtime.generateChat(
          {
            messages: [{ content: "hello", role: "user" }],
            providerOptions: { thinking: { effort: "high", enabled: true } },
            system: "Atlas",
          },
          "claude-exact-model"
        )
      ).rejects.toThrow();
      expect(optionsSeen).toHaveLength(1);
      await runtime.generateChat(
        {
          messages: [{ content: "hello", role: "user" }],
          providerOptions: { thinking: { effort: "max", enabled: true } },
          system: "Atlas",
        },
        "claude-exact-model"
      );
    });

    expect(optionsSeen).toHaveLength(2);
    expect(optionsSeen[1]).toMatchObject({
      effort: "max",
      model: "claude-exact-model",
      thinking: { type: "adaptive" },
    });
  });
});
