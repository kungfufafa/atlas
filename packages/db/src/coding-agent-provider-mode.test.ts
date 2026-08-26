import { describe, expect, test } from "bun:test";
import { createSqliteDatabase } from "./index";
import { mergeWorkspaceSettings } from "./workspace-settings";

describe("SQLite coding-agent provider mode", () => {
  test("persists independent values for each organization", async () => {
    const database = await createSqliteDatabase(":memory:");
    const db = database.adapter;
    const now = "2026-08-26T00:00:00.000Z";
    try {
      for (const [id, slug] of [
        ["org_native", "org-native"],
        ["org_atlas", "org-atlas"],
      ] as const) {
        await db.upsertOrganization({
          createdAt: now,
          id,
          name: id,
          slug,
          updatedAt: now,
        });
      }
      await db.upsertWorkspaceSettings(
        mergeWorkspaceSettings(null, {
          codingAgentProviderPassthrough: false,
          id: "workspace-settings:org_native",
          orgId: "org_native",
          updatedAt: now,
        })
      );
      await db.upsertWorkspaceSettings(
        mergeWorkspaceSettings(null, {
          id: "workspace-settings:org_atlas",
          orgId: "org_atlas",
          updatedAt: now,
        })
      );

      expect(await db.getWorkspaceSettings("org_native")).toMatchObject({
        codingAgentProviderPassthrough: false,
        orgId: "org_native",
      });
      expect(await db.getWorkspaceSettings("org_atlas")).toMatchObject({
        codingAgentProviderPassthrough: true,
        orgId: "org_atlas",
      });
    } finally {
      database.close();
    }
  });
});
