import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runWithUserConfigDir, type SubscriptionAuthState } from "@atlas/core";
import { LlmUsageTracker } from "../../services/llm-usage-tracker";
import { wrapProviderWithUsageTracking } from "../usage-tracking";
import { CodexAppServer } from "./chatgpt/app-server";
import { createChatgptProvider } from "./chatgpt/provider";
import { ChatgptSubscriptionRuntime } from "./chatgpt/runtime";
import { createClaudeProvider } from "./claude/provider";
import {
  type ClaudeQueryHandle,
  ClaudeSubscriptionRuntime,
} from "./claude/runtime";
import { SubscriptionRuntimeError } from "./errors";
import { JsonRpcStdioClient, type JsonRpcStdioProcess } from "./jsonrpc-stdio";
import {
  setChatgptRuntimeForTests,
  setClaudeRuntimeForTests,
} from "./runtimes";

class FakeProcess extends EventEmitter implements JsonRpcStdioProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  pid = 1;
  kill() {
    this.emit("exit", 0);
  }
}
class LocalCodexServer extends CodexAppServer {
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
class AuthenticatedClaude extends ClaudeSubscriptionRuntime {
  override async getAuthState(): Promise<SubscriptionAuthState> {
    return { authenticated: true, provider: "claude", status: "authenticated" };
  }
}
const partialText =
  'Unfinished response\n```atlas-tool-call\n{"name":"write_file","arguments":{"path":"never-execute"';
const input = {
  messages: [{ content: "Fail once", role: "user" as const }],
  system: "Synthetic local fixture",
};
const cases = [
  {
    expected: [1, 13, 19],
    name: "known",
    usage: { inputTokens: 13, outputTokens: 19, totalTokens: 32 },
  },
  {
    expected: [1, 0, 0],
    name: "zero",
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  },
  { expected: [1, 0, 0], name: "partial", usage: { inputTokens: 13 } },
  { expected: [1, 0, 0], name: "absent", usage: undefined },
] as const;
afterEach(() => {
  setChatgptRuntimeForTests(null);
  setClaudeRuntimeForTests(null);
});

for (const kind of ["chatgpt", "claude"] as const) {
  for (const fixture of cases) {
    for (const status of ["failed", "interrupted"] as const) {
      test(`${kind} ${status} ${fixture.name} native usage is retained once without retry or estimation`, async () => {
        const directory = await mkdtemp(join(tmpdir(), "native-failed-usage-"));
        let starts = 0;
        let close = () => {};
        try {
          await runWithUserConfigDir(directory, async () => {
            if (kind === "chatgpt") {
              const child = new FakeProcess();
              const send = (value: unknown) =>
                child.stdout.write(JSON.stringify(value) + "\n");
              child.stdin.on("data", (chunk) => {
                for (const line of String(chunk).split("\n").filter(Boolean)) {
                  const request = JSON.parse(line);
                  if (request.method !== "turn/start") {
                    continue;
                  }
                  starts++;
                  send({
                    id: request.id,
                    result: { turn: { id: "native-turn" } },
                  });
                  send({
                    method: "item/agentMessage/delta",
                    params: {
                      delta: partialText,
                      threadId: "native-thread",
                      turnId: "native-turn",
                    },
                  });
                  send({
                    method: "item/reasoning/textDelta",
                    params: {
                      delta: "Synthetic partial thinking",
                      threadId: "native-thread",
                      turnId: "native-turn",
                    },
                  });
                  send({
                    method: "thread/tokenUsage/updated",
                    params: {
                      threadId: "native-thread",
                      tokenUsage: {
                        last: {
                          inputTokens: 1000,
                          outputTokens: 200,
                          totalTokens: 1200,
                        },
                        modelContextWindow: 4096,
                        total: {
                          inputTokens: 8000,
                          outputTokens: 1999,
                          totalTokens: 9999,
                        },
                      },
                      turnId: "native-turn",
                    },
                  });
                  send({
                    method: "turn/completed",
                    params: {
                      threadId: "native-thread",
                      turn: {
                        error: { message: "429 rate limit fixture" },
                        id: "native-turn",
                        status,
                        usage: fixture.usage,
                      },
                    },
                  });
                }
              });
              const server = new LocalCodexServer({
                client: new JsonRpcStdioClient(child),
                turnTimeoutMs: 1000,
              });
              close = () => server.close();
              setChatgptRuntimeForTests(new ChatgptSubscriptionRuntime(server));
            } else {
              const runtime = new AuthenticatedClaude({
                sdk: {
                  query: ({ prompt }): ClaudeQueryHandle => {
                    if (typeof prompt === "string") {
                      throw new Error("Expected native streaming input.");
                    }
                    return {
                      supportedModels: async () => [
                        {
                          displayName: "Synthetic model",
                          value: "native-fixture",
                        },
                      ],
                      async *[Symbol.asyncIterator]() {
                        const input =
                          await prompt[Symbol.asyncIterator]().next();
                        if (!input.done) {
                          starts++;
                        }
                        yield {
                          message: {
                            content: [
                              { text: partialText, type: "text" },
                              {
                                thinking: "Synthetic partial thinking",
                                type: "thinking",
                              },
                            ],
                            model: "native-fixture",
                          },
                          type: "assistant",
                        };
                        yield {
                          errors: [
                            status === "failed"
                              ? "429 rate limit fixture"
                              : "Claude turn cancelled.",
                          ],
                          is_error: true,
                          subtype: "error_during_execution",
                          type: "result",
                          usage: fixture.usage,
                        };
                      },
                    };
                  },
                },
              });
              setClaudeRuntimeForTests(runtime);
            }
            const tracker = await LlmUsageTracker.create();
            const native =
              kind === "chatgpt"
                ? createChatgptProvider({ model: "native-fixture" })
                : createClaudeProvider({ model: "native-fixture" });
            const tracked = wrapProviderWithUsageTracking(
              native,
              tracker,
              "native-fixture"
            );
            let failure: unknown;
            try {
              await tracked.streamChat(input, { onChunk: () => {} });
            } catch (error) {
              failure = error;
            }
            expect(failure).toBeInstanceOf(SubscriptionRuntimeError);
            expect((failure as SubscriptionRuntimeError).code).toBe(
              status === "failed" ? "rate_limited" : "runtime_error"
            );
            expect(starts).toBe(1);
            expect(tracked.managesContext).toBe(true);
            expect(tracker.getStats()).toMatchObject({
              inputTokens: fixture.expected[1],
              outputTokens: fixture.expected[2],
              provenance: {
                reportedInvocations:
                  fixture.name === "known" || fixture.name === "zero" ? 1 : 0,
                unknownInvocations:
                  fixture.name === "known" || fixture.name === "zero" ? 0 : 1,
              },
              requestCount: fixture.expected[0],
            });
          });
        } finally {
          close();
          await rm(directory, { force: true, recursive: true });
        }
      });
    }
  }
}
