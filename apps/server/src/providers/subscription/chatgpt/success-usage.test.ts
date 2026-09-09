import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  IncompleteCompletionError,
  type ProviderClient,
  runWithUserConfigDir,
} from "@atlas/core";
import { LlmUsageTracker } from "../../../services/llm-usage-tracker";
import { getProviderFailureEvidence } from "../../failure-evidence";
import { wrapProviderWithUsageTracking } from "../../usage-tracking";
import { SubscriptionRuntimeError } from "../errors";
import { JsonRpcStdioClient, type JsonRpcStdioProcess } from "../jsonrpc-stdio";
import { setChatgptRuntimeForTests } from "../runtimes";
import { CodexAppServer, type CodexTurnUsage } from "./app-server";
import { createChatgptProvider } from "./provider";
import { ChatgptSubscriptionRuntime } from "./runtime";

class FakeProcess extends EventEmitter implements JsonRpcStdioProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  pid = 1;
  kill() {
    this.emit("exit", 0);
  }
}
class LocalServer extends CodexAppServer {
  override async account() {
    return { type: "chatgpt" as const };
  }
  override async listModels() {
    return [{ id: "native-fixture", isDefault: true }];
  }
  override async readModelProviderCapabilities() {
    return { imageGeneration: false, namespaceTools: false, webSearch: false };
  }
  override async startThread() {
    return "native-thread";
  }
  override async deleteThread() {}
}
const input = {
  messages: [{ content: "Synthetic task", role: "user" as const }],
  system: "Synthetic system",
};
const toolText =
  'Visible result\n```atlas-tool-call\n{"id":"diagnostic-call","name":"write_file","arguments":{"path":"never-execute.txt","content":"diagnostic only"}}\n```';
const tool = {
  description: "Synthetic file capability",
  name: "write_file",
  parameters: { type: "object" },
};
afterEach(() => setChatgptRuntimeForTests(null));

async function withRuntime(
  usage:
    | CodexTurnUsage
    | undefined
    | ((ordinal: number) => CodexTurnUsage | undefined),
  check: (
    provider: ProviderClient,
    tracker: LlmUsageTracker,
    starts: () => number
  ) => Promise<void>,
  text = "Visible result"
) {
  const directory = await mkdtemp(join(tmpdir(), "chatgpt-success-usage-"));
  const child = new FakeProcess();
  let starts = 0;
  const send = (value: unknown) =>
    child.stdout.write(`${JSON.stringify(value)}\n`);
  child.stdin.on("data", (chunk) => {
    for (const line of String(chunk).split("\n").filter(Boolean)) {
      const request = JSON.parse(line);
      if (request.method !== "turn/start") {
        continue;
      }
      const ordinal = starts++;
      const turnId = `turn-${ordinal}`;
      const turnUsage = typeof usage === "function" ? usage(ordinal) : usage;
      send({ id: request.id, result: { turn: { id: turnId } } });
      send({
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "native-thread",
          tokenUsage: {
            last: {
              inputTokens: 1000 + ordinal * 100,
              outputTokens: 200 + ordinal * 40,
              totalTokens: 1200 + ordinal * 140,
            },
            modelContextWindow: 4096,
            total: { inputTokens: 8000, outputTokens: 1999, totalTokens: 9999 },
          },
          turnId,
        },
      });
      send({
        method: "item/reasoning/summaryTextDelta",
        params: {
          delta: "Native diagnostic reasoning",
          threadId: "native-thread",
          turnId,
        },
      });
      send({
        method: "item/agentMessage/delta",
        params: { delta: text, threadId: "native-thread", turnId },
      });
      send({
        method: "turn/completed",
        params: {
          threadId: "native-thread",
          turn: {
            id: turnId,
            status: "completed",
            ...(turnUsage ? { usage: turnUsage } : {}),
          },
        },
      });
    }
  });
  const server = new LocalServer({
    client: new JsonRpcStdioClient(child),
    turnTimeoutMs: 1000,
  });
  try {
    await runWithUserConfigDir(directory, async () => {
      setChatgptRuntimeForTests(new ChatgptSubscriptionRuntime(server));
      const tracker = await LlmUsageTracker.create();
      const provider = wrapProviderWithUsageTracking(
        createChatgptProvider({ model: "native-fixture" }),
        tracker,
        "native-fixture"
      );
      await check(provider, tracker, () => starts);
    });
  } finally {
    server.close();
    await rm(directory, { force: true, recursive: true });
  }
}

