import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { LOCAL_CLIENT_USER_ID, type ToolContext } from "@atlas/core";
import { createSqliteDatabase, type DatabaseAdapter } from "@atlas/db";
import { AgentService, type SessionActor } from "./agent-service";
import { createPublicationTurnPrincipal } from "./publication-turn-principal";

const orgId = "principal-org";
const profileId = "principal-profile";
const sessionId = "principal-session";
const now = "2026-01-01T00:00:00.000Z";
const owner: SessionActor = { orgRole: "member", userId: "owner" };
const worker: SessionActor = {
  isPlatformAdmin: true,
  orgRole: "admin",
  userId: LOCAL_CLIENT_USER_ID,
  workspaceWorkerChannel: "discord",
};
const context: ToolContext = {
  orgId,
  profileId,
  sessionId,
  userId: owner.userId,
};

async function fixture(
  run: (fixture: {
    agent: AgentService;
    db: DatabaseAdapter;
    session(userId: string | null, channel?: string): Promise<void>;
    principal(
      actor?: SessionActor
    ): ReturnType<typeof createPublicationTurnPrincipal>;
  }) => Promise<void>
): Promise<void> {
  const root = await mkdtemp("/private/tmp/atlas-turn-principal-test-");
  const sql = await createSqliteDatabase(join(root, "state.sqlite"));
  const db = sql.adapter;
  try {
    await db.upsertOrganization({
      createdAt: now,
      id: orgId,
      name: "Org",
      slug: orgId,
      updatedAt: now,
    });
    for (const userId of ["owner", "other", "admin", "viewer"]) {
      await db.createUser({
        createdAt: now,
        email: `${userId}@example.invalid`,
        id: userId,
        isPlatformAdmin: false,
        passwordHash: "fixture",
        updatedAt: now,
      });
      await db.upsertOrgMember({
        createdAt: now,
        orgId,
        role:
          userId === "admin"
            ? "admin"
            : userId === "viewer"
              ? "viewer"
              : "member",
        userId,
      });
    }
    await db.upsertProfile({
      createdAt: now,
      id: profileId,
      isSuper: false,
      model: null,
      name: "Profile",
      orgId,
      systemPrompt: "",
      updatedAt: now,
    });
    const session = async (userId: string | null, channel = "web") => {
      await db.upsertSession({
        agentQuestionnaire: null,
        agentTodos: [],
        channel,
        createdAt: now,
        id: sessionId,
        modelOverride: null,
        orgId,
        profileId,
        title: null,
        userId,
      });
    };
    await session(owner.userId);
    const agent = new AgentService(null, null, db);
    await run({
      agent,
      db,
      principal: (actor = owner) =>
        createPublicationTurnPrincipal({ actor, agent, db, orgId, sessionId }),
      session,
    });
  } finally {
    sql.close();
    await rm(root, { force: true, recursive: true });
  }
}

test("human principal binds actual persisted scope and copies the authenticated actor", () =>
  fixture(async ({ principal }) => {
    const actor = { ...owner };
    const p = await principal(actor);
    actor.userId = "other";
    actor.orgRole = "viewer";
    expect(p.effectUserId).toBe("owner");
    expect(p.invoker.userId).toBe("owner");
    expect(p.scope).toEqual({ actorId: "owner", orgId, profileId, sessionId });
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(p.scope)).toBe(true);
    expect(Object.isFrozen(p.invoker)).toBe(true);
    await p.validateContext(context);
    for (const action of ["publish", "read", "revoke"] as const) {
      await p.authorizePublication(p.scope, action);
    }
  }));

test("worker retains channel proof while effects and publications use persisted human identity", () =>
  fixture(async ({ principal, session }) => {
    await session("owner", "discord");
    const actor = { ...worker };
    const p = await principal(actor);
    actor.workspaceWorkerChannel = "telegram";
    expect(p.effectUserId).toBe("owner");
    expect(p.scope.actorId).toBe("owner");
    expect(p.invoker.userId).toBe(LOCAL_CLIENT_USER_ID);
    expect(p.invoker.workspaceWorkerChannel).toBe("discord");
    await p.validateContext(context);
    await expect(
      p.validateContext({ ...context, userId: LOCAL_CLIENT_USER_ID })
    ).rejects.toThrow();
    await expect(
      p.authorizePublication(
        { ...p.scope, actorId: LOCAL_CLIENT_USER_ID },
        "publish"
      )
    ).rejects.toThrow();
  }));

