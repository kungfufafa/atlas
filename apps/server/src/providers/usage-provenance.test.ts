import { Database as Sqlite } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatCompletionResult, ProviderClient } from "@atlas/core";
import {
  createInMemoryDatabaseAdapter,
  createSqliteDatabase,
  type DatabaseAdapter,
} from "@atlas/db";
import { LlmUsageTracker } from "../services/llm-usage-tracker";
import { captureProviderFailureEvidence } from "./failure-evidence";
import { wrapProviderWithUsageTracking } from "./usage-tracking";

const input = {
  messages: [{ content: "Synthetic user input", role: "user" as const }],
  system: "Synthetic system",
};
const textInput = {
  prompt: "Synthetic user input",
  system: "Synthetic system",
};
function result(usage?: ChatCompletionResult["usage"]): ChatCompletionResult {
  return {
    assistantMessage: { content: "Done", role: "assistant" },
    content: "Done",
    toolCalls: [],
    ...(usage ? { usage } : {}),
  };
}
function provider(
  run: () => Promise<ChatCompletionResult>,
  managesContext = false
): ProviderClient {
  return {
    generateChat: run,
    generateText: run,
    managesContext,
    name: "openai_compatible",
    streamChat: run,
  };
}
const provenance = (
  reported: number,
  estimated: number,
  unknown: number,
  unclassified = 0
) => ({
  allInvocationsReported: estimated + unknown + unclassified === 0,
  estimatedInvocations: estimated,
  reportedInvocations: reported,
  unclassifiedInvocations: unclassified,
  unknownInvocations: unknown,
});

for (const kind of ["sqlite", "in-memory"] as const) {
  test(`${kind}: reported, estimated and unknown invocations survive reload with model separation`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "atlas-usage-provenance-"));
    const store =
      kind === "sqlite"
        ? await createSqliteDatabase(`file:${join(directory, "usage.db")}`)
        : { adapter: createInMemoryDatabaseAdapter(), close() {} };
    let reopened: Awaited<ReturnType<typeof createSqliteDatabase>> | undefined;
    try {
      const tracker = await LlmUsageTracker.create(store.adapter);
      let calls = 0;
      const original = new Error("known synthetic failure");
      const client = wrapProviderWithUsageTracking(
        provider(async () => {
          calls++;
          if (calls === 1) {
            return result({
              inputTokens: 17,
              outputTokens: 5,
              totalTokens: 22,
            });
          }
          if (calls === 2) {
            return result();
          }
          throw original;
        }),
        tracker,
        "model-a"
      );
      await client.generateChat(input);
      const estimated = await client.generateChat(input);
      await expect(client.generateChat(input)).rejects.toBe(original);
      expect(calls).toBe(3);
      expect(estimated.usage?.estimated).toBe(true);
      const expected = tracker.getStats();
      expect(expected).toMatchObject({
        inputTokens: 17 + (estimated.usage?.inputTokens ?? -1000),
        outputTokens: 5 + (estimated.usage?.outputTokens ?? -1000),
        provenance: provenance(1, 1, 1),
        requestCount: 3,
      });
      await tracker.flush();
      store.close();
      if (kind === "sqlite") {
        reopened = await createSqliteDatabase(
          `file:${join(directory, "usage.db")}`
        );
      }
      const next = await LlmUsageTracker.create(
        reopened?.adapter ?? store.adapter
      );
      expect(next.getStats()).toEqual(expected);
      expect(next.getStatsByModel()).toMatchObject([
        {
          modelId: "model-a",
          provenance: provenance(1, 1, 1),
          requestCount: 3,
        },
      ]);
      const zero = wrapProviderWithUsageTracking(
        provider(
          async () =>
            result({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
          true
        ),
        next,
        "model-zero"
      );
      await zero.generateChat(input);
      next.record("legacy-direct", 3, 4);
      await next.flush();
      await next.reloadFromDatabase();
      expect(
        next.getStatsByModel().find((row) => row.modelId === "model-zero")
      ).toMatchObject({
        inputTokens: 0,
        outputTokens: 0,
        provenance: provenance(1, 0, 0),
        requestCount: 1,
      });
      expect(
        next.getStatsByModel().find((row) => row.modelId === "legacy-direct")
      ).toMatchObject({ provenance: provenance(0, 0, 0, 1), requestCount: 1 });
      expect(
        next.getStatsByModel().find((row) => row.modelId === "model-a")
      ).toMatchObject({ provenance: provenance(1, 1, 1), requestCount: 3 });
      expect(next.getStats()).toMatchObject({
        provenance: provenance(2, 1, 1, 1),
        requestCount: 5,
      });
    } finally {
      store.close();
      reopened?.close();
      await rm(directory, { force: true, recursive: true });
    }
  });
}

