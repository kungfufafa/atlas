import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type AgentChatSession,
  type AgentHarness,
  executeToolCall,
} from "@atlas/agent";
import { getCustomToolsDir, type ToolContext } from "@atlas/core";
import {
  createInMemoryDatabaseAdapter,
  type DatabaseAdapter,
  type StoredToolRecord,
} from "@atlas/db";
import { setupTestConfigDir } from "../test-config-dir";
import { AgentService } from "./agent-service";
import { loadJavascriptTool } from "./javascript-tool-loader";

const ORG_ID = "org_tool_reload";
const PROFILE_ID = "profile_tool_reload";
const TOOL_ID = "tool_reload_probe";
const MODULE_FILENAME = "reload-probe.js";

setupTestConfigDir("atlas-agent-tool-reload-");

async function seedTool(db: DatabaseAdapter): Promise<StoredToolRecord> {
  await seedProfile(db);
  const now = new Date().toISOString();
  const record: StoredToolRecord = {
    createdAt: now,
    description: "Reload probe",
    handlerConfig: { modulePath: MODULE_FILENAME },
    handlerType: "javascript",
    id: TOOL_ID,
    name: "reload_probe",
    orgId: ORG_ID,
    updatedAt: now,
  };
  await db.upsertTool(record);
  await db.assignToolToProfile(PROFILE_ID, TOOL_ID);
  return record;
}

async function seedProfile(db: DatabaseAdapter): Promise<void> {
  const now = new Date().toISOString();
  await db.upsertOrganization({
    createdAt: now,
    id: ORG_ID,
    name: "Tool reload",
    slug: "tool-reload",
    updatedAt: now,
  });
  await db.upsertProfile({
    createdAt: now,
    id: PROFILE_ID,
    isDefault: true,
    isSuper: false,
    model: null,
    name: "Tool reload",
    orgId: ORG_ID,
    systemPrompt: "",
    updatedAt: now,
  });
}

function captureSessionToolGuard(service: AgentService): {
  read: () => ToolContext["beforeToolCall"];
} {
  let beforeToolCall: ToolContext["beforeToolCall"];
  const history: never[] = [];
  const session: AgentChatSession = {
    clear() {
      history.length = 0;
    },
    async compact() {
      return {
        action: "none",
        messagesAfter: history.length,
        messagesBefore: history.length,
      };
    },
    async createAutomation() {
      throw new Error("not used");
    },
    getContextUsage: () => null,
    getHistory: () => history,
    getHistoryRevision: () => 0,
    send: async () => "unused",
    sendStream: async () => "unused",
  };
  (
    service as unknown as {
      createHarnessForProfile: () => AgentHarness;
    }
  ).createHarnessForProfile = () => ({
    async createAutomationFromPrompt() {
      throw new Error("not used");
    },
    createChatSession(options) {
      beforeToolCall = options?.toolContext?.beforeToolCall;
      return session;
    },
  });
  return { read: () => beforeToolCall };
}

async function createResolvedSession(
  service: AgentService,
  guard: ReturnType<typeof captureSessionToolGuard>
): Promise<void> {
  const sessionId = await service.createSession(
    ORG_ID,
    "web",
    PROFILE_ID,
    "user_1",
    { orgRole: "admin" }
  );
  expect(await service.resolveSession(ORG_ID, sessionId)).not.toBeNull();
  expect(guard.read()).toBeFunction();
}

