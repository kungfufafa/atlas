import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { enforceChatCapabilityPolicy } from "@atlas/agent";
import {
  PROVIDER_CAPABILITY_IDS,
  runWithUserConfigDir,
  type SubscriptionAuthState,
} from "@atlas/core";
import { createInMemoryDatabaseAdapter } from "@atlas/db";
import { LlmUsageTracker } from "../../services/llm-usage-tracker";
import { getProviderFailureEvidence } from "../failure-evidence";
import { wrapProviderWithUsageTracking } from "../usage-tracking";
import { CodexAppServer, type CodexModel } from "./chatgpt/app-server";
import { ChatgptSubscriptionRuntime } from "./chatgpt/runtime";
import type { ClaudeRuntimeModel } from "./claude/metadata";
import { createClaudeProvider } from "./claude/provider";
import {
  type ClaudeAgentSdk,
  ClaudeSubscriptionRuntime,
} from "./claude/runtime";
import { setClaudeRuntimeForTests } from "./runtimes";

async function isolated<T>(operation: () => Promise<T>) {
  const directory = await mkdtemp(join(tmpdir(), "atlas-fidelity-state-"));
  try {
    return await runWithUserConfigDir(directory, operation);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

const input = {
  messages: [
    { content: "Return only JSON with ok=true.", role: "user" as const },
  ],
  system: "Return only the requested answer.",
};

class CodexFake extends CodexAppServer {
  threads = 0;
  turns = 0;
  deletes = 0;
  accounts = 0;
  models = 0;
  onModels?: () => void;
  onAccount?: () => void;
  accountGate?: Promise<void>;
  modelGate?: Promise<void>;
  onThread?: () => void;
  override async account() {
    this.accounts++;
    this.onAccount?.();
    await this.accountGate;
    return { type: "chatgpt" };
  }
  override async listModels(): Promise<CodexModel[]> {
    this.models++;
    this.onModels?.();
    await this.modelGate;
    return [{ id: "exact-native", isDefault: true }];
  }
  override async startThread() {
    this.threads++;
    this.onThread?.();
    return "scratch-thread";
  }
  override async deleteThread() {
    this.deletes++;
  }
  override async startTurn(
    options: Parameters<CodexAppServer["startTurn"]>[0]
  ) {
    this.turns++;
    options.signal?.throwIfAborted();
    return { text: '{"ok":true}', thinking: "" };
  }
}
class CodexAuthenticated extends ChatgptSubscriptionRuntime {
  authReads = 0;
  onAuth?: () => void;
  override async getAuthState(): Promise<SubscriptionAuthState> {
    this.authReads++;
    this.onAuth?.();
    return {
      authenticated: true,
      provider: "chatgpt",
      status: "authenticated",
    };
  }
}

for (const point of ["before", "auth", "models"] as const) {
  test(`ChatGPT cancellation ${point} prevents native thread and turn creation`, async () => {
    const controller = new AbortController();
    const server = new CodexFake();
    const runtime = new CodexAuthenticated(server);
    if (point === "before") {
      controller.abort();
    }
    if (point === "auth") {
      runtime.onAuth = () => controller.abort();
    }
    if (point === "models") {
      server.onModels = () => controller.abort();
    }
    await isolated(async () => {
      await expect(
        runtime.generateChat(
          { ...input, signal: controller.signal },
          "exact-native"
        )
      ).rejects.toThrow();
      expect(server.threads).toBe(0);
      expect(server.turns).toBe(0);
      if (point === "before") {
        expect(runtime.authReads).toBe(0);
      }
      if (point === "auth") {
        expect(server.models).toBe(0);
      }
    });
  });
}

test("ChatGPT cancellation after thread creation prevents turn and cleans up the created thread", async () => {
  const controller = new AbortController();
  const server = new CodexFake();
  server.onThread = () => controller.abort();
  const runtime = new CodexAuthenticated(server);
  await isolated(async () => {
    await expect(
      runtime.generateChat(
        { ...input, signal: controller.signal },
        "exact-native"
      )
    ).rejects.toThrow();
    expect(server.threads).toBe(1);
    expect(server.turns).toBe(0);
    expect(server.deletes).toBe(1);
  });
});

test("ChatGPT uncancelled exact selection still returns unchanged answer", async () => {
  const server = new CodexFake();
  const runtime = new CodexAuthenticated(server);
  await isolated(async () => {
    expect((await runtime.generateChat(input, "exact-native")).content).toBe(
      '{"ok":true}'
    );
    expect(server.threads).toBe(1);
    expect(server.turns).toBe(1);
  });
});

class ClaudeAuthenticated extends ClaudeSubscriptionRuntime {
  override async getAuthState(): Promise<SubscriptionAuthState> {
    return { authenticated: true, provider: "claude", status: "authenticated" };
  }
}
const textDelta = (text: string) => ({
  event: { delta: { text, type: "text_delta" }, type: "content_block_delta" },
  type: "stream_event",
});
const modelStart = (model: string) => ({
  event: { message: { model }, type: "message_start" },
  type: "stream_event",
});
const answer = (model?: string) => ({
  result: '{"ok":true}',
  subtype: "success",
  type: "result",
  ...(model ? { model } : {}),
  usage: { input_tokens: 10, output_tokens: 4 },
});

function claudeFixture(messages: unknown[], models?: ClaudeRuntimeModel[]) {
  const nativeInputs: unknown[] = [];
  const requestedModels: unknown[] = [];
  const sdk: ClaudeAgentSdk = {
    query({ prompt, options }) {
      if (options?.model) {
        requestedModels.push(options.model);
      }
      if (typeof prompt === "string") {
        throw new Error("Expected native streaming input");
      }
      const iterator = prompt[Symbol.asyncIterator]();
      void iterator.next().then((next) => {
        if (!next.done) {
          nativeInputs.push(next.value);
        }
      });
      return {
        async *[Symbol.asyncIterator]() {
          for (const message of messages) {
            yield message;
          }
        },
        ...(models === undefined
          ? {}
          : { supportedModels: async () => models }),
        close() {},
      };
    },
  };
  return {
    nativeInputs,
    requestedModels,
    runtime: new ClaudeAuthenticated({ sdk }),
  };
}

for (const streaming of [false, true]) {
  test(`Claude terminal model rejection retains reported usage without publishing unverified content (${streaming ? "stream" : "nonstream"})`, async () => {
    const fixture = claudeFixture(
      [textDelta('{"ok":'), answer("unselected-other")],
      [{ resolvedModel: "native-exact", value: "chosen" }]
    );
    const chunks: string[] = [];
    await isolated(async () => {
      setClaudeRuntimeForTests(fixture.runtime);
      try {
        const tracker = await LlmUsageTracker.create();
        const provider = wrapProviderWithUsageTracking(
          createClaudeProvider({ model: "chosen" }),
          tracker,
          "chosen",
          { provider: "claude" }
        );
        let failure: unknown;
        try {
          if (streaming) {
            await provider.streamChat(input, {
              onChunk: (chunk) => chunks.push(chunk),
            });
          } else {
            await provider.generateChat(input);
          }
        } catch (error) {
          failure = error;
        }
        expect(failure).toMatchObject({ code: "model_unavailable" });
        expect(chunks).toEqual([]);
        expect(fixture.nativeInputs).toHaveLength(1);
        expect(tracker.getStats()).toMatchObject({
          inputTokens: 10,
          outputTokens: 4,
          requestCount: 1,
        });
        expect(getProviderFailureEvidence(failure)).toMatchObject({
          content: '{"ok":',
          usage: { inputTokens: 10, outputTokens: 4 },
        });
      } finally {
        setClaudeRuntimeForTests(null);
      }
    });
  });
}

for (const streaming of [false, true]) {
  test(`Claude advertised alias resolves without changing JSON (${streaming ? "stream" : "nonstream"})`, async () => {
    const { runtime } = claudeFixture(
      [
        modelStart("native-exact"),
        textDelta('{"ok":'),
        textDelta("true}"),
        answer("native-exact"),
      ],
      [{ resolvedModel: "native-exact", value: "advertised-alias" }]
    );
    const chunks: string[] = [];
    await isolated(async () => {
      const result = streaming
        ? await runtime.streamChat(
            input,
            { onChunk: (c) => chunks.push(c) },
            "advertised-alias"
          )
        : await runtime.generateChat(input, "advertised-alias");
      expect(JSON.parse(result.content)).toEqual({ ok: true });
      expect(result.content).toBe('{"ok":true}');
      if (streaming) {
        expect(chunks.join("")).toBe(result.content);
      }
    });
  });
  test(`Claude rejects genuine model substitution (${streaming ? "stream" : "nonstream"})`, async () => {
    const { runtime } = claudeFixture(
      [
        modelStart("unselected-other"),
        textDelta('{"ok":true}'),
        answer("unselected-other"),
      ],
      [
        { resolvedModel: "native-exact", value: "chosen" },
        { value: "unselected-other" },
      ]
    );
    const chunks: string[] = [];
    await isolated(async () => {
      const run = streaming
        ? runtime.streamChat(
            input,
            { onChunk: (c) => chunks.push(c) },
            "chosen"
          )
        : runtime.generateChat(input, "chosen");
      await expect(run).rejects.toMatchObject({ code: "model_unavailable" });
      expect(chunks).toEqual([]);
    });
  });
}

test("Claude holds unidentified deltas until the terminal identity and rejects before publishing", async () => {
  const { runtime } = claudeFixture(
    [textDelta('{"ok":true}'), answer("other")],
    [{ resolvedModel: "chosen", value: "chosen" }]
  );
  const chunks: string[] = [];
  await isolated(async () => {
    await expect(
      runtime.streamChat(input, { onChunk: (c) => chunks.push(c) }, "chosen")
    ).rejects.toMatchObject({ code: "model_unavailable" });
    expect(chunks).toEqual([]);
  });
});

test("Claude exact selection works when optional catalog is absent without guessing aliases", async () => {
  const { runtime } = claudeFixture([
    modelStart("chosen"),
    textDelta('{"ok":true}'),
    answer("chosen"),
  ]);
  await isolated(async () => {
    expect((await runtime.generateChat(input, "chosen")).content).toBe(
      '{"ok":true}'
    );
  });
});

test("Claude does not infer similar-name alias equivalence from missing metadata", async () => {
  const { runtime } = claudeFixture([answer("chosen-2026")]);
  await isolated(async () => {
    await expect(runtime.generateChat(input, "chosen")).rejects.toMatchObject({
      code: "model_unavailable",
    });
  });
});

test("Claude advertised catalog rejects an unavailable explicit model before yielding user input", async () => {
  const { runtime, nativeInputs } = claudeFixture(
    [answer("other")],
    [{ value: "other" }]
  );
  await isolated(async () => {
    await expect(runtime.generateChat(input, "chosen")).rejects.toMatchObject({
      code: "model_unavailable",
    });
    expect(nativeInputs).toEqual([]);
  });
});

test("Claude terminal-only verified identity releases pending fragments exactly once", async () => {
  const { runtime } = claudeFixture(
    [textDelta('{"ok":'), textDelta("true}"), answer("exact")],
    [{ resolvedModel: "exact", value: "exact" }]
  );
  const chunks: string[] = [];
  await isolated(async () => {
    const result = await runtime.streamChat(
      input,
      { onChunk: (c) => chunks.push(c) },
      "exact"
    );
    expect(chunks.join("")).toBe('{"ok":true}');
    expect(result.content).toBe(chunks.join(""));
  });
});

test("Claude rejects a later contradictory identity without appending metadata to prior valid chunks", async () => {
  const { runtime } = claudeFixture(
    [modelStart("exact"), textDelta('{"ok":'), answer("other")],
    [{ resolvedModel: "exact", value: "exact" }]
  );
  const chunks: string[] = [];
  await isolated(async () => {
    await expect(
      runtime.streamChat(input, { onChunk: (c) => chunks.push(c) }, "exact")
    ).rejects.toMatchObject({ code: "model_unavailable" });
    expect(chunks).toEqual(['{"ok":']);
  });
});

test("Claude explicitly empty native catalog prevents user inference", async () => {
  const { runtime, nativeInputs } = claudeFixture([answer("chosen")], []);
  await isolated(async () => {
    await expect(runtime.generateChat(input, "chosen")).rejects.toMatchObject({
      code: "model_unavailable",
    });
    expect(nativeInputs).toEqual([]);
  });
});

test("Claude missing native identity preserves the answer without inventing model metadata", async () => {
  const { runtime } = claudeFixture(
    [textDelta('{"ok":true}'), answer()],
    [{ resolvedModel: "chosen", value: "chosen" }]
  );
  const chunks: string[] = [];
  await isolated(async () => {
    const result = await runtime.streamChat(
      input,
      { onChunk: (c) => chunks.push(c) },
      "chosen"
    );
    expect(result.content).toBe('{"ok":true}');
    expect(chunks.join("")).toBe(result.content);
  });
});

test("actual SDK optional alias resolution remains usable and explicitly unverifiable through wrappers", async () => {
  const advertisedOnly = {
    description: "No canonical resolution was advertised.",
    displayName: "Native advertised alias",
    value: "advertised-only",
  } satisfies ModelInfo;
  const { runtime, requestedModels } = claudeFixture(
    [
      modelStart("canonical-from-native"),
      textDelta('{"ok":true}'),
      answer("canonical-from-native"),
    ],
    [advertisedOnly]
  );
  setClaudeRuntimeForTests(runtime);
  try {
    await isolated(async () => {
      const tracker = await LlmUsageTracker.create(
        createInMemoryDatabaseAdapter()
      );
      const supported = { selectable: true, status: "supported" } as const;
      const provider = enforceChatCapabilityPolicy(
        wrapProviderWithUsageTracking(
          createClaudeProvider({ model: advertisedOnly.value }),
          tracker,
          advertisedOnly.value
        ),
        {
          capabilities: {
            [PROVIDER_CAPABILITY_IDS.chatCompletion]: supported,
            [PROVIDER_CAPABILITY_IDS.chatStreaming]: supported,
          },
        }
      );
      const chunks: string[] = [];
      const results = [
        await provider.generateChat(input),
        await provider.streamChat(input, { onChunk: (c) => chunks.push(c) }),
        await provider.generateText({
          format: "text",
          prompt: "Return only JSON with ok=true.",
          system: input.system,
        }),
      ];
      for (const result of results) {
        expect(result.content).toBe('{"ok":true}');
        expect(result.modelIdentity).toEqual({
          basis: "unresolved-alias",
          reportedModels: ["canonical-from-native"],
          requestedModel: advertisedOnly.value,
          verification: "unverifiable",
        });
      }
      expect(chunks.join("")).toBe('{"ok":true}');
      expect(requestedModels).toEqual([
        advertisedOnly.value,
        advertisedOnly.value,
        advertisedOnly.value,
      ]);
      expect(provider.managesContext).toBe(true);
    });
  } finally {
    setClaudeRuntimeForTests(null);
  }
});

test("exact native evidence is verified even when optional catalog is absent", async () => {
  const { runtime } = claudeFixture([answer("explicit-exact")]);
  await isolated(async () => {
    const result = await runtime.generateChat(input, "explicit-exact");
    expect(result.modelIdentity).toEqual({
      basis: "exact",
      reportedModels: ["explicit-exact"],
      requestedModel: "explicit-exact",
      verification: "verified",
    });
  });
});

test("no native identity stays unverifiable rather than inventing verification", async () => {
  const { runtime } = claudeFixture([answer()], [{ value: "advertised-only" }]);
  await isolated(async () => {
    const result = await runtime.generateChat(input, "advertised-only");
    expect(result.modelIdentity).toEqual({
      basis: "not-reported",
      reportedModels: [],
      requestedModel: "advertised-only",
      verification: "unverifiable",
    });
  });
});

for (const stage of ["account", "model"] as const) {
  test(`ChatGPT abort settles while ${stage} preflight is still pending and cannot start later`, async () => {
    const server = new CodexFake();
    const runtime = new CodexAuthenticated(server);
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const controller = new AbortController();
    if (stage === "account") {
      server.accountGate = gate.promise;
      server.onAccount = entered.resolve;
    } else {
      server.modelGate = gate.promise;
      server.onModels = entered.resolve;
    }
    await isolated(async () => {
      const request = runtime.generateChat(
        { ...input, signal: controller.signal },
        "exact-native"
      );
      const outcome = request.then(
        () => "completed",
        () => "rejected"
      );
      await entered.promise;
      controller.abort();
      try {
        expect(
          await Promise.race([outcome, Bun.sleep(100).then(() => "pending")])
        ).toBe("rejected");
      } finally {
        gate.resolve();
        await outcome;
      }
      expect(server.threads).toBe(0);
      expect(server.turns).toBe(0);
    });
  });
}
