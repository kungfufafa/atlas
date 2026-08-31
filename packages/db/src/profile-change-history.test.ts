import { describe, expect, test } from "bun:test";
import { createInMemoryDatabaseAdapter } from "./adapters/in-memory";
import { createSqliteDatabase } from "./adapters/sqlite";
import type { DatabaseAdapter } from "./types";

async function seedProfile(
  adapter: DatabaseAdapter,
  orgId: string,
  profileId: string
): Promise<void> {
  const now = "2026-08-30T00:00:00.000Z";
  await adapter.upsertOrganization({
    createdAt: now,
    id: orgId,
    name: orgId,
    slug: orgId,
    updatedAt: now,
  });
  await adapter.upsertProfile({
    createdAt: now,
    id: profileId,
    isSuper: false,
    model: null,
    name: profileId,
    orgId,
    systemPrompt: "",
    updatedAt: now,
  });
}

function profileChangeHistoryContract(
  name: string,
  createAdapter: () => Promise<{
    adapter: DatabaseAdapter;
    close(): void;
  }>
): void {
  describe(name, () => {
    test("keeps an ordered, tenant-scoped append-only ledger", async () => {
      const database = await createAdapter();
      try {
        await seedProfile(database.adapter, "org_a", "profile_a");
        await seedProfile(database.adapter, "org_b", "profile_b");
        await database.adapter.createProfileChangeEvent({
          actorUserId: "user_a",
          afterValue: "after",
          beforeValue: "before",
          createdAt: "2026-08-30T01:00:00.000Z",
          field: "system_prompt",
          id: "event_old",
          orgId: "org_a",
          profileId: "profile_a",
          source: "dashboard",
        });
        await database.adapter.createProfileChangeEvent({
          actorUserId: null,
          afterValue: "newest",
          beforeValue: null,
          createdAt: "2026-08-30T02:00:00.000Z",
          field: "soul.memory",
          id: "event_new",
          orgId: "org_a",
          profileId: "profile_a",
          source: "skill_manage",
        });
        await database.adapter.createProfileChangeEvent({
          actorUserId: null,
          afterValue: "private",
          beforeValue: null,
          createdAt: "2026-08-30T03:00:00.000Z",
          field: "tools",
          id: "event_other_org",
          orgId: "org_b",
          profileId: "profile_b",
          source: "pack_import",
        });

        expect(
          (
            await database.adapter.listProfileChangeEvents("org_a", "profile_a")
          ).map((event) => event.id)
        ).toEqual(["event_new", "event_old"]);
        expect(
          await database.adapter.listProfileChangeEvents("org_b", "profile_a")
        ).toEqual([]);
        expect(
          (
            await database.adapter.listProfileChangeEvents(
              "org_a",
              "profile_a",
              { limit: 1, offset: 1 }
            )
          ).map((event) => event.id)
        ).toEqual(["event_old"]);

        await expect(
          database.adapter.createProfileChangeEvent({
            actorUserId: null,
            afterValue: "overwrite",
            beforeValue: null,
            createdAt: "2026-08-30T04:00:00.000Z",
            field: "skills",
            id: "event_old",
            orgId: "org_a",
            profileId: "profile_a",
            source: "dashboard",
          })
        ).rejects.toThrow();
      } finally {
        database.close();
      }
    });
  });
}

profileChangeHistoryContract("SQLite profile history", async () => {
  const database = await createSqliteDatabase(":memory:");
  return database;
});

profileChangeHistoryContract("in-memory profile history", async () => ({
  adapter: createInMemoryDatabaseAdapter(),
  close() {},
}));
