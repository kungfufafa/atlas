import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { LOCAL_CLIENT_USER_ID } from "@atlas/core";
import { createSqliteDatabase, type DatabaseAdapter } from "@atlas/db";
import { AgentService, type SessionActor } from "./agent-service";
import {
  createPublicationAuthorizer,
  createSessionPublicationAccess,
} from "./artifact-publication-access";
import { ArtifactPublicationStore } from "./artifact-publication-store";

const orgId = "publication-access-org";
const profileId = "publication-access-profile";
const now = "2026-01-01T00:00:00.000Z";
const owner: SessionActor = {
  isPlatformAdmin: false,
  orgRole: "member",
  userId: "owner",
};
const other: SessionActor = { orgRole: "member", userId: "other" };
const admin: SessionActor = { orgRole: "admin", userId: "admin" };
const viewer: SessionActor = { orgRole: "viewer", userId: "viewer" };
const platform: SessionActor = {
  isPlatformAdmin: true,
  orgRole: "admin",
  userId: "platform",
};
const workerActor = (
  channel: "discord" | "telegram" | "whatsapp"
): SessionActor => ({
  isPlatformAdmin: true,
  orgRole: "admin",
  userId: LOCAL_CLIENT_USER_ID,
  workspaceWorkerChannel: channel,
});

