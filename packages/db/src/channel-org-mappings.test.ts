import { describe, expect, test } from "bun:test";
import { createInMemoryDatabaseAdapter } from "./adapters/in-memory";
import { createSqliteDatabase } from "./adapters/sqlite";
import type { DatabaseAdapter } from "./types";

async function seedMappingDependencies(db: DatabaseAdapter): Promise<void> {
  const now = new Date().toISOString();
  for (const [id, name] of [
    ["org_a", "Acme"],
    ["org_b", "Globex"],
  ] as const) {
    await db.upsertOrganization({
      createdAt: now,
      id,
      name,
      slug: id,
      updatedAt: now,
    });
  }
  for (const [id, email] of [
    ["user_a", "a@example.com"],
    ["user_b", "b@example.com"],
  ] as const) {
    await db.createUser({
      createdAt: now,
      email,
      id,
      passwordHash: "x",
      updatedAt: now,
    });
  }
}

async function expectTenantScopedMappings(db: DatabaseAdapter): Promise<void> {
  await seedMappingDependencies(db);
  const createdAt = new Date().toISOString();
  await db.upsertChannelOrgMapping({
    channel: "whatsapp",
    channelUserId: "628123",
    createdAt,
    orgId: "org_a",
    userId: "user_a",
  });
  await db.upsertChannelOrgMapping({
    channel: "whatsapp",
    channelUserId: "628123",
    createdAt,
    orgId: "org_b",
    userId: "user_b",
  });

  expect(
    await db.getChannelOrgMapping("org_a", "whatsapp", "628123")
  ).toMatchObject({ orgId: "org_a", userId: "user_a" });
  expect(
    await db.getChannelOrgMapping("org_b", "whatsapp", "628123")
  ).toMatchObject({ orgId: "org_b", userId: "user_b" });

  expect(await db.deleteChannelOrgMapping("org_a", "whatsapp", "628123")).toBe(
    true
  );
  expect(
    await db.getChannelOrgMapping("org_a", "whatsapp", "628123")
  ).toBeNull();
  expect(
    await db.getChannelOrgMapping("org_b", "whatsapp", "628123")
  ).toMatchObject({ orgId: "org_b", userId: "user_b" });
}

describe("channel organization mappings", () => {
  test("isolates identical channel identities in memory", async () => {
    await expectTenantScopedMappings(createInMemoryDatabaseAdapter());
  });

  test("isolates identical channel identities in sqlite", async () => {
    const database = await createSqliteDatabase(":memory:");
    try {
      await expectTenantScopedMappings(database.adapter);
    } finally {
      database.close();
    }
  });
});
