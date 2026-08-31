import { describe, expect, test } from "bun:test";
import { createSqliteDatabase } from "./adapters/sqlite";

describe("replaceProfileComposioToolkits atomicity", () => {
  test("restores prior assignments when a replacement batch fails", async () => {
    const database = await createSqliteDatabase(":memory:");
    try {
      const now = "2020-01-01T00:00:00.000Z";
      await database.adapter.upsertOrganization({
        createdAt: now,
        id: "org_test",
        name: "Test",
        slug: "test",
        updatedAt: now,
      });
      await database.adapter.upsertProfile({
        createdAt: now,
        id: "profile_1",
        isDefault: true,
        isSuper: false,
        model: null,
        name: "Profile",
        orgId: "org_test",
        systemPrompt: "",
        updatedAt: now,
      });
      for (const [id, displayName, toolkitSlug] of [
        ["ctk_a", "Gmail", "gmail"],
        ["ctk_b", "Slack", "slack"],
      ] as const) {
        await database.adapter.upsertComposioToolkit({
          cachedTools: [],
          createdAt: now,
          displayName,
          id,
          lastError: null,
          orgId: "org_test",
          status: "enabled",
          toolkitSlug,
          updatedAt: now,
        });
      }

      await database.adapter.replaceProfileComposioToolkits("profile_1", [
        {
          allowedActions: ["GMAIL_SEND_EMAIL"],
          profileId: "profile_1",
          toolkitId: "ctk_a",
        },
      ]);

      await expect(
        database.adapter.replaceProfileComposioToolkits("profile_1", [
          {
            allowedActions: null,
            profileId: "profile_1",
            toolkitId: "ctk_b",
          },
          {
            allowedActions: ["GMAIL_SEND_EMAIL"],
            profileId: "profile_1",
            toolkitId: "ctk_b",
          },
        ])
      ).rejects.toThrow();
      expect(
        await database.adapter.listProfileComposioToolkits("profile_1")
      ).toEqual([
        {
          allowedActions: ["GMAIL_SEND_EMAIL"],
          profileId: "profile_1",
          toolkitId: "ctk_a",
        },
      ]);
    } finally {
      database.close();
    }
  });
});
