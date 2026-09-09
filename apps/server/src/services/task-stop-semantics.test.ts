import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import type { AgentChatSession } from "@atlas/agent";
import {
  type CanonicalPrincipal,
  type GenerateChatInput,
  PROVIDER_CAPABILITY_IDS,
  type ProviderClient,
  type ToolDefinition,
  type UserConfig,
} from "@atlas/core";
import { createSqliteDatabase, type SqliteDatabase } from "@atlas/db";
import { ProviderAdapterRegistry } from "../providers";
import { setupTestConfigDir } from "../test-config-dir";
import { AgentService } from "./agent-service";
import { TaskRunner } from "./task-runner";
import { TaskService } from "./task-service";

setupTestConfigDir("atlas-task-stop-");
const databases: SqliteDatabase[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close();
  }
});
const principal: CanonicalPrincipal = {
  isPlatformAdmin: false,
  orgId: "stop-org",
  orgRole: "member",
  userId: "stop-user",
};
const finalText =
  "Observed checks are preserved; further work remains unfinished.";
type Mode = "stall" | "iterate" | "success" | "native-stop" | "native-natural";

async function fixture(initialMode: Mode) {
  const database = await createSqliteDatabase(
    join(process.env.ATLAS_CONFIG_DIR!, "task.sqlite")
  );
  databases.push(database);
  const db = database.adapter;
  const at = "2026-09-01T00:00:00.000Z";
  await db.upsertOrganization({
    createdAt: at,
    id: principal.orgId,
    name: "Stop tests",
    slug: "stop-tests",
    updatedAt: at,
  });
  await db.createUser({
    createdAt: at,
    email: "stop@example.test",
    id: principal.userId,
    passwordHash: "unused",
    updatedAt: at,
  });
  await db.upsertOrgMember({
    createdAt: at,
    orgId: principal.orgId,
    role: "member",
    userId: principal.userId,
  });
  await db.upsertProfile({
    createdAt: at,
    id: "stop-profile",
    isDefault: true,
    isSuper: false,
    model: "stop-provider::synthetic",
    name: "Stop profile",
    orgId: principal.orgId,
    systemPrompt: "Perform the requested work using observed results.",
    updatedAt: at,
  });
  await db.upsertOrgAiConfig({
    config: {
      defaultProviderId: "stop-provider",
      providers: [
        {
          apiKey: "",
          baseUrl: "https://synthetic.invalid/v1",
          createdAt: at,
          customModels: [{ default: true, id: "synthetic" }],
          id: "stop-provider",
          label: "Deterministic fixture",
          type: "openai_compatible",
        },
      ],
    } satisfies UserConfig,
    orgId: principal.orgId,
    updatedAt: at,
  });
  let mode = initialMode;
  let requests = 0;
  let effects = 0;
  let buildCalls = 0;
  let finalFailure: Error | undefined;
  let finalGate: Promise<void> | undefined;
  let onFinalizing: (() => void) | undefined;
  const tool: ToolDefinition = {
    description: "Inspect current state",
    name: "read_state",
    parameters: { properties: {}, type: "object" },
    async run() {
      effects += 1;
      return { step: mode === "iterate" ? effects : 0 };
    },
  };
  async function generate(input: GenerateChatInput) {
    requests += 1;
    const final = () => ({
      assistantMessage: { content: finalText, role: "assistant" as const },
      content: finalText,
      toolCalls: [],
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
    });
    if (mode === "success") {
      return final();
    }
    if (!input.tools) {
      onFinalizing?.();
      await finalGate;
      if (finalFailure) {
        throw finalFailure;
      }
      return final();
    }
    if (mode.startsWith("native")) {
      for (
        let index = 0;
        index < (mode === "native-stop" ? 5 : 4);
        index += 1
      ) {
        await input.executeToolCall!({
          arguments: {},
          id: "native-" + index,
          name: "read_state",
        });
      }
      return final();
    }
    const toolCalls = [
      { arguments: {}, id: "call-" + requests, name: "read_state" },
    ];
    return {
      assistantMessage: {
        content: "Inspecting.",
        role: "assistant" as const,
        toolCalls,
      },
      content: "Inspecting.",
      toolCalls,
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
    };
  }
  const provider: ProviderClient = {
    generateChat: generate,
    async generateText() {
      return { content: "Synthetic task" };
    },
    name: "openai_compatible",
    async streamChat(input, handlers) {
      const result = await generate(input);
      handlers.onChunk(result.content);
      return result;
    },
  };
  const registry = new ProviderAdapterRegistry();
  const chatCapabilities = [
    PROVIDER_CAPABILITY_IDS.chatCompletion,
    PROVIDER_CAPABILITY_IDS.chatToolUse,
    PROVIDER_CAPABILITY_IDS.chatStreaming,
  ];
  const claim = {
    source: "static-manifest",
    status: "supported",
    verified: true,
  } as const;
  registry.register({
    chatCapabilities,
    createChatClient: () => provider,
    credentialsRequired: () => false,
    manifest: {
      adapterApiVersion: 1,
      capabilities: Object.fromEntries(
        chatCapabilities.map((id) => [
          id,
          {
            contractVersion: 1,
            implementation: { status: "available" },
            metadata: { description: id, label: id, routable: true },
            modelDefault: claim,
            native: claim,
          },
        ])
      ),
      manifestRevision: "deterministic-stop-test",
      provider: {
        displayName: "Deterministic fixture",
        id: "openai_compatible",
      },
      schemaVersion: 1,
    },
  });
  const agent = new AgentService(null, null, db, undefined, registry);
  const boundary = agent as unknown as {
    resolveProfileTools(): Promise<ToolDefinition[]>;
    buildChatSession(...args: unknown[]): Promise<AgentChatSession>;
  };
  boundary.resolveProfileTools = async () => [tool];
  const realBuild = boundary.buildChatSession.bind(agent);
  boundary.buildChatSession = (...args) => {
    buildCalls += 1;
    return realBuild(...args);
  };
  const tasks = new TaskService(db);
  const task = await tasks.create(
    principal.orgId,
    {
      prompt: "Perform the work and report observed results.",
      title: "Mechanical completion",
    },
    "stop-profile",
    undefined,
    principal.userId
  );
  const runner = new TaskRunner(tasks, agent, agent.identityService);
  return {
    counts: () => ({ buildCalls, effects, requests }),
    database,
    db,
    failFinal: (error: Error) => {
      finalFailure = error;
    },
    holdFinalization: () => {
      const start = Promise.withResolvers<void>();
      const gate = Promise.withResolvers<void>();
      onFinalizing = () => start.resolve();
      finalGate = gate.promise;
      return { release: () => gate.resolve(), started: start.promise };
    },
    runner,
    succeed: () => {
      mode = "success";
    },
    task,
    tasks,
  };
}

