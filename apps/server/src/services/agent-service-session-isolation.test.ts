import { describe, expect, test } from "bun:test";
import { createInMemoryDatabaseAdapter } from "@atlas/db";
import { setupTestConfigDir } from "../test-config-dir";
import { AgentService } from "./agent-service";

setupTestConfigDir("atlas-session-alias-isolation-");

describe("AgentService default profile aliases", () => {
  test.each(["default", "", " "])(
    "lists only the current organization's resolved profile for alias %j",
    async (alias) => {
      const db = createInMemoryDatabaseAdapter();
      const now = new Date().toISOString();
      for (const orgId of ["org_a", "org_b"]) {
        await db.upsertOrganization({
          createdAt: now,
          id: orgId,
          name: orgId,
          slug: orgId,
          updatedAt: now,
        });
        await db.upsertProfile({
          createdAt: now,
          id: `${orgId}_default`,
          isDefault: true,
          isSuper: false,
          model: null,
          name: "Default",
          orgId,
          systemPrompt: "",
          updatedAt: now,
        });
        await db.createUser({
          createdAt: now,
          email: `${orgId}@example.com`,
          id: `${orgId}_admin`,
          passwordHash: "unused",
          updatedAt: now,
        });
        await db.upsertOrgMember({
          createdAt: now,
          orgId,
          role: "admin",
          userId: `${orgId}_admin`,
        });
      }
      await db.upsertProfile({
        createdAt: now,
        id: "default",
        isDefault: false,
        isSuper: false,
        model: null,
        name: "Legacy literal profile ID",
        orgId: "org_a",
        systemPrompt: "",
        updatedAt: now,
      });
      await db.upsertSession({
        agentQuestionnaire: null,
        agentTodos: [],
        channel: "web",
        createdAt: now,
        id: "foreign_legacy_session",
        modelOverride: null,
        orgId: "org_a",
        profileId: "default",
        title: "Private legacy conversation",
        userId: "org_a_admin",
      });
      await db.replaceMessagesForSession("foreign_legacy_session", [
        {
          createdAt: now,
          id: "foreign_message",
          payload: { content: "Private org A data", role: "user" },
          seq: 0,
          sessionId: "foreign_legacy_session",
        },
      ]);

      const service = new AgentService(null, null, db);
      const ownSessionId = await service.createSession(
        "org_b",
        "web",
        "org_b_default",
        "org_b_admin",
        { orgRole: "admin" }
      );
      await db.replaceMessagesForSession(ownSessionId, [
        {
          createdAt: now,
          id: "own_message",
          payload: { content: "Own org B data", role: "user" },
          seq: 0,
          sessionId: ownSessionId,
        },
      ]);
      const listing = await service.listSessions("org_b", alias, "web", {
        userId: "org_b_admin",
      });
      expect(listing.sessions.map((session) => session.id)).toEqual([
        ownSessionId,
      ]);
      expect(listing.sessions[0]?.profileId).toBe("org_b_default");
    }
  );
});