describe("AgentService JavaScript tool reload", () => {
  test("legacy org config migration keeps the first session tool guard current", async () => {
    const db = createInMemoryDatabaseAdapter();
    await seedProfile(db);
    const service = new AgentService(
      { defaultProviderId: null, providers: [] },
      null,
      db
    );
    const guard = captureSessionToolGuard(service);

    await createResolvedSession(service, guard);

    await expect(guard.read()?.()).resolves.toBeUndefined();
  });

  test("legacy org config migration keeps a restored session tool guard current", async () => {
    const db = createInMemoryDatabaseAdapter();
    await seedProfile(db);
    const now = new Date().toISOString();
    await db.upsertSession({
      agentQuestionnaire: null,
      agentTodos: [],
      channel: "web",
      createdAt: now,
      id: "session_before_bootstrap",
      modelOverride: null,
      orgId: ORG_ID,
      profileId: PROFILE_ID,
      title: null,
      userId: "user_1",
    });
    const service = new AgentService(
      { defaultProviderId: null, providers: [] },
      null,
      db
    );
    const guard = captureSessionToolGuard(service);

    expect(
      await service.resolveSession(ORG_ID, "session_before_bootstrap")
    ).not.toBeNull();
    await expect(guard.read()?.()).resolves.toBeUndefined();
  });

  test("revoking retrySafe stops an active retry through the stale session guard", async () => {
    const toolsDir = getCustomToolsDir();
    await mkdir(toolsDir, { recursive: true });
    const modulePath = path.join(toolsDir, MODULE_FILENAME);
    await writeFile(
      modulePath,
      `export const retrySafe = true;
export async function run() {
  const probe = globalThis.__atlasRetryReloadProbe;
  probe.attempts += 1;
  probe.started();
  throw new Error("transient custom failure");
}
`,
      "utf8"
    );

    const db = createInMemoryDatabaseAdapter();
    const record = await seedTool(db);
    const service = new AgentService(null, null, db);
    const guard = captureSessionToolGuard(service);
    await createResolvedSession(service, guard);
    const staleTool = await loadJavascriptTool(record);
    if (!staleTool?.retryPolicy) {
      throw new Error("Expected retry-safe JavaScript tool");
    }
    staleTool.retryPolicy = {
      ...staleTool.retryPolicy,
      initialDelayMs: 25,
    };

    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const runtime = globalThis as typeof globalThis & {
      __atlasRetryReloadProbe?: {
        attempts: number;
        started: () => void;
      };
    };
    runtime.__atlasRetryReloadProbe = {
      attempts: 0,
      started: () => markStarted?.(),
    };

    try {
      const pending = executeToolCall(
        [staleTool],
        { arguments: {}, id: "call_stale_retry", name: staleTool.name },
        { beforeToolCall: guard.read() }
      );
      await started;

      await writeFile(
        modulePath,
        `export async function run() {
  return { version: "reloaded" };
}
`,
        "utf8"
      );
      expect(
        await service.runToolPlayground(
          TOOL_ID,
          {},
          {
            orgId: ORG_ID,
            userId: "user_1",
          }
        )
      ).toEqual({ ok: true, result: { version: "reloaded" } });

      expect(await pending).toEqual({
        error: "Tool configuration changed. Retry the request.",
        errorCode: "CANCELLED",
      });
      expect(runtime.__atlasRetryReloadProbe.attempts).toBe(1);
      expect((await loadJavascriptTool(record))?.retryPolicy).toEqual({
        maxRetries: 0,
      });
    } finally {
      delete runtime.__atlasRetryReloadProbe;
    }
  });

  test("does not invalidate session guards when JavaScript reload fails", async () => {
    const toolsDir = getCustomToolsDir();
    await mkdir(toolsDir, { recursive: true });
    const modulePath = path.join(toolsDir, MODULE_FILENAME);
    await writeFile(
      modulePath,
      "export async function run() { return { ok: true }; }\n",
      "utf8"
    );

    const db = createInMemoryDatabaseAdapter();
    await seedTool(db);
    const service = new AgentService(null, null, db);
    const guard = captureSessionToolGuard(service);
    await createResolvedSession(service, guard);

    await writeFile(modulePath, "export const broken = ;\n", "utf8");
    const result = await service.runToolPlayground(
      TOOL_ID,
      {},
      {
        orgId: ORG_ID,
        userId: "user_1",
      }
    );

    expect(result.ok).toBe(false);
    await expect(guard.read()?.()).resolves.toBeUndefined();
  });
});
