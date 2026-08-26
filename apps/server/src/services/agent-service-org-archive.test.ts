import { describe, expect, test } from "bun:test";
import type { AgentChatSession, AgentHarness } from "@atlas/agent";
import type { ChatMessage } from "@atlas/core";
import { getProfileSoulDir, pathExists } from "@atlas/core";
import { createInMemoryDatabaseAdapter } from "@atlas/db";
import { setupTestConfigDir } from "../test-config-dir";
import { AgentService } from "./agent-service";
import { sessionTurnRegistry } from "./session-turn-registry";

setupTestConfigDir("atlas-agent-org-archive-");

describe("AgentService archived organization startup", () => {
  test("scaffolds soul files only for active workspaces", async () => {
    const db = createInMemoryDatabaseAdapter();
    const now = new Date().toISOString();

    await db.upsertOrganization({
      createdAt: now,
      id: "org_active",
      name: "Active",
      slug: "active",
      updatedAt: now,
    });
    await db.upsertOrganization({
      archivedAt: now,
      createdAt: now,
      id: "org_archived",
      name: "Archived",
      slug: "archived",
      updatedAt: now,
    });
    for (const orgId of ["org_active", "org_archived"]) {
      await db.upsertProfile({
        createdAt: now,
        id: `profile_${orgId}`,
        isSuper: false,
        model: null,
        name: orgId,
        orgId,
        systemPrompt: "",
        updatedAt: now,
      });
    }

    const service = new AgentService(null, null, db);
    await service.ensureSoulScaffolded();

    expect(
      await pathExists(getProfileSoulDir("org_active", "profile_org_active"))
    ).toBe(true);
    expect(
      await pathExists(
        getProfileSoulDir("org_archived", "profile_org_archived")
      )
    ).toBe(false);
  });

  test("invalidating an archived workspace aborts its active turns", async () => {
    const db = createInMemoryDatabaseAdapter();
    const now = new Date().toISOString();
    await db.upsertOrganization({
      createdAt: now,
      id: "org_active_turn",
      name: "Active turn",
      slug: "active-turn",
      updatedAt: now,
    });
    await db.upsertProfile({
      createdAt: now,
      id: "profile_active_turn",
      isDefault: true,
      isSuper: false,
      model: null,
      name: "Active turn",
      orgId: "org_active_turn",
      systemPrompt: "",
      updatedAt: now,
    });
    const service = new AgentService(null, null, db);
    const sessionId = await service.createSession(
      "org_active_turn",
      "web",
      "profile_active_turn"
    );
    const abort = new AbortController();

    expect(await service.beginSessionTurn("org_active_turn", sessionId)).toBe(
      true
    );
    sessionTurnRegistry.attachAbort(sessionId, abort);

    service.invalidateSessionsForOrg("org_active_turn");

    expect(abort.signal.aborted).toBe(true);
    expect(sessionTurnRegistry.isActive(sessionId)).toBe(false);
  });

  test("revalidates workspace activity after generation and before transcript persistence", async () => {
    const db = createInMemoryDatabaseAdapter();
    const now = new Date().toISOString();
    const organization = {
      createdAt: now,
      id: "org_persist_race",
      name: "Persist race",
      slug: "persist-race",
      updatedAt: now,
    };
    await db.upsertOrganization(organization);
    await db.upsertProfile({
      createdAt: now,
      id: "profile_persist_race",
      isDefault: true,
      isSuper: false,
      model: null,
      name: "Persist race",
      orgId: organization.id,
      systemPrompt: "",
      updatedAt: now,
    });
    const service = new AgentService(null, null, db);
    const history: ChatMessage[] = [];
    const generatedSession = {
      clear() {
        history.length = 0;
      },
      compact: async () => ({
        action: "none" as const,
        messagesAfter: history.length,
        messagesBefore: history.length,
      }),
      createAutomation: async () => {
        throw new Error("not used");
      },
      getContextUsage: () => null,
      getHistory: () => history,
      getHistoryRevision: () => 0,
      async send(input: string | { message: string }) {
        const message = typeof input === "string" ? input : input.message;
        history.push(
          { content: message, role: "user" },
          { content: "generated", role: "assistant" }
        );
        return "generated";
      },
      async sendStream() {
        return "generated";
      },
    } satisfies AgentChatSession;
    (
      service as unknown as {
        createHarnessForProfile: () => AgentHarness;
      }
    ).createHarnessForProfile = () => ({
      createAutomationFromPrompt: async () => {
        throw new Error("not used");
      },
      createChatSession: () => generatedSession,
    });
    const sessionId = await service.createSession(
      organization.id,
      "web",
      "profile_persist_race"
    );
    const session = await service.resolveSession(organization.id, sessionId);
    await db.upsertOrganization({
      ...organization,
      archivedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await expect(session?.send("hello")).rejects.toThrow(
      "Organization not found."
    );
    expect(await db.listMessagesForSession(sessionId)).toEqual([]);
  });

  test("does not register a turn when the workspace archives during session lookup", async () => {
    const db = createInMemoryDatabaseAdapter();
    const now = new Date().toISOString();
    const organization = {
      createdAt: now,
      id: "org_begin_race",
      name: "Begin race",
      slug: "begin-race",
      updatedAt: now,
    };
    await db.upsertOrganization(organization);
    await db.upsertProfile({
      createdAt: now,
      id: "profile_begin_race",
      isDefault: true,
      isSuper: false,
      model: null,
      name: "Begin race",
      orgId: organization.id,
      systemPrompt: "",
      updatedAt: now,
    });
    const service = new AgentService(null, null, db);
    const sessionId = await service.createSession(
      organization.id,
      "web",
      "profile_begin_race"
    );
    const getSession = db.getSession.bind(db);
    let releaseLookup: (() => void) | undefined;
    let markLookupStarted: (() => void) | undefined;
    const lookupStarted = new Promise<void>((resolve) => {
      markLookupStarted = resolve;
    });
    const lookupGate = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    db.getSession = async (id) => {
      const record = await getSession(id);
      markLookupStarted?.();
      await lookupGate;
      return record;
    };

    const pending = service.beginSessionTurn(organization.id, sessionId);
    await lookupStarted;
    await db.upsertOrganization({
      ...organization,
      archivedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    service.invalidateSessionsForOrg(organization.id);
    releaseLookup?.();

    await expect(pending).rejects.toThrow("Organization not found.");
    expect(sessionTurnRegistry.isActive(sessionId)).toBe(false);
  });

  test("invalidates in-flight sessions when workspace AI config changes", async () => {
    const db = createInMemoryDatabaseAdapter();
    const now = new Date().toISOString();
    await db.upsertOrganization({
      createdAt: now,
      id: "org_config_change",
      name: "Config change",
      slug: "config-change",
      updatedAt: now,
    });
    await db.upsertProfile({
      createdAt: now,
      id: "profile_config_change",
      isDefault: true,
      isSuper: false,
      model: null,
      name: "Config change",
      orgId: "org_config_change",
      systemPrompt: "",
      updatedAt: now,
    });
    const service = new AgentService(null, null, db);
    const sessionId = await service.createSession(
      "org_config_change",
      "web",
      "profile_config_change"
    );
    const abort = new AbortController();
    expect(await service.beginSessionTurn("org_config_change", sessionId)).toBe(
      true
    );
    sessionTurnRegistry.attachAbort(sessionId, abort);

    await service.setOrgTimezone("org_config_change", "Asia/Jakarta");

    expect(abort.signal.aborted).toBe(true);
    expect(sessionTurnRegistry.isActive(sessionId)).toBe(false);
  });
});