const cases = [
  { known: false, name: "absent", usage: undefined },
  {
    known: true,
    name: "known",
    usage: { inputTokens: 13, outputTokens: 19, totalTokens: 32 },
  },
  {
    known: true,
    name: "zero",
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  },
  { known: false, name: "input-only", usage: { inputTokens: 13 } },
  {
    known: false,
    name: "input-and-total",
    usage: { inputTokens: 13, totalTokens: 32 },
  },
  { known: false, name: "total-only", usage: { totalTokens: 32 } },
  {
    known: false,
    name: "invalid",
    usage: { inputTokens: -3, outputTokens: 1.5 },
  },
] as const;

for (const fixture of cases) {
  test(`successful native ${fixture.name} turn usage stays separate from context and cumulative counters`, async () => {
    await withRuntime(fixture.usage, async (provider, tracker, starts) => {
      for (let index = 0; index < 2; index++) {
        const result = await provider.generateChat(input);
        expect(result.content).toBe("Visible result");
        expect(result.contextUsage).toEqual({
          contextWindow: 4096,
          usedTokens: 1200 + index * 140,
        });
        if (fixture.known) {
          expect(result.usage).toEqual(fixture.usage);
        } else {
          expect(result.usage).toBeUndefined();
        }
      }
      expect(starts()).toBe(2);
      expect(provider.managesContext).toBe(true);
      expect(tracker.getStats()).toMatchObject({
        inputTokens: fixture.known ? fixture.usage.inputTokens * 2 : 0,
        outputTokens: fixture.known ? fixture.usage.outputTokens * 2 : 0,
        provenance: {
          reportedInvocations: fixture.known ? 2 : 0,
          unknownInvocations: fixture.known ? 0 : 2,
        },
        requestCount: 2,
      });
    });
  });
}

for (const fixture of [cases[0], cases[1], cases[2], cases[4]]) {
  test(`buffered callback failure keeps ${fixture.name} explicit native usage and non-executable diagnostics`, async () => {
    const cause = new Error("original callback cause");
    const failure = new Error("callback failed", { cause });
    await withRuntime(
      fixture.usage,
      async (provider, tracker, starts) => {
        let delivered = 0;
        let caught: unknown;
        try {
          await provider.streamChat(
            { ...input, tools: [tool] },
            {
              onChunk: (text) => {
                delivered++;
                expect(text).toBe("Visible result");
                throw failure;
              },
            }
          );
        } catch (error) {
          caught = error;
        }
        expect(caught).toBe(failure);
        expect(failure.cause).toBe(cause);
        expect(caught).not.toBeInstanceOf(IncompleteCompletionError);
        expect(starts()).toBe(1);
        expect(delivered).toBe(1);
        const evidence = getProviderFailureEvidence(caught);
        expect(evidence).toMatchObject({
          content: toolText,
          contextUsage: { contextWindow: 4096, usedTokens: 1200 },
          thinking: "Native diagnostic reasoning",
          toolInputFragments: [
            {
              arguments:
                '{"path":"never-execute.txt","content":"diagnostic only"}',
              id: "diagnostic-call",
              name: "write_file",
            },
          ],
        });
        expect(evidence).not.toHaveProperty("toolCalls");
        expect(tracker.getStats()).toMatchObject({
          inputTokens: fixture.known ? fixture.usage.inputTokens : 0,
          outputTokens: fixture.known ? fixture.usage.outputTokens : 0,
          provenance: {
            reportedInvocations: fixture.known ? 1 : 0,
            unknownInvocations: fixture.known ? 0 : 1,
          },
          requestCount: 1,
        });
      },
      toolText
    );
  });
}

