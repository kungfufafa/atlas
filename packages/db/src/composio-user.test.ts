import { describe, expect, test } from "bun:test";
import { createInMemoryDatabaseAdapter } from "./adapters/in-memory";
import { createSqliteDatabase } from "./adapters/sqlite";
import type { DatabaseAdapter } from "./types";

async function withDatabaseVariants(
  run: (db: DatabaseAdapter) => Promise<void>
): Promise<void> {
  await run(createInMemoryDatabaseAdapter());
  const database = await createSqliteDatabase(":memory:");
  try {
    await run(database.adapter);
  } finally {
    database.close();
  }
}

describe("composio user connections", () => {
  test("upsert and fetch user connection by toolkit", async () => {
    const db = createInMemoryDatabaseAdapter();
    const now = new Date().toISOString();

    await db.upsertComposioToolkit({
      cachedTools: [],
      createdAt: now,
      displayName: "Gmail",
      id: "ctk_gmail",
      lastError: null,
      orgId: "org_a",
      status: "enabled",
      toolkitSlug: "gmail",
      updatedAt: now,
    });

    await db.upsertComposioUserConnection({
      connectedAccountId: "ca_1",
      createdAt: now,
      id: "cuc_1",
      lastError: null,
      oauthStateHash: null,
      orgId: "org_a",
      sessionIdEnc: null,
      status: "connected",
      toolkitId: "ctk_gmail",
      updatedAt: now,
      userId: "usr_a",
    });

    const connection = await db.getComposioUserConnection("usr_a", "ctk_gmail");
    expect(connection?.status).toBe("connected");

    const listed = await db.listComposioUserConnectionsForUser(
      "org_a",
      "usr_a"
    );
    expect(listed).toHaveLength(1);
  });

  test("two users can connect the same org toolkit independently", async () => {
    const db = createInMemoryDatabaseAdapter();
    const now = new Date().toISOString();

    await db.upsertComposioToolkit({
      cachedTools: [],
      createdAt: now,
      displayName: "Gmail",
      id: "ctk_gmail",
      lastError: null,
      orgId: "org_a",
      status: "enabled",
      toolkitSlug: "gmail",
      updatedAt: now,
    });

    await db.upsertComposioUserConnection({
      connectedAccountId: "ca_a",
      createdAt: now,
      id: "cuc_a",
      lastError: null,
      oauthStateHash: null,
      orgId: "org_a",
      sessionIdEnc: null,
      status: "connected",
      toolkitId: "ctk_gmail",
      updatedAt: now,
      userId: "usr_a",
    });

    await db.upsertComposioUserConnection({
      connectedAccountId: "ca_b",
      createdAt: now,
      id: "cuc_b",
      lastError: null,
      oauthStateHash: null,
      orgId: "org_a",
      sessionIdEnc: null,
      status: "connected",
      toolkitId: "ctk_gmail",
      updatedAt: now,
      userId: "usr_b",
    });

    expect(
      await db.getComposioUserConnection("usr_a", "ctk_gmail")
    ).not.toBeNull();
    expect(
      await db.getComposioUserConnection("usr_b", "ctk_gmail")
    ).not.toBeNull();
  });

  test("listComposioUserConnectionsForUser filters by org", async () => {
    const db = createInMemoryDatabaseAdapter();
    const now = new Date().toISOString();

    await db.upsertComposioUserConnection({
      connectedAccountId: null,
      createdAt: now,
      id: "cuc_a",
      lastError: null,
      oauthStateHash: null,
      orgId: "org_a",
      sessionIdEnc: null,
      status: "connected",
      toolkitId: "ctk_1",
      updatedAt: now,
      userId: "usr_a",
    });

    await db.upsertComposioUserConnection({
      connectedAccountId: null,
      createdAt: now,
      id: "cuc_b",
      lastError: null,
      oauthStateHash: null,
      orgId: "org_b",
      sessionIdEnc: null,
      status: "connected",
      toolkitId: "ctk_2",
      updatedAt: now,
      userId: "usr_a",
    });

    const orgA = await db.listComposioUserConnectionsForUser("org_a", "usr_a");
    expect(orgA).toHaveLength(1);
    expect(orgA[0]?.id).toBe("cuc_a");
  });

  test("OAuth state compare-and-swap lets only one callback claim a generation", async () => {
    await withDatabaseVariants(async (db) => {
      const now = new Date().toISOString();
      await db.upsertOrganization({
        createdAt: now,
        id: "org_cas",
        name: "CAS",
        slug: "cas",
        updatedAt: now,
      });
      await db.createUser({
        createdAt: now,
        email: "cas@example.com",
        id: "usr_cas",
        passwordHash: "hash",
        updatedAt: now,
      });
      await db.upsertComposioToolkit({
        cachedTools: [],
        createdAt: now,
        displayName: "Gmail",
        id: "ctk_cas",
        lastError: null,
        orgId: "org_cas",
        status: "enabled",
        toolkitSlug: "gmail",
        updatedAt: now,
      });
      const pending = {
        connectedAccountId: null,
        createdAt: now,
        id: "cuc_cas",
        lastError: null,
        oauthStateHash: "state-generation",
        orgId: "org_cas",
        sessionIdEnc: null,
        status: "oauth_in_progress" as const,
        toolkitId: "ctk_cas",
        updatedAt: now,
        userId: "usr_cas",
      };
      await db.upsertComposioUserConnection(pending);

      expect(
        await db.compareAndSwapComposioUserConnection(
          { ...pending, oauthStateHash: "wrong-claim" },
          "wrong-generation"
        )
      ).toBe(false);

      const results = await Promise.all([
        db.compareAndSwapComposioUserConnection(
          { ...pending, oauthStateHash: "claim-a" },
          "state-generation"
        ),
        db.compareAndSwapComposioUserConnection(
          { ...pending, oauthStateHash: "claim-b" },
          "state-generation"
        ),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(
        (await db.getComposioUserConnectionById("cuc_cas"))?.oauthStateHash
      ).toBe(results[0] ? "claim-a" : "claim-b");
    });
  });
});
