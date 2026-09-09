import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { generateSessionTitleFromMessages } from "@atlas/agent";
import {
  type ProviderClient,
  runWithUserConfigDir,
  type SubscriptionAuthState,
} from "@atlas/core";
import { LlmUsageTracker } from "../services/llm-usage-tracker";
import { createOpenAIProvider } from "./openai";
import { CodexAppServer } from "./subscription/chatgpt/app-server";
import { createChatgptProvider } from "./subscription/chatgpt/provider";
import { ChatgptSubscriptionRuntime } from "./subscription/chatgpt/runtime";
import { createClaudeProvider } from "./subscription/claude/provider";
import {
  type ClaudeAgentSdk,
  type ClaudeQueryHandle,
  ClaudeSubscriptionRuntime,
} from "./subscription/claude/runtime";
import {
  type JsonRpcRequest,
  JsonRpcStdioClient,
  type JsonRpcStdioProcess,
} from "./subscription/jsonrpc-stdio";
import {
  setChatgptRuntimeForTests,
  setClaudeRuntimeForTests,
} from "./subscription/runtimes";
import { wrapProviderWithUsageTracking } from "./usage-tracking";

const MODEL = "title-cancellation-fixture";
const MESSAGES = [
  { content: "Plan a database migration", role: "user" as const },
];
const originalFetch = globalThis.fetch;

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function title(provider: ProviderClient, signal: AbortSignal) {
  // A variable also permits replaying this regression against the old helper.
  const options = { provider, signal };
  return generateSessionTitleFromMessages(MESSAGES, options);
}

async function withConfig(run: () => Promise<void>) {
  const directory = await mkdtemp("/tmp/atlas-title-adapter-cancellation-");
  try {
    await runWithUserConfigDir(directory, run);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

function expectedUnknownUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    provenance: {
      estimatedInvocations: 0,
      reportedInvocations: 0,
      unknownInvocations: 1,
    },
    requestCount: 1,
    totalTokens: 0,
  };
}

class FakeProcess extends EventEmitter implements JsonRpcStdioProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 1;

  kill(): void {
    this.emit("exit", 0);
  }
}

class LocalCodexServer extends CodexAppServer {
  readonly authStarted = deferred<void>();
  readonly deletedThreads: string[] = [];
  authGate: Promise<void> = Promise.resolve();
  threadStarts = 0;

  override async account() {
    this.authStarted.resolve();
    await this.authGate;
    return { type: "chatgpt" };
  }

  override async listModels() {
    return [{ id: MODEL, isDefault: true }];
  }

  override async readModelProviderCapabilities() {
    return { imageGeneration: false, namespaceTools: false, webSearch: false };
  }

  override async startThread() {
    this.threadStarts += 1;
    return "title-thread";
  }

  override async deleteThread(threadId: string) {
    this.deletedThreads.push(threadId);
  }
}

function codexFixture(
  options: { completeImmediately?: boolean; lateId?: boolean } = {}
) {
  const process = new FakeProcess();
  const started = deferred<JsonRpcRequest>();
  const requests: JsonRpcRequest[] = [];
  const send = (payload: unknown) => {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  };
  const complete = () => {
    send({
      method: "turn/completed",
      params: {
        threadId: "title-thread",
        turn: {
          id: "title-turn",
          status: "completed",
          usage: { inputTokens: 13, outputTokens: 19, totalTokens: 32 },
        },
      },
    });
  };
  const respondToStart = (request: JsonRpcRequest) => {
    send({ id: request.id, result: { turn: { id: "title-turn" } } });
    send({
      method: "item/agentMessage/delta",
      params: {
        delta: "Late Native Title",
        threadId: "title-thread",
        turnId: "title-turn",
      },
    });
    send({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "title-thread",
        tokenUsage: {
          last: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200 },
          modelContextWindow: 4096,
          total: { inputTokens: 8000, outputTokens: 1999, totalTokens: 9999 },
        },
        turnId: "title-turn",
      },
    });
  };
  process.stdin.on("data", (chunk) => {
    for (const line of String(chunk).split("\n").filter(Boolean)) {
      const request: JsonRpcRequest = JSON.parse(line);
      requests.push(request);
      if (request.method === "turn/start") {
        if (!options.lateId) {
          respondToStart(request);
        }
        started.resolve(request);
        if (options.completeImmediately) {
          complete();
        }
      } else if (request.method === "turn/interrupt") {
        send({ id: request.id, result: {} });
      }
    }
  });
  const server = new LocalCodexServer({
    client: new JsonRpcStdioClient(process),
    turnTimeoutMs: 1000,
  });
  setChatgptRuntimeForTests(new ChatgptSubscriptionRuntime(server));
  return { complete, requests, respondToStart, server, started };
}

