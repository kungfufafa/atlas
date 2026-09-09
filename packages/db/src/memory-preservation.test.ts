import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInMemoryDatabaseAdapter } from "./adapters/in-memory";
import { createSqliteDatabase } from "./adapters/sqlite";
import type { DatabaseAdapter, StoredMemoryRecord } from "./types";

const NOW = "2026-01-01T00:00:00.000Z";
const LATER = "2026-02-01T00:00:00.000Z";

function memory(
  id: string,
  patch: Partial<StoredMemoryRecord> = {}
): StoredMemoryRecord {
  return {
    confidence: 0.8,
    content: "The meeting room opens at nine.",
    createdAt: NOW,
    id,
    importance: 0.6,
    orgId: "org-a",
    ownerId: "owner-a",
    scope: "user",
    source: "conversation-a",
    subject: "meeting-room-hours",
    updatedAt: NOW,
    ...patch,
  };
}

async function seedOrganizations(db: DatabaseAdapter): Promise<void> {
  for (const orgId of ["org-a", "org-b"]) {
    await db.upsertOrganization({
      createdAt: NOW,
      id: orgId,
      name: orgId,
      slug: orgId,
      updatedAt: NOW,
    });
  }
}

async function withAdapter(
  kind: "in-memory" | "sqlite",
  run: (db: DatabaseAdapter) => Promise<void>
): Promise<void> {
  if (kind === "in-memory") {
    const db = createInMemoryDatabaseAdapter();
    await seedOrganizations(db);
    await run(db);
    return;
  }
  const database = await createSqliteDatabase(":memory:");
  try {
    await seedOrganizations(database.adapter);
    await run(database.adapter);
  } finally {
    database.close();
  }
}

