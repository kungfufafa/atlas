import { describe, expect, test } from "bun:test";
import { PrincipalRequiredError } from "@atlas/core";
import { LOCAL_CLIENT_USER_ID } from "@atlas/core/local-auth";
import { createInMemoryDatabaseAdapter } from "@atlas/db";
import { ChannelGuestPrincipalService } from "./channel-guest-principal-service";
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

  test("isolates the same channel identity between workspaces", async () => {
    const db = await seed();
    const now = new Date().toISOString();
    await db.upsertOrganization({
      createdAt: now,
      id: "org_2",
      name: "Other Org",
      slug: "other-org",
      updatedAt: now,
    });
    await db.createUser({
      createdAt: now,
      email: "grace@example.com",
      id: "user_2",
      name: "Grace",
      passwordHash: "x",
      updatedAt: now,
    });
    await db.upsertOrgMember({
      createdAt: now,
      orgId: "org_2",
      role: "member",
      userId: "user_2",
    });

    const identity = new IdentityService(db);
    await identity.bindExternalPrincipal({
      channel: "telegram",
      channelUserId: "42",
      orgId: "org_1",
      userId: "user_1",
    });
    await identity.bindExternalPrincipal({
      channel: "telegram",
      channelUserId: "42",
      orgId: "org_2",
      userId: "user_2",
    });

    await expect(
      identity.resolve({
        channel: "telegram",
        channelUserId: "42",
        orgId: "org_1",
      })
    ).resolves.toMatchObject({ orgId: "org_1", userId: "user_1" });
    await expect(
      identity.resolve({
        channel: "telegram",
        channelUserId: "42",
        orgId: "org_2",
      })
    ).resolves.toMatchObject({ orgId: "org_2", userId: "user_2" });

    expect(await db.deleteChannelOrgMapping("org_1", "telegram", "42")).toBe(
      true
    );
    expect(
      await db.getChannelOrgMapping("org_2", "telegram", "42")
    ).toMatchObject({ orgId: "org_2", userId: "user_2" });
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
        expectedUserId: "user_1",
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
      expectedUserId: "user_1",
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
        expectedUserId: "user_1",
        orgId: "org_1",
        pairingAssertion: assertion,
      })
    ).rejects.toThrow(/already used|invalid/i);
  });

  test("worker pairing assertions expire", async () => {
    const db = await seed();
    let now = Date.parse("2026-08-31T00:00:00.000Z");
    const identity = new IdentityService(db, () => now);
    const assertion = await identity.issuePairingAssertion({
      channel: "whatsapp",
      orgId: "org_1",
      userId: "user_1",
    });

    now += 11 * 60 * 1000;

    await expect(
      identity.bindExternalPrincipal({
        actor: { mode: "local-token", userId: LOCAL_CLIENT_USER_ID },
        channel: "whatsapp",
        channelUserId: "628111111111@s.whatsapp.net",
        expectedUserId: "user_1",
        orgId: "org_1",
        pairingAssertion: assertion,
      })
    ).rejects.toThrow(/expired/i);
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
        expectedUserId: "user_1",
        orgId: "org_1",
        pairingAssertion: assertion,
      })
    ).rejects.toThrow(/network down/);
    db.upsertChannelOrgMapping = original;
    const principal = await identity.bindExternalPrincipal({
      actor: { mode: "local-token", userId: LOCAL_CLIENT_USER_ID },
      channel: "telegram",
      channelUserId: "42",
      expectedUserId: "user_1",
      orgId: "org_1",
      pairingAssertion: assertion,
    });
    expect(principal.userId).toBe("user_1");
  });

  test("does not consume a pairing assertion when expected user mismatches", async () => {
    const db = await seed();
    const identity = new IdentityService(db);
    const assertion = await identity.issuePairingAssertion({
      channel: "whatsapp",
      orgId: "org_1",
      userId: "user_1",
    });

    await expect(
      identity.bindExternalPrincipal({
        actor: { mode: "workspace-worker", userId: LOCAL_CLIENT_USER_ID },
        channel: "whatsapp",
        channelUserId: "628111111111@s.whatsapp.net",
        expectedUserId: "user_admin",
        orgId: "org_1",
        pairingAssertion: assertion,
      })
    ).rejects.toThrow(/expected user/i);

    await expect(
      identity.bindExternalPrincipal({
        actor: { mode: "workspace-worker", userId: LOCAL_CLIENT_USER_ID },
        channel: "whatsapp",
        channelUserId: "628111111111@s.whatsapp.net",
        expectedUserId: "user_1",
        orgId: "org_1",
        pairingAssertion: assertion,
      })
    ).resolves.toMatchObject({ userId: "user_1" });
  });

  test("retries a consumed assertion only for its exact existing mapping", async () => {
    const db = await seed();
    const identity = new IdentityService(db);
    const assertion = await identity.issuePairingAssertion({
      channel: "whatsapp",
      orgId: "org_1",
      userId: "user_1",
    });
    const originalUpsert = db.upsertChannelOrgMapping.bind(db);
    let mappingWrites = 0;
    db.upsertChannelOrgMapping = async (mapping) => {
      mappingWrites += 1;
      return originalUpsert(mapping);
    };
    const input = {
      actor: {
        mode: "workspace-worker" as const,
        userId: LOCAL_CLIENT_USER_ID,
      },
      channel: "whatsapp" as const,
      channelUserId: "628111111111@s.whatsapp.net",
      expectedUserId: "user_1",
      orgId: "org_1",
      pairingAssertion: assertion,
    };

    await expect(identity.bindExternalPrincipal(input)).resolves.toMatchObject({
      userId: "user_1",
    });
    await expect(identity.bindExternalPrincipal(input)).resolves.toMatchObject({
      userId: "user_1",
    });
    expect(mappingWrites).toBe(1);

    await expect(
      identity.bindExternalPrincipal({
        ...input,
        channelUserId: "628122222222@s.whatsapp.net",
      })
    ).rejects.toThrow(/already used|invalid/i);
    expect(mappingWrites).toBe(1);
  });

  test("rejects an idempotent retry after the mapping changes user", async () => {
    const db = await seed();
    const identity = new IdentityService(db);
    const assertion = await identity.issuePairingAssertion({
      channel: "whatsapp",
      orgId: "org_1",
      userId: "user_1",
    });
    const input = {
      actor: {
        mode: "workspace-worker" as const,
        userId: LOCAL_CLIENT_USER_ID,
      },
      channel: "whatsapp" as const,
      channelUserId: "628111111111@s.whatsapp.net",
      expectedUserId: "user_1",
      orgId: "org_1",
      pairingAssertion: assertion,
    };

    await identity.bindExternalPrincipal(input);
    await db.upsertChannelOrgMapping({
      channel: "whatsapp",
      channelUserId: input.channelUserId,
      createdAt: new Date().toISOString(),
      orgId: "org_1",
      userId: "user_admin",
    });

    await expect(identity.bindExternalPrincipal(input)).rejects.toThrow(
      /already used|invalid/i
    );
    expect(
      await db.getChannelOrgMapping("org_1", "whatsapp", input.channelUserId)
    ).toMatchObject({ userId: "user_admin" });
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
    ).rejects.toThrow(/not authorized/);
    expect(
      await db.getChannelOrgMapping("org_1", "whatsapp", "154352568283178@lid")
    ).toBeNull();
  });

  test("provisions an authorized worker sender as an internal member", async () => {
    const db = await seed();
    const guestPrincipals = new ChannelGuestPrincipalService(db, {
      authorize: () => true,
    });
    const identity = new IdentityService(db, Date.now, guestPrincipals);

    const principal = await identity.resolveForChannelSession({
      authUserId: LOCAL_CLIENT_USER_ID,
      channel: "telegram",
      channelUserId: "42",
      isPlatformAdmin: false,
      orgId: "org_1",
      orgRole: "admin",
    });

    expect(principal).toMatchObject({
      isPlatformAdmin: false,
      orgRole: "member",
    });
    expect(principal.userId).not.toBe("user_admin");
    expect(
      await db.getChannelOrgMapping("org_1", "telegram", "42")
    ).toMatchObject({ userId: principal.userId });
  });

  test("reauthorizes an existing guest before a worker can recover it", async () => {
    const db = await seed();
    let authorized = true;
    let authorizationChecks = 0;
    const guestPrincipals = new ChannelGuestPrincipalService(db, {
      authorize: () => {
        authorizationChecks += 1;
        return authorized;
      },
    });
    const identity = new IdentityService(db, Date.now, guestPrincipals);
    const input = {
      authUserId: LOCAL_CLIENT_USER_ID,
      channel: "telegram" as const,
      channelUserId: "42",
      isPlatformAdmin: false,
      orgId: "org_1",
      orgRole: "member" as const,
    };

    const guest = await identity.resolveForChannelSession(input);
    authorized = false;

    await expect(identity.resolveForChannelSession(input)).rejects.toThrow(
      /not authorized/i
    );
    expect(authorizationChecks).toBe(2);
    expect(
      await db.getChannelOrgMapping("org_1", "telegram", "42")
    ).toMatchObject({ userId: guest.userId });
  });

  test("proves a WhatsApp LID through its mapped phone alias", async () => {
    const db = await seed();
    const identity = new IdentityService(db);
    const lid = "154352568283178@lid";
    const phone = "628111111111@s.whatsapp.net";
    await db.upsertChannelOrgMapping({
      channel: "whatsapp",
      channelUserId: phone,
      createdAt: new Date().toISOString(),
      orgId: "org_1",
      userId: "user_1",
    });

    const principal = await identity.resolveForChannelSession({
      authUserId: LOCAL_CLIENT_USER_ID,
      channel: "whatsapp",
      channelUserAliases: [phone],
      channelUserId: lid,
      isPlatformAdmin: false,
      orgId: "org_1",
      orgRole: "admin",
    });

    expect(principal).toMatchObject({
      isPlatformAdmin: false,
      orgRole: "member",
      userId: "user_1",
    });
    expect(
      await db.getChannelOrgMapping("org_1", "whatsapp", lid)
    ).toMatchObject({ userId: "user_1" });
  });

  test("rejects conflicting WhatsApp LID and phone mappings", async () => {
    const db = await seed();
    const identity = new IdentityService(db);
    const lid = "154352568283178@lid";
    const phone = "628111111111@s.whatsapp.net";
    const createdAt = new Date().toISOString();
    await db.upsertChannelOrgMapping({
      channel: "whatsapp",
      channelUserId: lid,
      createdAt,
      orgId: "org_1",
      userId: "user_1",
    });
    await db.upsertChannelOrgMapping({
      channel: "whatsapp",
      channelUserId: phone,
      createdAt,
      orgId: "org_1",
      userId: "user_admin",
    });

    await expect(
      identity.resolveForChannelSession({
        authUserId: LOCAL_CLIENT_USER_ID,
        channel: "whatsapp",
        channelUserAliases: [phone],
        channelUserId: lid,
        isPlatformAdmin: false,
        orgId: "org_1",
        orgRole: "admin",
      })
    ).rejects.toThrow(/conflicting canonical user mappings/i);
    expect(
      await db.getChannelOrgMapping("org_1", "whatsapp", lid)
    ).toMatchObject({ userId: "user_1" });
    expect(
      await db.getChannelOrgMapping("org_1", "whatsapp", phone)
    ).toMatchObject({ userId: "user_admin" });
  });

  test("rejects conflicting WhatsApp phone aliases before extending an existing mapping", async () => {
    const db = await seed();
    const identity = new IdentityService(db);
    const lid = "154352568283178@lid";
    const mappedPhone = "628111111111@s.whatsapp.net";
    const conflictingPhone = "628122222222@s.whatsapp.net";
    await db.upsertChannelOrgMapping({
      channel: "whatsapp",
      channelUserId: mappedPhone,
      createdAt: new Date().toISOString(),
      orgId: "org_1",
      userId: "user_1",
    });

    await expect(
      identity.resolveForChannelSession({
        authUserId: LOCAL_CLIENT_USER_ID,
        channel: "whatsapp",
        channelUserAliases: [mappedPhone, conflictingPhone],
        channelUserId: lid,
        isPlatformAdmin: false,
        orgId: "org_1",
        orgRole: "admin",
      })
    ).rejects.toThrow(/conflicting phone identities/i);
    expect(
      await db.getChannelOrgMapping("org_1", "whatsapp", mappedPhone)
    ).toMatchObject({ userId: "user_1" });
    expect(await db.getChannelOrgMapping("org_1", "whatsapp", lid)).toBeNull();
    expect(
      await db.getChannelOrgMapping("org_1", "whatsapp", conflictingPhone)
    ).toBeNull();
  });

  test("serializes competing WhatsApp alias proofs without rebinding the LID", async () => {
    const db = await seed();
    const identity = new IdentityService(db);
    const lid = "154352568283178@lid";
    const memberPhone = "628111111111@s.whatsapp.net";
    const adminPhone = "628122222222@s.whatsapp.net";
    const createdAt = new Date().toISOString();
    await db.upsertChannelOrgMapping({
      channel: "whatsapp",
      channelUserId: memberPhone,
      createdAt,
      orgId: "org_1",
      userId: "user_1",
    });
    await db.upsertChannelOrgMapping({
      channel: "whatsapp",
      channelUserId: adminPhone,
      createdAt,
      orgId: "org_1",
      userId: "user_admin",
    });
    const baseInput = {
      authUserId: LOCAL_CLIENT_USER_ID,
      channel: "whatsapp",
      channelUserId: lid,
      isPlatformAdmin: false,
      orgId: "org_1",
      orgRole: "admin" as const,
    };

    const results = await Promise.allSettled([
      identity.resolveForChannelSession({
        ...baseInput,
        channelUserAliases: [memberPhone],
      }),
      identity.resolveForChannelSession({
        ...baseInput,
        channelUserAliases: [adminPhone],
      }),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected")
    ).toHaveLength(1);
    expect(
      await db.getChannelOrgMapping("org_1", "whatsapp", lid)
    ).toMatchObject({ userId: "user_1" });
  });

  test("does not propagate WhatsApp aliases without one proven mapping", async () => {
    const db = await seed();
    const identity = new IdentityService(db);
    const lid = "154352568283178@lid";
    const phone = "628111111111@s.whatsapp.net";

    await expect(
      identity.resolveForChannelSession({
        authUserId: LOCAL_CLIENT_USER_ID,
        channel: "whatsapp",
        channelUserAliases: [phone],
        channelUserId: lid,
        isPlatformAdmin: false,
        orgId: "org_1",
        orgRole: "admin",
      })
    ).rejects.toThrow(/not authorized/);
    expect(await db.getChannelOrgMapping("org_1", "whatsapp", lid)).toBeNull();
    expect(
      await db.getChannelOrgMapping("org_1", "whatsapp", phone)
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
