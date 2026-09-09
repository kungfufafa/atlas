import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  IncompleteCompletionError,
  runWithUserConfigDir,
  type SubscriptionAuthState,
} from "@atlas/core";
import { LlmUsageTracker } from "../../services/llm-usage-tracker";
import { getProviderFailureEvidence } from "../failure-evidence";
import { wrapProviderWithUsageTracking } from "../usage-tracking";
import { createClaudeProvider } from "./claude/provider";
import {
  type ClaudeQueryHandle,
  ClaudeSubscriptionRuntime,
} from "./claude/runtime";
import { SubscriptionRuntimeError } from "./errors";
import { setClaudeRuntimeForTests } from "./runtimes";

class AuthenticatedClaude extends ClaudeSubscriptionRuntime {
  override async getAuthState(): Promise<SubscriptionAuthState> {
    return { authenticated: true, provider: "claude", status: "authenticated" };
  }
}
const originalCause = new Error("original cause");
const nativeFailure = new SubscriptionRuntimeError(
  "claude",
  "model_unavailable",
  "Original native classification",
  { cause: originalCause }
);
const cases = [
  { name: "string", thrown: "callback primitive failure" },
  { name: "number", thrown: 17 },
  { name: "null", thrown: null },
  { name: "undefined", thrown: undefined },
  {
    name: "Error",
    thrown: new Error("callback object failure", { cause: originalCause }),
  },
  { name: "SubscriptionRuntimeError", thrown: nativeFailure },
];
afterEach(() => setClaudeRuntimeForTests(null));

test.each(cases)(
  "known native result counters survive an onChunk $name throw with original cause and diagnostics",
  async ({ thrown }) => {
    const directory = await mkdtemp(
      join(tmpdir(), "native-primitive-failure-")
    );
    let consumedPrompts = 0;
    let deliveredChunks = 0;
    try {
      await runWithUserConfigDir(directory, async () => {
        setClaudeRuntimeForTests(
          new AuthenticatedClaude({
            sdk: {
              query: (): ClaudeQueryHandle => ({
                supportedModels: async () => [
                  { displayName: "Synthetic model", value: "native-fixture" },
                ],
                async *[Symbol.asyncIterator]() {
                  consumedPrompts++;
                  yield {
                    is_error: false,
                    model: "native-fixture",
                    result: "Native result before callback failure",
                    subtype: "success",
                    type: "result",
                    usage: { input_tokens: 13, output_tokens: 19 },
                  };
                },
              }),
            },
          })
        );
        const tracker = await LlmUsageTracker.create();
        const provider = wrapProviderWithUsageTracking(
          createClaudeProvider({ model: "native-fixture" }),
          tracker,
          "native-fixture"
        );
        let failure: unknown;
        try {
          await provider.streamChat(
            {
              messages: [{ content: "one native query", role: "user" }],
              system: "Synthetic",
            },
            {
              onChunk: () => {
                deliveredChunks++;
                throw thrown;
              },
            }
          );
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeInstanceOf(SubscriptionRuntimeError);
        if (thrown instanceof SubscriptionRuntimeError) {
          expect(failure).toBe(thrown);
          expect(thrown.cause).toBe(originalCause);
        } else {
          expect((failure as Error).cause).toBe(thrown);
        }
        expect(failure).not.toBeInstanceOf(IncompleteCompletionError);
        expect(tracker.getStats()).toMatchObject({
          inputTokens: 13,
          outputTokens: 19,
          requestCount: 1,
        });
        expect(getProviderFailureEvidence(failure)).toMatchObject({
          content: "Native result before callback failure",
          toolInputFragments: [],
          usage: { inputTokens: 13, outputTokens: 19 },
        });
        expect(getProviderFailureEvidence(failure)).not.toHaveProperty(
          "toolCalls"
        );
        expect(consumedPrompts).toBe(1);
        expect(deliveredChunks).toBe(1);
        expect(provider.managesContext).toBe(true);
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }
);