async function fixture(
  run: (context: {
    db: DatabaseAdapter;
    raw: Database;
    agent: AgentService;
    access: ReturnType<typeof createSessionPublicationAccess>;
    publish: (sessionId?: string, actor?: SessionActor) => Promise<string>;
    session: (
      id: string,
      userId: string | null,
      channel?: string,
      profile?: string
    ) => Promise<void>;
    store: () => Promise<ArtifactPublicationStore>;
    storeCalls: () => number;
    workspace: string;
  }) => Promise<void>
) {
  const root = await realpath(
    await mkdtemp("/private/tmp/atlas-publication-access-test-")
  );
  const config = join(root, "private");
  const workspace = join(root, "workspace");
  await mkdir(config);
  await mkdir(workspace);
  const sql = await createSqliteDatabase(join(root, "state.sqlite"));
  // SQLite's reconnect proxy ignores ordinary property replacement. This
  // fixture-only overlay controls a barrier while invoking the real DB method.
  const overrides = new Map<PropertyKey, unknown>();
  const db = new Proxy(sql.adapter, {
    get(target, key) {
      return overrides.has(key) ? overrides.get(key) : Reflect.get(target, key);
    },
    set(_target, key, value) {
      overrides.set(key, value);
      return true;
    },
  });
  const raw = new Database(join(root, "state.sqlite"));
  raw.exec("PRAGMA foreign_keys=ON");
  try {
    await db.upsertOrganization({
      createdAt: now,
      id: orgId,
      name: "Org",
      slug: "publication-access",
      updatedAt: now,
    });
    for (const actor of [owner, other, admin, viewer, platform]) {
      await db.createUser({
        createdAt: now,
        email: `${actor.userId}@example.invalid`,
        id: actor.userId,
        isPlatformAdmin: actor.userId === platform.userId,
        passwordHash: "fixture",
        updatedAt: now,
      });
      await db.upsertOrgMember({
        createdAt: now,
        orgId,
        role: actor.userId === platform.userId ? "member" : actor.orgRole!,
        userId: actor.userId,
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
    const session = async (
      id: string,
      userId: string | null,
      channel = "web",
      profile = profileId
    ) => {
      await db.upsertSession({
        agentQuestionnaire: null,
        agentTodos: [],
        channel,
        createdAt: now,
        id,
        modelOverride: null,
        orgId,
        profileId: profile,
        title: null,
        userId,
      });
    };
    await session("owner-session", owner.userId);
    await session("viewer-session", viewer.userId);
    let realStore: ArtifactPublicationStore | undefined;
    let calls = 0;
    const store = async () => {
      realStore ??= await ArtifactPublicationStore.create(config);
      return realStore;
    };
    const agent = new AgentService(null, null, db);
    const access = createSessionPublicationAccess({
      agent,
      db,
      getStore: async () => {
        calls += 1;
        return await store();
      },
    });
    const publish = async (sessionId = "owner-session", actor = owner) => {
      const { scope, service } = await access(orgId, sessionId, actor);
      const execution = await service.beginExecution(
        {
          ...scope,
          executionId: randomUUID(),
          runId: "run",
          toolCallId: "call",
        },
        [workspace]
      );
      await execution.producer.stageBytes({
        bytes: Buffer.from(`private bytes for ${sessionId}`),
        outputOrdinal: 0,
        sourcePath: "artifacts/result.txt",
      });
      const result = await execution.finalize({
        data: { ok: true },
        success: true,
      });
      expect(result.status).toBe("committed");
      expect(result.publications).toHaveLength(1);
      return result.publications[0]!.id;
    };
    await run({
      access,
      agent,
      db,
      publish,
      raw,
      session,
      store,
      storeCalls: () => calls,
      workspace,
    });
  } finally {
    raw.close();
    sql.close();
    await rm(root, { force: true, recursive: true });
  }
}

test("real session ACL permits own member publish/read/list/revoke with private snapshot bytes", async () =>
  fixture(async ({ access, publish }) => {
    const id = await publish();
    const { scope, service } = await access(orgId, "owner-session", owner);
    expect((await service.read(scope, id))?.bytes.toString()).toBe(
      "private bytes for owner-session"
    );
    expect(
      (await service.list(scope, { limit: 10 })).map((item) => item.id)
    ).toEqual([id]);
    expect(await service.revoke(scope, id)).toBe(true);
    expect(await service.read(scope, id)).toBeNull();
  }));

test("revoke admission rejects an own-session viewer before store acquisition while read remains allowed", async () =>
  fixture(async ({ access, storeCalls }) => {
    await expect(
      access(orgId, "viewer-session", viewer, "revoke")
    ).rejects.toThrow();
    expect(storeCalls()).toBe(0);
    await access(orgId, "viewer-session", viewer, "read");
    expect(storeCalls()).toBe(1);
  }));

test("revoke admission uses the worker owner's current role before store acquisition", async () =>
  fixture(async ({ access, session, storeCalls }) => {
    await session("worker-viewer-admission", viewer.userId, "discord");
    await expect(
      access(orgId, "worker-viewer-admission", workerActor("discord"), "revoke")
    ).rejects.toThrow();
    expect(storeCalls()).toBe(0);
    await access(
      orgId,
      "worker-viewer-admission",
      workerActor("discord"),
      "read"
    );
    expect(storeCalls()).toBe(1);
  }));

test("own viewer reads remain available while publish and revoke are refused", async () =>
  fixture(async ({ db, access, publish, workspace }) => {
    await db.upsertOrgMember({
      createdAt: now,
      orgId,
      role: "member",
      userId: viewer.userId,
    });
    const id = await publish("viewer-session", viewer);
    await db.upsertOrgMember({
      createdAt: now,
      orgId,
      role: "viewer",
      userId: viewer.userId,
    });
    const { scope, service } = await access(orgId, "viewer-session", {
      ...viewer,
      isPlatformAdmin: true,
      orgRole: "admin",
    });
    expect((await service.read(scope, id))?.bytes.toString()).toBe(
      "private bytes for viewer-session"
    );
    await expect(service.revoke(scope, id)).rejects.toThrow();
    await expect(
      service.beginExecution(
        {
          ...scope,
          executionId: randomUUID(),
          runId: "run",
          toolCallId: "call",
        },
        [workspace]
      )
    ).rejects.toThrow();
    expect(
      (await service.list(scope, { limit: 10 })).map((item) => item.id)
    ).toEqual([id]);
  }));

test("other users cannot touch storage; admin can manage another session but cannot impersonate its publisher", async () =>
  fixture(async ({ access, publish, storeCalls, workspace }) => {
    await expect(access(orgId, "owner-session", other)).rejects.toThrow();
    expect(storeCalls()).toBe(0);
    const id = await publish();
    const { scope, service } = await access(orgId, "owner-session", admin);
    expect((await service.read(scope, id))?.publication.id).toBe(id);
    await expect(
      service.beginExecution(
        {
          ...scope,
          executionId: randomUUID(),
          runId: "run",
          toolCallId: "call",
        },
        [workspace]
      )
    ).rejects.toThrow();
    expect(await service.revoke(scope, id)).toBe(true);
  }));

test("removed membership denies stale supplied roles before private store acquisition", async () =>
  fixture(async ({ db, access, storeCalls }) => {
    await db.deleteOrgMember(orgId, owner.userId);
    await expect(
      access(orgId, "owner-session", {
        ...owner,
        isPlatformAdmin: true,
        orgRole: "admin",
      })
    ).rejects.toThrow();
    expect(storeCalls()).toBe(0);
  }));

test("live platform-admin demotion invalidates a previously authorized service and fresh access", async () =>
  fixture(async ({ raw, access, publish, store, storeCalls }) => {
    const id = await publish();
    const { scope, service } = await access(orgId, "owner-session", platform);
    expect((await service.read(scope, id))?.publication.id).toBe(id);
    raw
      .query("UPDATE users SET is_platform_admin=0 WHERE id=?")
      .run(platform.userId);
    const storage = await store();
    const original = storage.read.bind(storage);
    let reads = 0;
    storage.read = async (record) => {
      reads += 1;
      return await original(record);
    };
    const before = storeCalls();
    await expect(service.read(scope, id)).rejects.toThrow();
    await expect(access(orgId, "owner-session", platform)).rejects.toThrow();
    expect(reads).toBe(0);
    expect(storeCalls()).toBe(before);
  }));

test("super-agent profile access requires live administrator authority and always excludes worker transport", async () =>
  fixture(async ({ raw, access, session, storeCalls }) => {
    raw.query("UPDATE profiles SET is_super=1 WHERE id=?").run(profileId);
    await session("worker-super", admin.userId, "discord");
    await expect(access(orgId, "owner-session", owner)).rejects.toThrow();
    await expect(
      access(orgId, "worker-super", workerActor("discord"))
    ).rejects.toThrow();
    expect(storeCalls()).toBe(0);
    expect((await access(orgId, "owner-session", admin)).scope.sessionId).toBe(
      "owner-session"
    );
    expect(
      (await access(orgId, "owner-session", platform)).scope.sessionId
    ).toBe("owner-session");
  }));

test("trusted worker channel survives the real ACL and mismatched or absent channels cannot read", async () =>
  fixture(async ({ access, publish, session, storeCalls }) => {
    for (const channel of ["discord", "telegram", "whatsapp"] as const) {
      const sessionId = `worker-${channel}`;
      await session(sessionId, owner.userId, channel);
      const id = await publish(sessionId);
      const { scope, service } = await access(
        orgId,
        sessionId,
        workerActor(channel)
      );
      expect(scope.actorId).toBe(LOCAL_CLIENT_USER_ID);
      expect((await service.read(scope, id))?.bytes.toString()).toBe(
        `private bytes for ${sessionId}`
      );
      const before = storeCalls();
      await expect(
        access(
          orgId,
          sessionId,
          workerActor(channel === "discord" ? "telegram" : "discord")
        )
      ).rejects.toThrow();
      await expect(
        access(orgId, sessionId, {
          orgRole: "admin",
          userId: LOCAL_CLIENT_USER_ID,
        })
      ).rejects.toThrow();
      expect(storeCalls()).toBe(before);
    }
  }));

test("worker permissions follow canonical owner viewer demotion rather than supplied worker admin flags", async () =>
  fixture(async ({ db, access, publish, session, workspace }) => {
    await session("worker-viewer", owner.userId, "discord");
    const id = await publish("worker-viewer");
    await db.upsertOrgMember({
      createdAt: now,
      orgId,
      role: "viewer",
      userId: owner.userId,
    });
    const { scope, service } = await access(
      orgId,
      "worker-viewer",
      workerActor("discord")
    );
    expect((await service.read(scope, id))?.publication.id).toBe(id);
    await expect(service.revoke(scope, id)).rejects.toThrow();
    await expect(
      service.beginExecution(
        {
          ...scope,
          executionId: randomUUID(),
          runId: "run",
          toolCallId: "call",
        },
        [workspace]
      )
    ).rejects.toThrow();
  }));

test("worker canonical owner membership and user existence are checked afresh", async () =>
  fixture(async ({ db, raw, access, session, storeCalls }) => {
    await session("worker-owner", owner.userId, "telegram");
    await db.deleteOrgMember(orgId, owner.userId);
    await expect(
      access(orgId, "worker-owner", workerActor("telegram"))
    ).rejects.toThrow();
    await db.upsertOrgMember({
      createdAt: now,
      orgId,
      role: "member",
      userId: owner.userId,
    });
    raw.query("DELETE FROM users WHERE id=?").run(owner.userId);
    expect(await db.getUserById(owner.userId)).toBeNull();
    await expect(
      access(orgId, "worker-owner", workerActor("telegram"))
    ).rejects.toThrow();
    expect(storeCalls()).toBe(0);
  }));

test("worker sessions without a human canonical owner or on web cannot obtain private storage", async () =>
  fixture(async ({ db, access, session, storeCalls }) => {
    await db.createUser({
      createdAt: now,
      email: "service@example.invalid",
      id: LOCAL_CLIENT_USER_ID,
      passwordHash: "fixture",
      updatedAt: now,
    });
    await db.upsertOrgMember({
      createdAt: now,
      orgId,
      role: "admin",
      userId: LOCAL_CLIENT_USER_ID,
    });
    await session("no-owner", null, "discord");
    await session("service-owner", LOCAL_CLIENT_USER_ID, "discord");
    for (const id of ["no-owner", "service-owner", "owner-session"]) {
      await expect(access(orgId, id, workerActor("discord"))).rejects.toThrow();
    }
    expect(storeCalls()).toBe(0);
  }));

test("wrong actor or tenant scope is refused by the authorizer with real session ACL", async () =>
  fixture(async ({ db, agent }) => {
    const authorize = createPublicationAuthorizer(db, agent, owner);
    for (const patch of [
      { actorId: other.userId },
      { orgId: "foreign-org" },
      { profileId: "foreign-profile" },
      { sessionId: "missing" },
    ]) {
      await expect(
        authorize(
          {
            actorId: owner.userId,
            orgId,
            profileId,
            sessionId: "owner-session",
            ...patch,
          },
          "read"
        )
      ).rejects.toThrow();
    }
  }));

test("archived organization denies access before private store acquisition", async () =>
  fixture(async ({ raw, access, storeCalls }) => {
    raw
      .query("UPDATE organizations SET archived_at=? WHERE id=?")
      .run(now, orgId);
    await expect(access(orgId, "owner-session", owner)).rejects.toThrow();
    expect(storeCalls()).toBe(0);
  }));

test("importing/missing profile and deleted session deny access before storage", async () =>
  fixture(async ({ raw, db, access, storeCalls }) => {
    raw.query("UPDATE profiles SET is_importing=1 WHERE id=?").run(profileId);
    await expect(access(orgId, "owner-session", owner)).rejects.toThrow();
    raw.query("UPDATE profiles SET is_importing=0 WHERE id=?").run(profileId);
    await db.deleteSession("owner-session");
    await expect(access(orgId, "owner-session", owner)).rejects.toThrow();
    raw.query("DELETE FROM profiles WHERE id=?").run(profileId);
    await expect(access(orgId, "viewer-session", viewer)).rejects.toThrow();
    expect(storeCalls()).toBe(0);
  }));

test("membership revocation during the actual private read prevents returning captured bytes", async () =>
  fixture(async ({ db, access, publish, store }) => {
    const id = await publish();
    const { scope, service } = await access(orgId, "owner-session", owner);
    const storage = await store();
    const original = storage.read.bind(storage);
    let reads = 0;
    storage.read = async (record) => {
      const bytes = await original(record);
      reads += 1;
      await db.deleteOrgMember(orgId, owner.userId);
      return bytes;
    };
    await expect(service.read(scope, id)).rejects.toThrow();
    expect(reads).toBe(1);
  }));

test("membership revocation after DB listing prevents returning publication metadata", async () =>
  fixture(async ({ db, access, publish, store }) => {
    await publish();
    const { scope, service } = await access(orgId, "owner-session", owner);
    const original = db.listArtifactPublications.bind(db);
    let lists = 0;
    db.listArtifactPublications = async (selection, options) => {
      const records = await original(selection, options);
      lists += 1;
      await db.deleteOrgMember(orgId, owner.userId);
      return records;
    };
    const storage = await store();
    let reads = 0;
    const originalRead = storage.read.bind(storage);
    storage.read = async (record) => {
      reads += 1;
      return await originalRead(record);
    };
    await expect(service.list(scope, { limit: 10 })).rejects.toThrow();
    expect(lists).toBe(1);
    expect(reads).toBe(0);
  }));
