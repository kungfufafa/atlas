import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "@atlas/core";
import {
  createInMemoryDatabaseAdapter,
  createSqliteDatabase,
  type DatabaseAdapter,
  type StoredMemoryRecord,
} from "@atlas/db";
import { MemoryService } from "../services/memory-service";
import { createMemoryTools } from "./memory-tools";

const context: ToolContext = {
  orgId: "update-org",
  orgRole: "member",
  profileId: "update-profile",
  userId: "update-user",
};

async function createFixture(adapter: "sqlite" | "in-memory") {
  const directory = mkdtempSync(join(tmpdir(), "atlas-memory-update-"));
  const path = join(directory, "memory.sqlite");
  let sqlite = adapter === "sqlite" ? await createSqliteDatabase(path) : null;
  const db: DatabaseAdapter =
    sqlite?.adapter ?? createInMemoryDatabaseAdapter();
  const service = new MemoryService(db);
  const timestamp = new Date().toISOString();
  await db.upsertOrganization({
    createdAt: timestamp,
    id: "update-org",
    name: "Update review",
    slug: "update-review",
    updatedAt: timestamp,
  });
  const initial = await service.writeMemory("update-org", {
    confidence: 0.4,
    content: "Use the warehouse receiving entrance on Tuesdays.",
    importance: 4,
    ownerId: "update-user",
    scope: "user",
    source: "user correction",
    subject: "Receiving entrance",
  });
  const update = createMemoryTools(service).find(
    (tool) => tool.name === "memory_update"
  );
  if (!update) {
    throw new Error("Native memory_update tool unavailable");
  }
  return {
    async assertStored(changes: Partial<StoredMemoryRecord>) {
      // Reopening SQLite verifies both the persisted fields and read mapping.
      if (sqlite) {
        sqlite.close();
        sqlite = await createSqliteDatabase(path);
      }
      const persisted = sqlite?.adapter ?? db;
      const actual = await persisted.getMemory("update-org", initial.id);
      expect(actual).toEqual({
        ...initial,
        ...changes,
        updatedAt: expect.any(String),
      });
      return persisted;
    },
    close() {
      sqlite?.close();
      rmSync(directory, { force: true, recursive: true });
    },
    db,
    initial,
    async run(changes: Record<string, unknown>) {
      const result = await update.run({ id: initial.id, ...changes }, context);
      expect(result).toMatchObject({ id: initial.id });
    },
    service,
  };
}

for (const adapter of ["sqlite", "in-memory"] as const) {
  describe(`${adapter} partial native memory updates`, () => {
    test("importance-only preserves content and uncertain metadata", async () => {
      const fixture = await createFixture(adapter);
      try {
        await fixture.run({ importance: 5 });
        await fixture.assertStored({ importance: 5 });
      } finally {
        fixture.close();
      }
    });

    test("content-only preserves metadata and updates native search", async () => {
      const fixture = await createFixture(adapter);
      try {
        const content = "Use the warehouse side entrance on Wednesdays.";
        await fixture.run({ content });
        const persisted = await fixture.assertStored({ content });
        const service = new MemoryService(persisted);
        const scope = { ownerId: "update-user", scope: "user" as const };
        expect(
          await service.searchMemories("update-org", "Tuesdays", scope)
        ).toEqual([]);
        expect(
          (await service.searchMemories("update-org", "Wednesdays", scope)).map(
            (memory) => memory.id
          )
        ).toEqual([fixture.initial.id]);
      } finally {
        fixture.close();
      }
    });

    test("explicit null clears subject without resetting other fields", async () => {
      const fixture = await createFixture(adapter);
      try {
        await fixture.run({ subject: null });
        await fixture.assertStored({ subject: null });
      } finally {
        fixture.close();
      }
    });

    test("omitted subject preserves an already-cleared subject", async () => {
      const fixture = await createFixture(adapter);
      try {
        await fixture.run({ subject: null });
        await fixture.run({ importance: 2 });
        await fixture.assertStored({ importance: 2, subject: null });
      } finally {
        fixture.close();
      }
    });

    test("explicit zero confidence persists through a later partial update", async () => {
      const fixture = await createFixture(adapter);
      try {
        await fixture.run({ confidence: 0 });
        await fixture.run({ importance: 3 });
        await fixture.assertStored({ confidence: 0, importance: 3 });
      } finally {
        fixture.close();
      }
    });

    test("explicit undefined optional tool fields leave their stored values intact", async () => {
      const fixture = await createFixture(adapter);
      try {
        await fixture.run({
          confidence: undefined,
          content: undefined,
          importance: 5,
          subject: undefined,
        });
        await fixture.assertStored({ importance: 5 });
      } finally {
        fixture.close();
      }
    });

    test("service callers can omit fields using undefined", async () => {
      const fixture = await createFixture(adapter);
      try {
        await fixture.service.updateMemory("update-org", fixture.initial.id, {
          confidence: undefined,
          content: undefined,
          importance: 5,
          subject: undefined,
        });
        await fixture.assertStored({ importance: 5 });
      } finally {
        fixture.close();
      }
    });

    test("adapter updates ignore inherited and undefined properties but preserve zero and null", async () => {
      const fixture = await createFixture(adapter);
      try {
        const patch: Partial<StoredMemoryRecord> = Object.assign(
          Object.create({
            content: "Inherited content must never be persisted.",
            updatedAt: "1900-01-01T00:00:00.000Z",
          }),
          { confidence: 0, importance: undefined, subject: null }
        );
        await fixture.db.updateMemory("update-org", fixture.initial.id, patch);
        const persisted = await fixture.assertStored({
          confidence: 0,
          subject: null,
        });
        expect(
          (await persisted.getMemory("update-org", fixture.initial.id))
            ?.updatedAt
        ).not.toBe("1900-01-01T00:00:00.000Z");
      } finally {
        fixture.close();
      }
    });
  });
}