test("buffered classified and primitive failures keep their original identity or cause", async () => {
  const cause = new Error("original cause");
  const classified = new SubscriptionRuntimeError(
    "chatgpt",
    "model_unavailable",
    "Original classification",
    { cause }
  );
  for (const thrown of [classified, "primitive callback failure", null]) {
    await withRuntime(
      { inputTokens: 13, outputTokens: 19 },
      async (provider, tracker, starts) => {
        let caught: unknown;
        try {
          await provider.streamChat(
            { ...input, tools: [tool] },
            {
              onChunk: () => {
                throw thrown;
              },
            }
          );
        } catch (error) {
          caught = error;
        }
        if (thrown === classified) {
          expect(caught).toBe(classified);
          expect(classified.cause).toBe(cause);
        } else {
          expect(caught).toBeInstanceOf(SubscriptionRuntimeError);
          expect((caught as Error).cause).toBe(thrown);
        }
        expect(getProviderFailureEvidence(caught)?.usage).toMatchObject({
          inputTokens: 13,
          outputTokens: 19,
        });
        expect(tracker.getStats()).toMatchObject({
          inputTokens: 13,
          outputTokens: 19,
          requestCount: 1,
        });
        expect(starts()).toBe(1);
      }
    );
  }
});

test("incomplete returned tool syntax preserves known counters as diagnostics and never returns executable calls", async () => {
  const raw =
    'Incomplete\n```atlas-tool-call\n{"name":"write_file","arguments":{"path":"never-execute.txt"';
  await withRuntime(
    { inputTokens: 13, outputTokens: 19 },
    async (provider, tracker, starts) => {
      let caught: unknown;
      try {
        await provider.generateChat({ ...input, tools: [tool] });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SubscriptionRuntimeError);
      expect(getProviderFailureEvidence(caught)).toMatchObject({
        content: raw,
        toolInputFragments: [],
        usage: { inputTokens: 13, outputTokens: 19 },
      });
      expect(getProviderFailureEvidence(caught)).not.toHaveProperty(
        "toolCalls"
      );
      expect(tracker.getStats()).toMatchObject({
        inputTokens: 13,
        outputTokens: 19,
        requestCount: 1,
      });
      expect(starts()).toBe(1);
    },
    raw
  );
});

for (const reuse of ["same-error", "linked-cause"] as const) {
  for (const nextUsage of ["known", "unknown"] as const) {
    test(`current completed turn wins over ${reuse} evidence when next usage is ${nextUsage}`, async () => {
      const original = new Error("callback reused across turns");
      const second =
        reuse === "same-error"
          ? original
          : new Error("new callback error", { cause: original });
      await withRuntime(
        (ordinal) =>
          ordinal === 0
            ? { inputTokens: 13, outputTokens: 19 }
            : nextUsage === "known"
              ? { inputTokens: 5, outputTokens: 7 }
              : undefined,
        async (provider, tracker, starts) => {
          for (const thrown of [original, second]) {
            let caught: unknown;
            try {
              await provider.streamChat(
                { ...input, tools: [tool] },
                {
                  onChunk: () => {
                    throw thrown;
                  },
                }
              );
            } catch (error) {
              caught = error;
            }
            expect(caught).toBe(thrown);
          }
          if (reuse === "linked-cause") {
            expect(second.cause).toBe(original);
          }
          const evidence = getProviderFailureEvidence(second);
          if (nextUsage === "unknown") {
            expect(evidence?.usage).toBeUndefined();
          } else {
            expect(evidence?.usage).toMatchObject({
              inputTokens: 5,
              outputTokens: 7,
            });
          }
          expect(starts()).toBe(2);
          expect(tracker.getStats()).toMatchObject({
            inputTokens: nextUsage === "known" ? 18 : 13,
            outputTokens: nextUsage === "known" ? 26 : 19,
            provenance: {
              reportedInvocations: nextUsage === "known" ? 2 : 1,
              unknownInvocations: nextUsage === "known" ? 0 : 1,
            },
            requestCount: 2,
          });
        }
      );
    });
  }
}