class LocalClaudeRuntime extends ClaudeSubscriptionRuntime {
  readonly authStarted = deferred<void>();
  authGate: Promise<void> = Promise.resolve();

  override async getAuthState(): Promise<SubscriptionAuthState> {
    this.authStarted.resolve();
    await this.authGate;
    return { authenticated: true, provider: "claude", status: "authenticated" };
  }
}

function claudeFixture() {
  const started = deferred<AbortSignal>();
  const release = deferred<void>();
  const counts = { closes: 0, inferenceStarts: 0, interrupts: 0, queries: 0 };
  const sdk: ClaudeAgentSdk = {
    query: ({ options, prompt }): ClaudeQueryHandle => {
      counts.queries += 1;
      if (!options?.model) {
        return {
          async *[Symbol.asyncIterator]() {},
          supportedModels: async () => [{ value: MODEL }],
        };
      }
      if (typeof prompt === "string") {
        throw new Error("Expected native streaming input.");
      }
      const controller = options.abortController;
      if (!(controller instanceof AbortController)) {
        throw new Error("Expected the native query cancellation controller.");
      }
      return {
        async *[Symbol.asyncIterator]() {
          const next = await prompt[Symbol.asyncIterator]().next();
          if (!next.done) {
            counts.inferenceStarts += 1;
          }
          started.resolve(controller.signal);
          await release.promise;
          yield {
            is_error: false,
            result: "Late Native Title",
            subtype: "success",
            type: "result",
          };
        },
        close: () => {
          counts.closes += 1;
        },
        interrupt: async () => {
          counts.interrupts += 1;
        },
      };
    },
  };
  const runtime = new LocalClaudeRuntime({ sdk });
  setClaudeRuntimeForTests(runtime);
  return { counts, release, runtime, started };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  setChatgptRuntimeForTests(null);
  setClaudeRuntimeForTests(null);
});