for (const kind of ["in-memory", "sqlite"] as const) {
  describe(`${kind} preserving memory creation`, () => {
    test("reuses an exact fact without replacing its ID or metadata", async () => {
      await withAdapter(kind, async (db) => {
        const original = memory("original");
        expect(await db.createOrGetMemory(original)).toEqual(original);
        const reused = await db.createOrGetMemory(
          memory("retry", {
            confidence: 0.2,
            content: `  ${original.content}\n`,
            createdAt: LATER,
            importance: 0.1,
            source: "conversation-b",
            updatedAt: LATER,
          })
        );
        expect(reused).toEqual(original);
        expect(await db.getMemory("org-a", "original")).toEqual(original);
        expect(await db.getMemory("org-a", "retry")).toBeNull();
        expect(await db.listMemories("org-a", "user", "owner-a", 100)).toEqual([
          original,
        ]);
      });
    });

    test("preserves changed content even when the subject is the same", async () => {
      await withAdapter(kind, async (db) => {
        const original = memory("original");
        const additional = memory("additional", {
          content: "The meeting room closes at six.",
        });
        await db.createOrGetMemory(original);
        expect(await db.createOrGetMemory(additional)).toEqual(additional);
        expect(await db.getMemory("org-a", "original")).toEqual(original);
        expect(await db.getMemory("org-a", "additional")).toEqual(additional);
      });
    });

    test("keeps content case and internal whitespace significant", async () => {
      await withAdapter(kind, async (db) => {
        const records = [
          memory("original"),
          memory("case", { content: "The meeting room opens at NINE." }),
          memory("spacing", { content: "The meeting room  opens at nine." }),
        ];
        for (const record of records) {
          expect(await db.createOrGetMemory(record)).toEqual(record);
        }
        expect(
          await db.listMemories("org-a", "user", "owner-a", 100)
        ).toHaveLength(records.length);
      });
    });

    test("compares normalized subject identity but preserves the original representation", async () => {
      await withAdapter(kind, async (db) => {
        const original = memory("original", { subject: "  ＲＯＯＭ Café  " });
        await db.createMemory(original);
        expect(
          await db.createOrGetMemory(
            memory("normalized", { subject: "room Cafe\u0301" })
          )
        ).toEqual(original);
        const different = memory("different", { subject: "room kitchen" });
        expect(await db.createOrGetMemory(different)).toEqual(different);
        expect(await db.getMemory("org-a", "original")).toEqual(original);
        expect(
          await db.listMemories("org-a", "user", "owner-a", 100)
        ).toHaveLength(2);
      });
    });

    test("treats absent and empty subjects as the same identity", async () => {
      await withAdapter(kind, async (db) => {
        const original = memory("original", { subject: null });
        await db.createOrGetMemory(original);
        for (const [index, subject] of [undefined, "", " \t\n"].entries()) {
          expect(
            await db.createOrGetMemory(memory(`retry-${index}`, { subject }))
          ).toEqual(original);
        }
        const explicit = memory("explicit", { subject: "room-hours" });
        expect(await db.createOrGetMemory(explicit)).toEqual(explicit);
        expect(
          await db.listMemories("org-a", "user", "owner-a", 100)
        ).toHaveLength(2);
      });
    });

    test("isolates exact fact reuse by organization, owner, and scope", async () => {
      await withAdapter(kind, async (db) => {
        const records = [
          memory("original"),
          memory("other-org", { orgId: "org-b" }),
          memory("other-owner", { ownerId: "owner-b" }),
          memory("other-scope", { scope: "project" }),
        ];
        for (const record of records) {
          expect(await db.createOrGetMemory(record)).toEqual(record);
          expect(
            await db.createOrGetMemory({ ...record, id: `${record.id}-retry` })
          ).toEqual(record);
        }
        expect(
          await db.listMemories("org-a", undefined, undefined, 100)
        ).toHaveLength(3);
        expect(
          await db.listMemories("org-b", undefined, undefined, 100)
        ).toEqual([records[1]]);
      });
    });

    test("finds an identical retry beyond fifty more recent unrelated facts", async () => {
      await withAdapter(kind, async (db) => {
        const original = memory("original");
        await db.createOrGetMemory(original);
        for (let index = 0; index < 75; index += 1) {
          await db.createOrGetMemory(
            memory(`unrelated-${index}`, {
              content: `Reference room ${index} has a blue door.`,
              createdAt: LATER,
              subject: `reference-room-${index}`,
              updatedAt: LATER,
            })
          );
        }
        expect(await db.createOrGetMemory(memory("retry"))).toEqual(original);
        expect(
          await db.listMemories("org-a", "user", "owner-a", 200)
        ).toHaveLength(76);
        expect(await db.getMemory("org-a", "retry")).toBeNull();
      });
    });

    test("coalesces simultaneous identical creations with distinct candidate IDs", async () => {
      await withAdapter(kind, async (db) => {
        const candidates = Array.from({ length: 24 }, (_, index) =>
          memory(`candidate-${index}`, { source: `source-${index}` })
        );
        const results = await Promise.all(
          candidates.map((candidate) => db.createOrGetMemory(candidate))
        );
        const [stored] = await db.listMemories("org-a", "user", "owner-a", 100);
        expect(stored).toBeDefined();
        expect(candidates).toContainEqual(stored);
        for (const result of results) {
          expect(result).toEqual(stored);
        }
        expect(
          await db.listMemories("org-a", "user", "owner-a", 100)
        ).toHaveLength(1);
      });
    });

    test("rejects a colliding candidate ID without replacing another fact or tenant", async () => {
      await withAdapter(kind, async (db) => {
        const original = memory("shared-id");
        await db.createOrGetMemory(original);
        for (const incoming of [
          memory("shared-id", { content: "The room has a projector." }),
          memory("shared-id", { orgId: "org-b" }),
        ]) {
          await expect(db.createOrGetMemory(incoming)).rejects.toThrow();
          expect(await db.getMemory("org-a", "shared-id")).toEqual(original);
          expect(await db.getMemory("org-b", "shared-id")).toBeNull();
        }
      });
    });
  });
}

test("SQLite preserves exact-reuse identity and independent facts after close and reopen", async () => {
  const root = await mkdtemp(join(tmpdir(), "atlas-memory-preservation-"));
  const url = `file:${join(root, "memory.sqlite")}`;
  let database = await createSqliteDatabase(url);
  try {
    await seedOrganizations(database.adapter);
    const original = memory("original", { subject: "Café" });
    const independent = memory("independent", {
      content: "The meeting room has a projector.",
      subject: "Café",
    });
    await database.adapter.createOrGetMemory(original);
    await database.adapter.createOrGetMemory(independent);
    database.close();
    database = await createSqliteDatabase(url);
    expect(
      await database.adapter.createOrGetMemory(
        memory("retry-after-reopen", {
          source: "later-conversation",
          subject: "CAFE\u0301",
          updatedAt: LATER,
        })
      )
    ).toEqual(original);
    expect(await database.adapter.getMemory("org-a", "independent")).toEqual(
      independent
    );
    expect(
      await database.adapter.listMemories("org-a", "user", "owner-a", 100)
    ).toHaveLength(2);
  } finally {
    database.close();
    await rm(root, { force: true, recursive: true });
  }
}, 30_000);
