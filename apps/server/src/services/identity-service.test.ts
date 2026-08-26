import { describe, expect, test } from "bun:test";
import { PrincipalRequiredError } from "@atlas/core";
import { LOCAL_CLIENT_USER_ID } from "@atlas/core/local-auth";
import { createInMemoryDatabaseAdapter } from "@atlas/db";
import { IdentityService } from "./identity-service";

async function seed() {
  const db = createInMemoryDatabaseAdapter();
  const now = new Date().toISOString();
  await db.upsertOrganization({
    createdAt: now,
    id: "org_1",
    name: "Org",
    slug: "org",
    updatedAt: now,
  });
  await db.createUser({
    createdAt: now,
    email: "ada@example.com",
    id: "user_1",
    name: "Ada",
    passwordHash: "x",
    updatedAt: now,
  });
  await db.createUser({
    createdAt: now,
    email: "admin@example.com",
    id: "user_admin",
    name: "Admin",
    passwordHash: "x",
    updatedAt: now,
  });
  await db.upsertOrgMember({
    createdAt: now,
    orgId: "org_1",
    role: "member",
    userId: "user_1",
  });
  await db.upsertOrgMember({
    createdAt: now,
    orgId: "org_1",
    role: "admin",
    userId: "user_admin",
  });
  return db;
}

describe("IdentityService", () => {
  test("binds telegram user to canonical atlas user", async () => {
    const db = await seed();
    const identity = new IdentityService(db);
    const principal = await identity.bindExternalPrincipal({
      channel: "telegram",
      channelUserId: "42",
      orgId: "org_1",
      userId: "user_1",
    });
    expect(principal.userId).toBe("user_1");
    const resolved = await identity.resolve({
      channel: "telegram",
      channelUserId: "42",
      orgId: "org_1",
    });
    expect(resolved.userId).toBe("user_1");
  });

  test("fail closed without mapping", async () => {
    const db = await seed();
    const identity = new IdentityService(db);
    await expect(
      identity.resolve({
        channel: "telegram",
        channelUserId: "99",
        orgId: "org_1",
      })
    ).rejects.toThrow(PrincipalRequiredError);
  });

  test("rejects binding to the service account", async () => {
    const db = await seed();
    const identity = new IdentityService(db);
    await expect(
      identity.bindExternalPrincipal({
        channel: "telegram",
        channelUserId: "42",
        orgId: "org_1",
        userId: LOCAL_CLIENT_USER_ID,
      })
    ).rejects.toThrow(/service account/);
  });

  test("resolveForUser fail closed for missing membership", async () => {
    const db = await seed();
    const identity = new IdentityService(db);
    await expect(identity.resolveForUser("org_1", "missing")).rejects.toThrow(
      PrincipalRequiredError
    );
  });

  test("browser sessions ignore caller-supplied userId", async () => {
    const db = await seed();
    const identity = new IdentityService(db);
    const principal = await identity.bindExternalPrincipal({
      actor: { mode: "browser-session", userId: "user_1" },
      channel: "telegram",
      channelUserId: "42",
      orgId: "org_1",
      userId: "user_admin",
    });
    expect(principal.userId).toBe("user_1");
    expect(principal.orgRole).toBe("member");
  });

  test("worker bindings require a single-use pairing assertion", async () => {
    const db = await seed();
    const identity = new IdentityService(db);
    await expect(
      identity.bindExternalPrincipal({
        actor: { mode: "local-token", userId: LOCAL_CLIENT_USER_ID },
        channel: "telegram",
        channelUserId: "42",
        orgId: "org_1",
        userId: "user_admin",
      })
    ).rejects.toThrow(/pairing assertion/);

    const assertion = await identity.issuePairingAssertion({
      channel: "telegram",
      orgId: "org_1",
      userId: "user_1",
    });
    const principal = await identity.bindExternalPrincipal({
      actor: { mode: "local-token", userId: LOCAL_CLIENT_USER_ID },
      channel: "telegram",
      channelUserId: "42",
      orgId: "org_1",
      pairingAssertion: assertion,
      userId: "user_admin",
    });
    expect(principal.userId).toBe("user_1");
    await expect(
      identity.bindExternalPrincipal({
        actor: { mode: "local-token", userId: LOCAL_CLIENT_USER_ID },
        channel: "telegram",
        channelUserId: "99",
        orgId: "org_1",
        pairingAssertion: assertion,
      })
    ).rejects.toThrow(/already used|invalid/i);
  });

  test("restores a pairing assertion when mapping write fails", async () => {
    const db = await seed();
    const identity = new IdentityService(db);
    const assertion = await identity.issuePairingAssertion({
      channel: "telegram",
      orgId: "org_1",
      userId: "user_1",
    });
    const original = db.upsertChannelOrgMapping.bind(db);
    db.upsertChannelOrgMapping = async () => {
      throw new Error("network down");
    };
    await expect(
      identity.bindExternalPrincipal({
        actor: { mode: "local-token", userId: LOCAL_CLIENT_USER_ID },
        channel: "telegram",
        channelUserId: "42",
        orgId: "org_1",
        pairingAssertion: assertion,
      })
    ).rejects.toThrow(/network down/);
    db.upsertChannelOrgMapping = original;
    const principal = await identity.bindExternalPrincipal({
      actor: { mode: "local-token", userId: LOCAL_CLIENT_USER_ID },
      channel: "telegram",
      channelUserId: "42",
      orgId: "org_1",
      pairingAssertion: assertion,
    });
    expect(principal.userId).toBe("user_1");
  });

  test("channel sessions require external principal", async () => {
    const db = await seed();
    const identity = new IdentityService(db);
    await expect(
      identity.resolveForChannelSession({
        authUserId: LOCAL_CLIENT_USER_ID,
        channel: "telegram",
        isPlatformAdmin: false,
        orgId: "org_1",
        orgRole: "admin",
      })
    ).rejects.toThrow(/external principal/);
  });

  test("worker channel sessions fail closed for unmapped callers", async () => {
    const db = await seed();
    const identity = new IdentityService(db);
    await expect(
      identity.resolveForChannelSession({
        authUserId: LOCAL_CLIENT_USER_ID,
        channel: "whatsapp",
        channelUserId: "154352568283178@lid",
        isPlatformAdmin: false,
        orgId: "org_1",
        orgRole: "member",
      })
    ).rejects.toThrow(/No canonical user mapping/);
    expect(
      await db.getChannelOrgMapping("whatsapp", "154352568283178@lid")
    ).toBeNull();
  });

  test("browser channel sessions still fail closed without a mapping", async () => {
    const db = await seed();
    const identity = new IdentityService(db);
    await expect(
      identity.resolveForChannelSession({
        authUserId: "user_1",
        channel: "whatsapp",
        channelUserId: "154352568283178@lid",
        isPlatformAdmin: false,
        orgId: "org_1",
        orgRole: "member",
      })
    ).rejects.toThrow(/No canonical user mapping/);
  });
});