for (const mismatch of ["orgId", "profileId", "sessionId", "userId"] as const) {
  test(`effect context rejects changed ${mismatch}`, () =>
    fixture(async ({ principal }) => {
      const p = await principal();
      await expect(
        p.validateContext({ ...context, [mismatch]: "foreign" })
      ).rejects.toThrow();
    }));
}
for (const mismatch of [
  "orgId",
  "profileId",
  "sessionId",
  "actorId",
] as const) {
  test(`publication rejects changed ${mismatch}`, () =>
    fixture(async ({ principal }) => {
      const p = await principal();
      await expect(
        p.authorizePublication({ ...p.scope, [mismatch]: "foreign" }, "read")
      ).rejects.toThrow();
    }));
}

for (const actor of [
  { orgRole: "member", userId: "other" },
  { orgRole: "admin", userId: "admin" },
] satisfies SessionActor[]) {
  test(`${actor.userId} cannot publish as the session owner`, () =>
    fixture(async ({ principal }) => {
      await expect(principal(actor)).rejects.toThrow();
    }));
}

test("missing session and null owner fail initial admission", () =>
  fixture(async ({ agent, db, principal, session }) => {
    await expect(
      createPublicationTurnPrincipal({
        actor: owner,
        agent,
        db,
        orgId,
        sessionId: "missing",
      })
    ).rejects.toThrow();
    await expect(
      createPublicationTurnPrincipal({
        actor: owner,
        agent,
        db,
        orgId: "foreign",
        sessionId,
      })
    ).rejects.toThrow();
    // Session upsert preserves an existing owner when given null. Create a new
    // ownerless row instead of mistaking the upsert behavior for an ACL failure.
    await db.deleteSession(sessionId);
    await session(null);
    expect((await db.getSession(sessionId))?.userId).toBeNull();
    await expect(principal()).rejects.toThrow();
  }));

for (const mode of ["human", "worker"] as const) {
  for (const change of ["viewer", "removed", "owner"] as const) {
    test(`${mode} rechecks ${change} before the next actual effect`, () =>
      fixture(async ({ principal, db, session }) => {
        const channel = mode === "worker" ? "discord" : "web";
        await session("owner", channel);
        const p = await principal(mode === "worker" ? worker : owner);
        if (change === "viewer") {
          await db.upsertOrgMember({
            createdAt: now,
            orgId,
            role: "viewer",
            userId: "owner",
          });
        }
        if (change === "removed") {
          await db.deleteOrgMember(orgId, "owner");
        }
        if (change === "owner") {
          await session("other", channel);
        }
        let effects = 0;
        const execute = async () => {
          await p.validateContext(context);
          effects += 1;
        };
        await expect(execute()).rejects.toThrow();
        expect(effects).toBe(0);
        await expect(
          p.authorizePublication(p.scope, "publish")
        ).rejects.toThrow();
      }));
  }

  test(`${mode} rejects owner change during awaited ACL callback`, () =>
    fixture(async ({ agent, session, principal }) => {
      const channel = mode === "worker" ? "discord" : "web";
      await session("owner", channel);
      const p = await principal(mode === "worker" ? worker : owner);
      const original = agent.canAccessSession.bind(agent);
      agent.canAccessSession = async (...args) => {
        const allowed = await original(...args);
        await session("other", channel);
        return allowed;
      };
      let effects = 0;
      const execute = async () => {
        await p.validateContext(context);
        effects += 1;
      };
      await expect(execute()).rejects.toThrow();
      expect(effects).toBe(0);
    }));
}

test("worker must match current external channel and a member owner", () =>
  fixture(async ({ principal, session }) => {
    await expect(principal(worker)).rejects.toThrow();
    await session("owner", "telegram");
    await expect(principal(worker)).rejects.toThrow();
    await session("viewer", "discord");
    await expect(principal(worker)).rejects.toThrow();
    await session("owner", "discord");
    const p = await principal(worker);
    await session("owner", "telegram");
    await expect(p.beforeToolCall()).rejects.toThrow();
  }));
