import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { IncompleteCompletionError, type ProviderClient } from "@atlas/core";
import { LlmUsageTracker } from "../services/llm-usage-tracker";
import {
  captureProviderFailureEvidence,
  getProviderFailureEvidence,
  reportedProviderFailureUsage,
} from "./failure-evidence";
import { CodexAppServer } from "./subscription/chatgpt/app-server";
import { SubscriptionRuntimeError } from "./subscription/errors";
import {
  JsonRpcStdioClient,
  type JsonRpcStdioProcess,
} from "./subscription/jsonrpc-stdio";
import { wrapProviderWithUsageTracking } from "./usage-tracking";

const evidence = {
  content: 'Partial ```atlas-tool-call\n{"name":"delete_file"',
  thinking: "Synthetic trace",
  toolInputFragments: [
    { arguments: '{"path":', id: "partial", name: "write_file" },
  ],
  usage: { inputTokens: 13, outputTokens: 19 },
};
test("diagnostic snapshots preserve error identity, native classification and nested causes without executable calls", () => {
  const original = new Error("native failure");
  const native = new SubscriptionRuntimeError(
    "claude",
    "model_unavailable",
    "Original model refusal",
    { cause: original }
  );
  expect(captureProviderFailureEvidence(native, evidence)).toBe(native);
  const outer = new Error("outer", {
    cause: new Error("middle", { cause: native }),
  });
  const captured = getProviderFailureEvidence(outer);
  expect(captured).toEqual({ ...evidence, contextUsage: undefined });
  expect(captured).not.toHaveProperty("toolCalls");
  expect(captured?.toolInputFragments[0]?.arguments).toBe('{"path":');
  expect(native.cause).toBe(original);
  expect(native.code).toBe("model_unavailable");
  expect(native).not.toBeInstanceOf(IncompleteCompletionError);
  const cyclic = new Error("cycle");
  cyclic.cause = cyclic;
  expect(getProviderFailureEvidence(cyclic)).toBeUndefined();
});

test.each(["generateChat", "streamChat", "generateText"] as const)(
  "%s records nested-cause usage once and rethrows the exact error without replay",
  async (method) => {
    const native = captureProviderFailureEvidence(
      new Error("native"),
      evidence
    );
    const error = new SubscriptionRuntimeError(
      "chatgpt",
      "rate_limited",
      "Rate limit",
      { cause: new Error("middle", { cause: native }) }
    );
    let requests = 0;
    const fail = async (): Promise<never> => {
      requests++;
      throw error;
    };
    const tracker = await LlmUsageTracker.create();
    const provider: ProviderClient = wrapProviderWithUsageTracking(
      {
        generateChat: fail,
        generateText: fail,
        managesContext: true,
        name: "chatgpt",
        streamChat: fail,
      },
      tracker,
      "native-fixture"
    );
    const input = {
      messages: [{ content: "one request", role: "user" as const }],
      system: "Synthetic",
    };
    const result =
      method === "generateText"
        ? provider.generateText({ prompt: "one request", system: input.system })
        : method === "generateChat"
          ? provider.generateChat(input)
          : provider.streamChat(input, { onChunk: () => {} });
    await expect(result).rejects.toBe(error);
    expect(requests).toBe(1);
    expect(tracker.getStats()).toMatchObject({
      inputTokens: 13,
      outputTokens: 19,
      requestCount: 1,
    });
    expect(provider.managesContext).toBe(true);
  }
);

test("partial, absent, invalid or estimated failure counters are never recorded or derived from context", async () => {
  for (const usage of [
    undefined,
    { inputTokens: 13 },
    { outputTokens: 19, totalTokens: 32 },
    { inputTokens: -1, outputTokens: 2 },
    { inputTokens: 1.2, outputTokens: 2 },
    { inputTokens: 1, outputTokens: Number.NaN },
    { estimated: true, inputTokens: 1, outputTokens: 2 },
  ]) {
    const failure = captureProviderFailureEvidence(new Error("unknown"), {
      ...evidence,
      contextUsage: { contextWindow: 4096, usedTokens: 1200 },
      usage,
    });
    expect(reportedProviderFailureUsage(failure)).toBeUndefined();
  }
  expect(
    reportedProviderFailureUsage(
      captureProviderFailureEvidence(new Error("zero"), {
        ...evidence,
        usage: { inputTokens: 0, outputTokens: 0 },
      })
    )
  ).toEqual({ inputTokens: 0, outputTokens: 0 });
});

class LocalProcess extends EventEmitter implements JsonRpcStdioProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  pid = 1;
  kill() {
    this.emit("exit", 0);
  }
}

test("actual app-server cancellation retains partial diagnostics and context, but never records occupancy or cumulative totals as turn counters", async () => {
  const child = new LocalProcess();
  const controller = new AbortController();
  let starts = 0;
  let interrupts = 0;
  const send = (value: unknown) =>
    child.stdout.write(JSON.stringify(value) + "\n");
  child.stdin.on("data", (chunk) => {
    for (const line of String(chunk).split("\n").filter(Boolean)) {
      const request = JSON.parse(line);
      if (request.method === "turn/interrupt") {
        interrupts++;
        send({ id: request.id, result: {} });
      }
      if (request.method !== "turn/start") {
        continue;
      }
      starts++;
      send({ id: request.id, result: { turn: { id: "turn" } } });
      setTimeout(() => {
        send({
          method: "item/agentMessage/delta",
          params: {
            delta: evidence.content,
            threadId: "thread",
            turnId: "turn",
          },
        });
        send({
          method: "item/reasoning/textDelta",
          params: {
            delta: evidence.thinking,
            threadId: "thread",
            turnId: "turn",
          },
        });
        send({
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "thread",
            tokenUsage: {
              last: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200 },
              modelContextWindow: 4096,
              total: {
                inputTokens: 8000,
                outputTokens: 1999,
                totalTokens: 9999,
              },
            },
            turnId: "turn",
          },
        });
        controller.abort();
      }, 0);
    }
  });
  const server = new CodexAppServer({
    client: new JsonRpcStdioClient(child),
    turnTimeoutMs: 1000,
  });
  try {
    let failure: unknown;
    try {
      await server.startTurn({
        input: "fixture",
        signal: controller.signal,
        threadId: "thread",
      });
    } catch (error) {
      failure = error;
    }
    const captured = getProviderFailureEvidence(failure);
    expect(captured).toMatchObject({
      content: evidence.content,
      contextUsage: { contextWindow: 4096, usedTokens: 1200 },
      thinking: evidence.thinking,
      toolInputFragments: [],
    });
    expect(captured?.usage).toBeUndefined();
    expect(reportedProviderFailureUsage(failure)).toBeUndefined();
    expect(starts).toBe(1);
    expect(interrupts).toBe(1);
  } finally {
    server.close();
  }
});
