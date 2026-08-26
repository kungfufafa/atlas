import { describe, expect, test } from "bun:test";
import { createSqliteDatabase } from "./index";

describe("SQLite organization archive", () => {
  test("atomically preserves one active org and hides archived memberships", async () => {
    const database = await createSqliteDatabase(":memory:");
    const db = database.adapter;
    const now = "2026-08-26T00:00:00.000Z";

    try {
      await db.createUser({
        createdAt: now,
        email: "admin@example.com",
        id: "user_admin",
        passwordHash: "unused",
        updatedAt: now,
      });
      for (const [id, slug] of [
        ["org_a", "org-a"],
        ["org_b", "org-b"],
      ] as const) {
        await db.upsertOrganization({
          createdAt: now,
          id,
          name: id,
          slug,
          updatedAt: now,
        });
        await db.upsertOrgMember({
          createdAt: now,
          orgId: id,
          role: "admin",
          userId: "user_admin",
        });
      }

      expect(await db.tryMarkOrganizationArchived("org_a", now)).toBe(true);
      expect(await db.tryMarkOrganizationArchived("org_b", now)).toBe(false);
      expect(await db.getOrganizationById("org_a")).toMatchObject({
        archivedAt: now,
      });
      await db.upsertOrganization({
        createdAt: now,
        id: "org_a",
        name: "Accidental update",
        slug: "org-a",
        updatedAt: "2026-08-26T01:00:00.000Z",
      });
      expect(await db.getOrganizationById("org_a")).toMatchObject({
        archivedAt: now,
        name: "Accidental update",
      });
      expect(
        (await db.listUserOrganizations("user_admin")).map(
          (membership) => membership.organization.id
        )
      ).toEqual(["org_b"]);
    } finally {
      database.close();
    }
  });
});