test("legacy SQLite migration leaves prior requests unclassified over repeated opens", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-usage-legacy-"));
  const path = join(directory, "usage.db");
  const old = new Sqlite(path);
  for (const [table, key] of [
    ["llm_usage_stats", "id"],
    ["llm_usage_model_stats", "model_id"],
  ]) {
    old.exec(
      `CREATE TABLE ${table} (${key} TEXT PRIMARY KEY NOT NULL, request_count INTEGER NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, estimated_cost_usd REAL NOT NULL, tracked_since TEXT NOT NULL, updated_at TEXT NOT NULL)`
    );
    old
      .prepare(`INSERT INTO ${table} VALUES (?, 4, 31, 9, 0.01, ?, ?)`)
      .run(
        table === "llm_usage_stats" ? "default" : "old-model",
        "2020-01-01",
        "2020-01-01"
      );
  }
  old.close();
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const store = await createSqliteDatabase(`file:${path}`);
      try {
        const tracker = await LlmUsageTracker.create(store.adapter);
        expect(tracker.getStats()).toMatchObject({
          inputTokens: 31,
          outputTokens: 9,
          provenance: provenance(0, 0, 0, 4),
          requestCount: 4,
        });
        expect(tracker.getStatsByModel()).toMatchObject([
          {
            modelId: "old-model",
            provenance: provenance(0, 0, 0, 4),
            requestCount: 4,
          },
        ]);
      } finally {
        store.close();
      }
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

const usageCases = [
  { name: "absent", usage: undefined },
  { name: "partial", usage: { inputTokens: 12 } },
  {
    name: "invalid",
    usage: { inputTokens: Number.NaN, outputTokens: -2, totalTokens: -2 },
  },
];
for (const scenario of usageCases) {
  test(`managed runtime ${scenario.name} counters remain unknown across all three APIs`, async () => {
    const tracker = await LlmUsageTracker.create();
    let calls = 0;
    const original = result(scenario.usage as ChatCompletionResult["usage"]);
    const client = wrapProviderWithUsageTracking(
      provider(async () => {
        calls++;
        return original;
      }, true),
      tracker,
      "native-model"
    );
    const chat = await client.generateChat(input);
    const text = await client.generateText(textInput);
    const stream = await client.streamChat(input, { onChunk() {} });
    expect(chat).toBe(original);
    expect(text).toBe(original);
    expect(stream).toBe(original);
    expect(calls).toBe(3);
    expect(client.managesContext).toBe(true);
    expect(tracker.getStats()).toMatchObject({
      estimatedCostUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      provenance: provenance(0, 0, 3),
      requestCount: 3,
    });
  });
}

test("reported zero, provider estimates and mixed API counters retain distinct provenance", async () => {
  const tracker = await LlmUsageTracker.create();
  const values = [
    { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    { estimated: true, inputTokens: 5, outputTokens: 7, totalTokens: 12 },
    { inputTokens: 11 } as ChatCompletionResult["usage"],
  ];
  let calls = 0;
  const client = wrapProviderWithUsageTracking(
    provider(async () => result(values[calls++])),
    tracker,
    "api-model"
  );
  await client.generateChat(input);
  const explicitEstimate = await client.streamChat(input, { onChunk() {} });
  const partial = await client.generateChat(input);
  expect(explicitEstimate.usage?.estimated).toBe(true);
  expect(partial.usage).toMatchObject({ estimated: true, inputTokens: 11 });
  expect(tracker.getStats()).toMatchObject({
    provenance: provenance(1, 2, 0),
    requestCount: 3,
  });
});

test("native failure evidence records once through causes; unknown and synchronous failures remain original", async () => {
  const tracker = await LlmUsageTracker.create();
  const inner = captureProviderFailureEvidence(new Error("native failed"), {
    content: "partial diagnostic",
    toolInputFragments: [],
    usage: { inputTokens: 0, outputTokens: 0 },
  });
  const outer = new Error("classified", { cause: inner });
  const unknown = new Error("unknown failure");
  let calls = 0;
  const client = wrapProviderWithUsageTracking(
    provider(() => {
      calls++;
      if (calls === 1) {
        return Promise.reject(outer);
      }
      throw unknown;
    }, true),
    tracker,
    "native-model"
  );
  await expect(client.generateChat(input)).rejects.toBe(outer);
  await expect(client.generateText(textInput)).rejects.toBe(unknown);
  await expect(client.streamChat(input, { onChunk() {} })).rejects.toBe(
    unknown
  );
  expect(calls).toBe(3);
  expect(outer.cause).toBe(inner);
  expect(tracker.getStats()).toMatchObject({
    inputTokens: 0,
    outputTokens: 0,
    provenance: provenance(1, 0, 2),
    requestCount: 3,
  });
});

test("global/model provenance does not populate or alter the separate scoped daily reports", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-usage-org-"));
  const store = await createSqliteDatabase(
    `file:${join(directory, "usage.db")}`
  );
  try {
    for (const [orgId, tokens] of [
      ["org-a", 7],
      ["org-b", 19],
    ] as const) {
      await store.adapter.incrementLlmUsageDaily(
        {
          capability: "chat.completion",
          channel: "web",
          modelId: "shared-model",
          orgId,
          profileId: "profile",
          providerCredentialId: "credential",
          providerType: "fixture",
          userId: "user",
        },
        {
          estimatedCostUsd: 0,
          inputTokens: tokens,
          outputTokens: 0,
          requestCount: 1,
        }
      );
    }
    const query = (adapter: DatabaseAdapter, orgId: string) =>
      adapter.aggregateLlmUsage({ groupBy: "model", orgId });
    const beforeA = await query(store.adapter, "org-a");
    const beforeB = await query(store.adapter, "org-b");
    const tracker = await LlmUsageTracker.create(store.adapter);
    tracker.recordInvocation("shared-model", { source: "unknown" });
    await tracker.flush();
    await store.reopen();
    expect(await query(store.adapter, "org-a")).toEqual(beforeA);
    expect(await query(store.adapter, "org-b")).toEqual(beforeB);
    expect(beforeA).toMatchObject([{ inputTokens: 7, requestCount: 1 }]);
    expect(beforeB).toMatchObject([{ inputTokens: 19, requestCount: 1 }]);
  } finally {
    store.close();
    await rm(directory, { force: true, recursive: true });
  }
});
