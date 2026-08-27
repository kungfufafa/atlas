import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { runWithUserConfigDir } from "@atlas/core";
import {
  createInMemoryDatabaseAdapter,
  type StoredProfileRecord,
} from "@atlas/db";
import {
  setChatgptRuntimeForTests,
  setClaudeRuntimeForTests,
} from "../providers/subscription";
import { ChatgptSubscriptionRuntime } from "../providers/subscription/chatgpt/runtime";
import {
  readSubscriptionSession,
  writeSubscriptionSession,
} from "../providers/subscription/session-store";
import { AgentService } from "./agent-service";

const ORG_ID = "org_subscription_delete";

class ToggleDeletionRuntime extends ChatgptSubscriptionRuntime {
  shouldFail = true;

  override async deleteConversationSession(): Promise<void> {
    if (this.shouldFail) {
      throw new Error("temporary native deletion failure");
    }
  }
}

function createDefaultProfile(): StoredProfileRecord {
  const now = new Date().toISOString();
  return {
    createdAt: now,
    id: "profile_subscription_delete",
    isDefault: true,
    isSuper: false,
    model: null,
    name: "Default",
    orgId: ORG_ID,
    systemPrompt: "You are helpful.",
    updatedAt: now,
  };
}

describe("AgentService subscription session deletion", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    setChatgptRuntimeForTests(null);
    setClaudeRuntimeForTests(null);
    for (const directory of temporaryDirectories) {
      await rm(directory, { force: true, recursive: true });
    }
    temporaryDirectories.length = 0;
  });

  test("keeps the Atlas session when native deletion fails", async () => {
    const directory = await mkdtemp("/tmp/atlas-agent-native-delete-");
    temporaryDirectories.push(directory);
    const database = createInMemoryDatabaseAdapter();
    await database.upsertProfile(createDefaultProfile());
    const service = new AgentService(null, null, database);
    const sessionId = await service.createSession(
      ORG_ID,
      "web",
      "profile_subscription_delete"
    );
    const runtime = new ToggleDeletionRuntime();
    setChatgptRuntimeForTests(runtime);

    await runWithUserConfigDir(directory, async () => {
      await writeSubscriptionSession("chatgpt", sessionId, {
        lastMessageCount: 1,
        runtimeSessionId: "codex-thread",
      });

      await expect(service.deleteSession(ORG_ID, sessionId)).rejects.toThrow(
        "Could not delete every native subscription session"
      );
      expect(await database.getSession(sessionId)).not.toBeNull();
      expect(await readSubscriptionSession("chatgpt", sessionId)).toMatchObject(
        { runtimeSessionId: "codex-thread" }
      );

      runtime.shouldFail = false;
      await expect(service.deleteSession(ORG_ID, sessionId)).resolves.toBe(
        true
      );
      expect(await database.getSession(sessionId)).toBeNull();
      expect(await readSubscriptionSession("chatgpt", sessionId)).toBeNull();
    });
  });

  test("keeps messages when clearing the native session fails", async () => {
    const directory = await mkdtemp("/tmp/atlas-agent-native-delete-");
    temporaryDirectories.push(directory);
    const database = createInMemoryDatabaseAdapter();
    await database.upsertProfile(createDefaultProfile());
    const service = new AgentService(null, null, database);
    const sessionId = await service.createSession(
      ORG_ID,
      "web",
      "profile_subscription_delete"
    );
    await database.replaceMessagesForSession(sessionId, [
      {
        createdAt: new Date().toISOString(),
        id: "message-1",
        payload: {
          content: "Keep me until native deletion succeeds",
          role: "user",
        },
        seq: 0,
        sessionId,
      },
    ]);
    const runtime = new ToggleDeletionRuntime();
    setChatgptRuntimeForTests(runtime);

    await runWithUserConfigDir(directory, async () => {
      await writeSubscriptionSession("chatgpt", sessionId, {
        lastMessageCount: 1,
        runtimeSessionId: "codex-thread",
      });

      await expect(service.clearSession(ORG_ID, sessionId)).rejects.toThrow(
        "Could not delete every native subscription session"
      );
      expect(await database.listMessagesForSession(sessionId)).toHaveLength(1);

      runtime.shouldFail = false;
      await expect(service.clearSession(ORG_ID, sessionId)).resolves.toBe(true);
      expect(await database.listMessagesForSession(sessionId)).toEqual([]);
    });
  });
});
