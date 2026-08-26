import { describe, expect, test } from "bun:test";
import { createSqliteDatabase } from "./index";

describe("SQLite skill curator due clock", () => {
  test("persists completion without overwriting it during normal org updates", async () => {
    const database = await createSqliteDatabase(":memory:");
    const db = database.adapter;
    const createdAt = "2026-08-01T00:00:00.000Z";
    const completedAt = "2026-08-26T00:00:00.000Z";

    try {
      await db.upsertOrganization({
        createdAt,
        id: "org_curator",
        name: "Curator",
        skillsCuratorConsolidation: true,
        slug: "curator",
        updatedAt: createdAt,
      });
      expect(
        await db.markSkillCuratorRunCompleted("org_curator", completedAt)
      ).toBe(true);
      expect(await db.getOrganizationById("org_curator")).toMatchObject({
        skillsCuratorLastRunAt: completedAt,
      });

      await db.upsertOrganization({
        createdAt,
        id: "org_curator",
        name: "Renamed",
        skillsCuratorConsolidation: true,
        slug: "curator",
        updatedAt: "2026-08-26T01:00:00.000Z",
      });
      expect(await db.getOrganizationById("org_curator")).toMatchObject({
        name: "Renamed",
        skillsCuratorLastRunAt: completedAt,
      });
    } finally {
      database.close();
    }
  });

  test("refuses to advance the clock when consolidation is disabled", async () => {
    const database = await createSqliteDatabase(":memory:");
    const db = database.adapter;
    const now = "2026-08-26T00:00:00.000Z";

    try {
      await db.upsertOrganization({
        createdAt: now,
        id: "org_disabled",
        name: "Disabled",
        skillsCuratorConsolidation: false,
        slug: "disabled",
        updatedAt: now,
      });
      expect(await db.markSkillCuratorRunCompleted("org_disabled", now)).toBe(
        false
      );
      expect(
        (await db.getOrganizationById("org_disabled"))?.skillsCuratorLastRunAt
      ).toBeNull();
    } finally {
      database.close();
    }
  });
});