test.each(["stall", "iterate", "native-stop"] as const)(
  "real persisted session and TaskRunner keep %s output but do not mark task done",
  async (mode) => {
    const f = await fixture(mode);
    const result = await f.runner.run(f.task.id, principal);
    expect(result.output).toBe(finalText);
    expect((await f.tasks.get(f.task.id, principal.orgId))?.status).toBe(
      "failed"
    );
    expect(result.error).toContain(
      mode === "iterate" ? "iteration_limit" : "no_progress"
    );
    expect(Object.keys(result).sort()).toEqual(["error", "output"]);
    expect(f.runner.isRunning(f.task.id)).toBe(false);
    expect(f.counts()).toEqual({
      buildCalls: 1,
      effects: mode === "iterate" ? 100 : 4,
      requests: mode === "iterate" ? 101 : mode === "native-stop" ? 2 : 5,
    });
    await f.database.reopen();
    const updated = await f.tasks.get(f.task.id, principal.orgId);
    expect(updated?.status).toBe("failed");
    const runs = await f.tasks.listRuns(f.task.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      error: result.error,
      output: finalText,
      status: "failed",
    });
    const history = await f.db.listMessagesForSession(updated!.sessionId!);
    expect(history.at(-1)?.payload).toMatchObject({
      content: finalText,
      role: "assistant",
    });
    f.succeed();
    const next = await f.runner.run(f.task.id, principal);
    expect(next).toEqual({ output: finalText });
    expect((await f.tasks.get(f.task.id, principal.orgId))?.status).toBe(
      "done"
    );
    expect(await f.tasks.listRuns(f.task.id)).toHaveLength(2);
  }
);

test("a native runtime naturally ending at the detector threshold remains successful", async () => {
  const f = await fixture("native-natural");
  expect(await f.runner.run(f.task.id, principal)).toEqual({
    output: finalText,
  });
  expect(f.counts()).toEqual({ buildCalls: 1, effects: 4, requests: 1 });
  expect((await f.tasks.get(f.task.id, principal.orgId))?.status).toBe("done");
});

test("failed finalization preserves original failure text, the reason, and persisted completed effects without invented output", async () => {
  const f = await fixture("stall");
  const message = "Synthetic transport failure after completed tool actions";
  f.failFinal(new Error(message));
  const result = await f.runner.run(f.task.id, principal);
  expect(result.error).toContain(message);
  expect(result.error).toContain("no_progress");
  expect(result.output).toBeUndefined();
  expect(Object.keys(result)).toEqual(["error"]);
  expect(f.runner.isRunning(f.task.id)).toBe(false);
  const runs = await f.tasks.listRuns(f.task.id);
  expect(runs[0]).toMatchObject({
    error: result.error,
    output: null,
    status: "failed",
  });
  const updated = await f.tasks.get(f.task.id, principal.orgId);
  const history = await f.db.listMessagesForSession(updated!.sessionId!);
  expect(history.at(-1)?.payload).toMatchObject({ role: "tool" });
  expect(f.counts()).toEqual({ buildCalls: 1, effects: 4, requests: 5 });
});

test("concurrent task invocations do not overwrite another run's typed stop evidence", async () => {
  const f = await fixture("stall");
  const gate = f.holdFinalization();
  const first = f.runner.run(f.task.id, principal);
  await gate.started;
  try {
    f.succeed();
    const second = await f.tasks.create(
      principal.orgId,
      {
        prompt: "Return the already-known result.",
        title: "Independent normal task",
      },
      "stop-profile",
      undefined,
      principal.userId
    );
    expect(await f.runner.run(second.id, principal)).toEqual({
      output: finalText,
    });
    expect((await f.tasks.get(second.id, principal.orgId))?.status).toBe(
      "done"
    );
    expect(f.runner.isRunning(f.task.id)).toBe(true);
  } finally {
    gate.release();
  }
  expect((await first).error).toContain("no_progress");
  expect((await f.tasks.get(f.task.id, principal.orgId))?.status).toBe(
    "failed"
  );
  expect(f.runner.getActiveRunCount()).toBe(0);
});
