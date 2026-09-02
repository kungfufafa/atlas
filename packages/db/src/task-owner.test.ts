import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteDatabase } from "./adapters/sqlite";

describe("task owner persistence", () => {
  let rootDir = "";

  afterEach(() => {
    if (rootDir) {
      rmSync(rootDir, { force: true, recursive: true });
      rootDir = "";
    }
  });

  test("atomically first-claims a canonical owner in SQLite", async () => {
    rootDir = mkdtempSync(join(tmpdir(), "atlas-task-owner-"));
    const database = await createSqliteDatabase(
      `file:${join(rootDir, "atlas.sqlite")}`
    );
    const now = "2026-08-31T00:00:00.000Z";

    try {
      await database.adapter.upsertOrganization({
        createdAt: now,
        id: "org_task_owner",
        name: "Task Owner",
        slug: "task-owner",
        updatedAt: now,
      });
      await database.adapter.createUser({
        createdAt: now,
        email: "task-owner@example.com",
        id: "user_task_owner",
        passwordHash: "unused",
        updatedAt: now,
      });
      await database.adapter.createUser({
        createdAt: now,
        email: "task-other@example.com",
        id: "user_task_other",
        passwordHash: "unused",
        updatedAt: now,
      });
      await database.adapter.upsertProfile({
        createdAt: now,
        id: "profile_task_owner",
        isDefault: true,
        isSuper: false,
        model: null,
        name: "Task Agent",
        orgId: "org_task_owner",
        systemPrompt: "",
        updatedAt: now,
      });
      await database.adapter.upsertTask({
        createdAt: now,
        createdByUserId: null,
        description: "",
        id: "task_owned",
        orgId: "org_task_owner",
        position: 0,
        profileId: "profile_task_owner",
        prompt: "Do the work.",
        status: "backlog",
        title: "Owned task",
        updatedAt: now,
      });

      const claims = await Promise.all([
        database.adapter.claimTaskOwner(
          "task_owned",
          "org_task_owner",
          "user_task_owner",
          now
        ),
        database.adapter.claimTaskOwner(
          "task_owned",
          "org_task_owner",
          "user_task_other",
          now
        ),
      ]);
      expect(claims.filter(Boolean)).toHaveLength(1);
      const expectedOwner = claims[0] ? "user_task_owner" : "user_task_other";
      expect(await database.adapter.getTask("task_owned")).toMatchObject({
        createdByUserId: expectedOwner,
        orgId: "org_task_owner",
      });
    } finally {
      database.close();
    }
  });
});