describe("session title cancellation through provider adapters", () => {
  test("cancels the OpenAI generateText fetch without retry or estimated failed usage", async () => {
    const entered = deferred<AbortSignal>();
    const response = deferred<Response>();
    let requests = 0;
    let aborted = false;
    globalThis.fetch = ((url: unknown, init?: RequestInit) => {
      requests += 1;
      expect(String(url)).toBe(
        "https://title-fixture.invalid/v1/chat/completions"
      );
      const signal = init?.signal;
      if (!signal) {
        throw new Error("Expected fetch cancellation signal.");
      }
      entered.resolve(signal);
      return new Promise<Response>((resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(signal.reason);
          },
          { once: true }
        );
        response.promise.then(resolve, reject);
      });
    }) as typeof fetch;
    const tracker = await LlmUsageTracker.create();
    const provider = wrapProviderWithUsageTracking(
      createOpenAIProvider({
        apiKey: "local-fake-key",
        baseUrl: "https://title-fixture.invalid/v1",
        model: MODEL,
      }),
      tracker,
      MODEL
    );
    const controller = new AbortController();
    const result = title(provider, controller.signal);
    const signal = await entered.promise;

    controller.abort();
    response.resolve(
      Response.json({
        choices: [
          { message: { content: "Late API Title", role: "assistant" } },
        ],
      })
    );
    const resolvedTitle = await result;
    await Bun.sleep(0);

    expect(signal.aborted).toBe(true);
    expect(aborted).toBe(true);
    expect(resolvedTitle).toBeNull();
    expect(requests).toBe(1);
    expect(tracker.getStats()).toMatchObject(expectedUnknownUsage());
  });

  test("a pre-cancelled title does not dispatch an OpenAI request", async () => {
    let requests = 0;
    globalThis.fetch = (() => {
      requests += 1;
      return Promise.resolve(
        Response.json({
          choices: [
            { message: { content: "Late API Title", role: "assistant" } },
          ],
        })
      );
    }) as unknown as typeof fetch;
    const tracker = await LlmUsageTracker.create();
    const provider = wrapProviderWithUsageTracking(
      createOpenAIProvider({
        apiKey: "local-fake-key",
        baseUrl: "https://title-fixture.invalid/v1",
        model: MODEL,
      }),
      tracker,
      MODEL
    );
    const controller = new AbortController();
    controller.abort();

    const result = await title(provider, controller.signal);

    expect(requests).toBe(0);
    expect(result).toBeNull();
    expect(tracker.getStats().requestCount).toBe(0);
  });

  for (const lateId of [false, true]) {
    test(`interrupts a ChatGPT title ${lateId ? "with a late turn ID" : "after native dispatch"} and retains unknown usage`, async () => {
      await withConfig(async () => {
        const fixture = codexFixture({ lateId });
        try {
          const tracker = await LlmUsageTracker.create();
          const provider = wrapProviderWithUsageTracking(
            createChatgptProvider({ model: MODEL }),
            tracker,
            MODEL
          );
          const controller = new AbortController();
          const result = title(provider, controller.signal);
          const start = await fixture.started.promise;

          controller.abort();
          await Bun.sleep(0);
          if (lateId) {
            fixture.respondToStart(start);
          }
          fixture.complete();
          const resolvedTitle = await result;
          await Bun.sleep(0);

          expect(
            fixture.requests.filter(
              (request) => request.method === "turn/interrupt"
            )
          ).toEqual([
            expect.objectContaining({
              params: { threadId: "title-thread", turnId: "title-turn" },
            }),
          ]);
          expect(resolvedTitle).toBeNull();
          expect(
            fixture.requests.filter(
              (request) => request.method === "turn/start"
            )
          ).toHaveLength(1);
          expect(fixture.server.deletedThreads).toEqual(["title-thread"]);
          expect(tracker.getStats()).toMatchObject(expectedUnknownUsage());
        } finally {
          fixture.server.close();
        }
      });
    });
  }

  test("cancels a Claude title query and ignores its later completion without inventing usage", async () => {
    await withConfig(async () => {
      const fixture = claudeFixture();
      const tracker = await LlmUsageTracker.create();
      const provider = wrapProviderWithUsageTracking(
        createClaudeProvider({ model: MODEL }),
        tracker,
        MODEL
      );
      const controller = new AbortController();
      const result = title(provider, controller.signal);
      const nativeSignal = await fixture.started.promise;

      controller.abort();
      await Bun.sleep(0);
      fixture.release.resolve();
      const resolvedTitle = await result;
      await Bun.sleep(0);

      expect(nativeSignal.aborted).toBe(true);
      expect(fixture.counts.interrupts).toBe(1);
      expect(fixture.counts.closes).toBe(1);
      expect(fixture.counts.inferenceStarts).toBe(1);
      expect(resolvedTitle).toBeNull();
      expect(tracker.getStats()).toMatchObject(expectedUnknownUsage());
    });
  });

  test("a ChatGPT auth response arriving after title cancellation cannot start inference", async () => {
    await withConfig(async () => {
      const fixture = codexFixture({ completeImmediately: true });
      const auth = deferred<void>();
      fixture.server.authGate = auth.promise;
      try {
        const controller = new AbortController();
        const result = title(
          createChatgptProvider({ model: MODEL }),
          controller.signal
        );
        await fixture.server.authStarted.promise;
        controller.abort();
        auth.resolve();
        const resolvedTitle = await result;
        await Bun.sleep(0);

        expect(fixture.server.threadStarts).toBe(0);
        expect(
          fixture.requests.filter((request) => request.method === "turn/start")
        ).toHaveLength(0);
        expect(resolvedTitle).toBeNull();
      } finally {
        auth.resolve();
        fixture.server.close();
      }
    });
  });

  test("a Claude auth response arriving after title cancellation cannot start a native query", async () => {
    await withConfig(async () => {
      const fixture = claudeFixture();
      const auth = deferred<void>();
      fixture.runtime.authGate = auth.promise;
      const controller = new AbortController();
      const result = title(
        createClaudeProvider({ model: MODEL }),
        controller.signal
      );
      await fixture.runtime.authStarted.promise;
      controller.abort();
      auth.resolve();
      fixture.release.resolve();
      const resolvedTitle = await result;
      await Bun.sleep(0);

      expect(fixture.counts.queries).toBe(0);
      expect(fixture.counts.inferenceStarts).toBe(0);
      expect(resolvedTitle).toBeNull();
    });
  });
});
