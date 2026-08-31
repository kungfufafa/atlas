import { describe, expect, test } from "bun:test";
import { AtlasApiError } from "@atlas/core";
import {
  createInMemoryDatabaseAdapter,
  ensureBuiltinToolDefinitions,
} from "@atlas/db";
import {
  ProfileChangeHistoryService,
  soulFieldFromFileName,
  soulFieldFromKey,
} from "./profile-change-history";

const ORG_ID = "org_profile_history";
const PROFILE_ID = "profile_history";

async function createService() {
  const db = createInMemoryDatabaseAdapter();
  const now = new Date().toISOString();
  await db.upsertOrganization({
    createdAt: now,
    id: ORG_ID,
    name: "History workspace",
    slug: "history-workspace",
    updatedAt: now,
  });
  await db.upsertProfile({
    createdAt: now,
    id: PROFILE_ID,
    isDefault: false,
    isSuper: false,
    model: null,
    name: "History profile",
    orgId: ORG_ID,
    systemPrompt: "before",
    updatedAt: now,
  });
  return { db, service: new ProfileChangeHistoryService(db) };
}

describe("ProfileChangeHistoryService", () => {
  test("records append-only field and assignment changes", async () => {
    const { db, service } = await createService();
    await ensureBuiltinToolDefinitions(db);
    const tool = (await db.listToolsForOrg(ORG_ID))[0];
    expect(tool).toBeDefined();

    await service.record({
      actorUserId: " user_admin ",
      afterValue: "after",
      beforeValue: "before",
      field: "system_prompt",
      orgId: ORG_ID,
      profileId: PROFILE_ID,
      source: "dashboard",
    });
    await service.withAssignmentChange(
      {
        field: "tools",
        meta: { actorUserId: "user_admin", source: "dashboard" },
        orgId: ORG_ID,
        profileId: PROFILE_ID,
      },
      () => db.assignToolToProfile(PROFILE_ID, tool!.id)
    );

    const first = await service.list(ORG_ID, PROFILE_ID);
    expect(first.events).toHaveLength(2);
    expect(
      first.events.find((event) => event.field === "system_prompt")
    ).toMatchObject({
      actorUserId: "user_admin",
      afterValue: "after",
      beforeValue: "before",
      source: "dashboard",
    });
    expect(
      first.events.find((event) => event.field === "tools")?.afterValue
    ).toContain(tool!.id);

    const firstIds = first.events.map((event) => event.id).sort();
    const second = await service.list(ORG_ID, PROFILE_ID);
    expect(second.events.map((event) => event.id).sort()).toEqual(firstIds);
  });

  test("skips unchanged values and rejects cross-workspace reads", async () => {
    const { service } = await createService();
    await service.record({
      afterValue: "same",
      beforeValue: "same",
      field: "system_prompt",
      orgId: ORG_ID,
      profileId: PROFILE_ID,
      source: "dashboard",
    });
    expect((await service.list(ORG_ID, PROFILE_ID)).events).toHaveLength(0);

    try {
      await service.list("org_other", PROFILE_ID);
      throw new Error("Expected a cross-workspace read to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(AtlasApiError);
      expect((error as AtlasApiError).status).toBe(404);
    }
  });

  test("does not fail a committed assignment when the ledger write fails", async () => {
    const { db, service } = await createService();
    await ensureBuiltinToolDefinitions(db);
    const tool = (await db.listToolsForOrg(ORG_ID))[0];
    expect(tool).toBeDefined();
    db.createProfileChangeEvent = async () => {
      throw new Error("ledger unavailable");
    };

    const outcome = await service.recordBestEffort({
      afterValue: "after",
      beforeValue: "before",
      field: "system_prompt",
      orgId: ORG_ID,
      profileId: PROFILE_ID,
      source: "dashboard",
    });
    expect(outcome).toEqual({ status: "failed" });

    await expect(
      service.withAssignmentChange(
        {
          field: "tools",
          meta: { actorUserId: "user_admin", source: "super_bot" },
          orgId: ORG_ID,
          profileId: PROFILE_ID,
        },
        () => db.assignToolToProfile(PROFILE_ID, tool!.id)
      )
    ).resolves.toBeUndefined();
    expect((await db.listToolsForProfile(PROFILE_ID))[0]?.id).toBe(tool!.id);
  });

  test("records assignment cascades for every affected workspace profile", async () => {
    const { db, service } = await createService();
    const now = new Date().toISOString();
    const secondProfileId = "profile_history_second";
    await db.upsertProfile({
      createdAt: now,
      id: secondProfileId,
      isDefault: false,
      isSuper: false,
      model: null,
      name: "Second history profile",
      orgId: ORG_ID,
      systemPrompt: "",
      updatedAt: now,
    });
    await db.upsertTool({
      createdAt: now,
      description: "Disposable tool",
      handlerConfig: {},
      handlerType: "builtin",
      id: "tool_disposable",
      name: "disposable_tool",
      orgId: ORG_ID,
      updatedAt: now,
    });
    await db.upsertSkill({
      createdAt: now,
      createdBy: "human",
      description: "Disposable skill",
      disableModelInvocation: false,
      enabled: true,
      hasTool: false,
      id: "skill_disposable",
      name: "disposable-skill",
      orgId: ORG_ID,
      sourcePath: "/tmp/disposable-skill",
      updatedAt: now,
    });
    await db.upsertMcpServer({
      cachedTools: [],
      config: {},
      createdAt: now,
      enabled: true,
      id: "mcp_disposable",
      lastError: null,
      name: "Disposable MCP",
      orgId: ORG_ID,
      status: "disconnected",
      transport: "stdio",
      updatedAt: now,
    });

    for (const profileId of [PROFILE_ID, secondProfileId]) {
      await db.assignToolToProfile(profileId, "tool_disposable");
      await db.assignSkillToProfile(profileId, "skill_disposable");
      await db.assignMcpServerToProfile(profileId, "mcp_disposable");
    }

    const meta = { actorUserId: "user_admin", source: "dashboard" } as const;
    await service.withOrgAssignmentChanges(
      { field: "tools", meta, orgId: ORG_ID },
      () => db.deleteTool("tool_disposable")
    );
    await service.withOrgAssignmentChanges(
      { field: "skills", meta, orgId: ORG_ID },
      () => db.deleteSkill("skill_disposable")
    );
    await service.withOrgAssignmentChanges(
      { field: "mcp", meta, orgId: ORG_ID },
      () => db.deleteMcpServer("mcp_disposable")
    );

    const events = (await service.list(ORG_ID, PROFILE_ID)).events;
    expect(events.map((event) => event.field).sort()).toEqual([
      "mcp",
      "skills",
      "tools",
    ]);
    expect(
      events.every(
        (event) =>
          event.actorUserId === "user_admin" && event.source === "dashboard"
      )
    ).toBe(true);
    expect((await service.list(ORG_ID, secondProfileId)).events).toHaveLength(
      3
    );
  });

  test("serializes concurrent assignment snapshots for one profile", async () => {
    const { db, service } = await createService();
    const now = new Date().toISOString();
    for (const [id, name] of [
      ["tool_history_first", "history_first"],
      ["tool_history_second", "history_second"],
    ] as const) {
      await db.upsertTool({
        createdAt: now,
        description: name,
        handlerConfig: {},
        handlerType: "builtin",
        id,
        name,
        orgId: ORG_ID,
        updatedAt: now,
      });
    }

    let releaseFirstMutation: (() => void) | undefined;
    let signalFirstMutation: (() => void) | undefined;
    const firstMutationStarted = new Promise<void>((resolve) => {
      signalFirstMutation = resolve;
    });
    const firstMutationGate = new Promise<void>((resolve) => {
      releaseFirstMutation = resolve;
    });
    const changeInput = {
      field: "tools",
      meta: { actorUserId: "user_admin", source: "dashboard" },
      orgId: ORG_ID,
      profileId: PROFILE_ID,
    } as const;

    const first = service.withAssignmentChange(changeInput, async () => {
      signalFirstMutation?.();
      await firstMutationGate;
      await db.assignToolToProfile(PROFILE_ID, "tool_history_first");
    });
    await firstMutationStarted;

    let secondMutationStarted = false;
    const second = service.withAssignmentChange(changeInput, async () => {
      secondMutationStarted = true;
      await db.assignToolToProfile(PROFILE_ID, "tool_history_second");
    });
    await Promise.resolve();
    expect(secondMutationStarted).toBe(false);

    releaseFirstMutation?.();
    await Promise.all([first, second]);

    const transitions = (await service.list(ORG_ID, PROFILE_ID)).events.map(
      (event) => ({
        afterValue: event.afterValue,
        beforeValue: event.beforeValue,
      })
    );
    expect(transitions).toContainEqual({
      afterValue: '["tool_history_first"]',
      beforeValue: "[]",
    });
    expect(transitions).toContainEqual({
      afterValue: '["tool_history_first","tool_history_second"]',
      beforeValue: '["tool_history_first"]',
    });
  });

  test("maps only writable soul files to ledger fields", () => {
    expect(soulFieldFromKey("memory")).toBe("soul.memory");
    expect(soulFieldFromFileName("SOUL.md")).toBe("soul.soul");
    expect(soulFieldFromFileName("EXAMPLES.md")).toBeNull();
    expect(soulFieldFromKey("unknown")).toBeNull();
  });
});
