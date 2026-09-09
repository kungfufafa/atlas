import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type {
  ArtifactPublicationIdentity,
  ArtifactPublicationScope,
} from "@atlas/core/artifact-publication";
import { comparePublicationKeys } from "./artifact-publication-page";
import { createInMemoryDatabaseAdapter, createSqliteDatabase } from "./index";
import type {
  ArtifactPublicationPageOptions,
  DatabaseAdapter,
  StoredArtifactPublicationRecord,
} from "./types";

const NOW = "2026-09-01T00:00:00.000Z";
const OLDER = "2026-08-01T00:00:00.000Z";
const NEWER = "2026-09-02T00:00:00.000Z";
const SCOPES: ArtifactPublicationScope[] = [
  { orgId: "org-a", profileId: "profile-a", sessionId: "session-a" },
  { orgId: "org-a", profileId: "profile-a", sessionId: "session-b" },
  { orgId: "org-a", profileId: "profile-b", sessionId: "session-c" },
  { orgId: "org-b", profileId: "profile-c", sessionId: "session-d" },
];
const PRIMARY = SCOPES[0]!;

async function seedScope(
  db: DatabaseAdapter,
  scope: ArtifactPublicationScope
): Promise<void> {
  await db.upsertOrganization({
    createdAt: NOW,
    id: scope.orgId,
    name: scope.orgId,
    slug: scope.orgId,
    updatedAt: NOW,
  });
  await db.upsertProfile({
    createdAt: NOW,
    id: scope.profileId,
    isSuper: false,
    model: null,
    name: scope.profileId,
    orgId: scope.orgId,
    systemPrompt: "",
    updatedAt: NOW,
  });
  await db.upsertSession({
    agentQuestionnaire: null,
    agentTodos: [],
    channel: "web",
    createdAt: NOW,
    id: scope.sessionId,
    modelOverride: null,
    orgId: scope.orgId,
    profileId: scope.profileId,
    title: null,
  });
}

async function fixture(
  kind: "memory" | "sqlite",
  run: (db: DatabaseAdapter) => Promise<void>
): Promise<void> {
  const sqlite =
    kind === "sqlite" ? await createSqliteDatabase(":memory:") : null;
  const db = sqlite?.adapter ?? createInMemoryDatabaseAdapter();
  try {
    for (const scope of SCOPES) {
      await seedScope(db, scope);
    }
    await run(db);
  } finally {
    sqlite?.close();
  }
}

function record(
  rank: number,
  scope = PRIMARY,
  createdAt = NOW
): StoredArtifactPublicationRecord {
  const suffix = `00000000-0000-0000-0000-${rank.toString(16).padStart(12, "0")}`;
  return {
    ...scope,
    actorId: "actor",
    createdAt,
    executionId: `execution-${rank}`,
    filename: "report.txt",
    id: `publication_${suffix}`,
    mimeType: "text/plain",
    outputOrdinal: 0,
    revokedAt: null,
    runId: "run",
    sha256: "a".repeat(64),
    sizeBytes: 12,
    snapshotId: `snapshot_${suffix}`,
    sourceEvidence: "tool_output_bytes",
    sourcePath: "artifacts/report.txt",
    toolCallId: "call",
  };
}

async function commit(
  db: DatabaseAdapter,
  value: StoredArtifactPublicationRecord
): Promise<void> {
  await db.commitArtifactPublications(value, [value]);
}

async function pages(
  db: DatabaseAdapter,
  scope: ArtifactPublicationScope,
  limit: number
): Promise<StoredArtifactPublicationRecord[][]> {
  const result: StoredArtifactPublicationRecord[][] = [];
  let after: ArtifactPublicationPageOptions["after"];
  for (let attempt = 0; attempt < 40; attempt++) {
    const page = await db.listArtifactPublications(scope, { after, limit });
    result.push(page);
    const last = page.at(-1);
    if (!last) {
      return result;
    }
    after = { createdAt: last.createdAt, id: last.id };
  }
  throw new Error("Publication pagination did not terminate.");
}

for (const kind of ["memory", "sqlite"] as const) {
  describe(`${kind} publication pages`, () => {
    test("each exact organization/profile/session sees only its own active outputs", async () => {
      await fixture(kind, async (db) => {
        const records = SCOPES.map((scope, index) => record(index + 1, scope));
        for (const value of records) {
          await commit(db, value);
        }
        for (const value of records) {
          expect(
            await db.listArtifactPublications(value, { limit: 101 })
          ).toEqual([value]);
          for (const other of records.filter((item) => item.id !== value.id)) {
            expect(await db.getArtifactPublication(value, other.id)).toBeNull();
          }
        }
        for (const scope of [
          { ...PRIMARY, orgId: "org-b" },
          { ...PRIMARY, profileId: "profile-b" },
          { ...PRIMARY, sessionId: "session-c" },
          { ...PRIMARY, orgId: "missing-org" },
          { ...PRIMARY, profileId: "missing-profile" },
          { ...PRIMARY, sessionId: "missing-session" },
        ]) {
          expect(
            await db.listArtifactPublications(scope, { limit: 2 })
          ).toEqual([]);
        }
      });
    });

    test("keyset pages exhaust equal timestamps without duplicate or missing outputs and exclude revoked records", async () => {
      await fixture(kind, async (db) => {
        for (const rank of [4, 1, 9, 2, 8, 3, 5]) {
          const date = rank === 2 ? OLDER : rank === 5 ? NEWER : NOW;
          await commit(db, record(rank, PRIMARY, date));
        }
        expect(
          await db.revokeArtifactPublication(PRIMARY, record(4).id, NEWER)
        ).toBe(true);
        const expected = [5, 9, 8, 3, 1, 2].map((rank) => record(rank).id);
        for (const limit of [1, 2, 3, 101]) {
          const listed = await pages(db, PRIMARY, limit);
          const ids = listed.flat().map((value) => value.id);
          expect(ids).toEqual(expected);
          expect(new Set(ids).size).toBe(expected.length);
          expect(listed.at(-1)).toEqual([]);
          for (const page of listed) {
            expect(page.length).toBeLessThanOrEqual(limit);
          }
        }
        const afterRevoked = await db.listArtifactPublications(PRIMARY, {
          after: { createdAt: NOW, id: record(4).id },
          limit: 101,
        });
        expect(afterRevoked.map((value) => value.id)).toEqual(
          [3, 1, 2].map((rank) => record(rank).id)
        );
      });
    });

    test("revoking the previous page boundary does not omit remaining outputs", async () => {
      await fixture(kind, async (db) => {
        for (const rank of [1, 2, 3]) {
          await commit(db, record(rank));
        }
        const first = await db.listArtifactPublications(PRIMARY, { limit: 1 });
        const boundary = first[0]!;
        expect(boundary.id).toBe(record(3).id);
        expect(
          await db.revokeArtifactPublication(PRIMARY, boundary.id, NEWER)
        ).toBe(true);
        const second = await db.listArtifactPublications(PRIMARY, {
          after: { createdAt: boundary.createdAt, id: boundary.id },
          limit: 2,
        });
        expect(second.map((value) => value.id)).toEqual([
          record(2).id,
          record(1).id,
        ]);
      });
    });

    test("Unicode cursor boundaries use byte ordering while committed publication IDs stay constrained", async () => {
      await fixture(kind, async (db) => {
        await commit(db, record(1));
        for (const id of ["é", "\ue000", "\u{10000}", "😀"]) {
          expect(
            await db.listArtifactPublications(PRIMARY, {
              after: { createdAt: NOW, id },
              limit: 2,
            })
          ).toEqual([record(1)]);
        }
        expect(
          await db.listArtifactPublications(PRIMARY, {
            after: { createdAt: NOW, id: "a" },
            limit: 2,
          })
        ).toEqual([]);
        await expect(
          commit(db, { ...record(2), id: "publication_😀" })
        ).rejects.toThrow();
      });
    });

    test("invalid limits and malformed cursor fields reject without changing stored outputs", async () => {
      await fixture(kind, async (db) => {
        await commit(db, record(1));
        for (const limit of [
          -1,
          0,
          1.5,
          102,
          Number.NaN,
          Number.POSITIVE_INFINITY,
        ]) {
          await expect(
            db.listArtifactPublications(PRIMARY, { limit })
          ).rejects.toThrow();
        }
        const invalidCursors: unknown[] = [
          {},
          { createdAt: "invalid", id: record(1).id },
          { createdAt: "", id: record(1).id },
          { createdAt: NOW, id: "" },
          { createdAt: NOW, id: " \n " },
          { createdAt: NOW, id: "x".repeat(101) },
          { createdAt: NOW, id: null },
          { createdAt: NOW, id: 1 },
        ];
        for (const after of invalidCursors) {
          await expect(
            db.listArtifactPublications(PRIMARY, {
              after: after as ArtifactPublicationPageOptions["after"],
              limit: 2,
            })
          ).rejects.toThrow();
        }
        expect(
          await db.listArtifactPublications(PRIMARY, { limit: 1 })
        ).toEqual([record(1)]);
      });
    });

    test("archived organizations hide existing pages and point lookups", async () => {
      await fixture(kind, async (db) => {
        await commit(db, record(1));
        expect(await db.tryMarkOrganizationArchived(PRIMARY.orgId, NEWER)).toBe(
          true
        );
        expect(
          await db.listArtifactPublications(PRIMARY, { limit: 101 })
        ).toEqual([]);
        expect(
          await db.getArtifactPublication(PRIMARY, record(1).id)
        ).toBeNull();
        await expect(commit(db, record(2))).rejects.toThrow();
      });
    });

    test.each(["session", "profile"] as const)(
      "deleted %s scope cannot resurrect publication pages when identifiers are reused",
      async (deleted) => {
        await fixture(kind, async (db) => {
          await commit(db, record(1));
          const removed =
            deleted === "session"
              ? await db.deleteSession(PRIMARY.sessionId)
              : await db.deleteProfileForOrg(PRIMARY.profileId, PRIMARY.orgId);
          expect(removed).toBe(true);
          expect(
            await db.listArtifactPublications(PRIMARY, { limit: 101 })
          ).toEqual([]);
          await seedScope(db, PRIMARY);
          expect(
            await db.listArtifactPublications(PRIMARY, { limit: 101 })
          ).toEqual([]);
          expect(
            await db.getArtifactPublication(PRIMARY, record(1).id)
          ).toBeNull();
          await commit(db, record(2));
          expect(
            await db.listArtifactPublications(PRIMARY, { limit: 101 })
          ).toEqual([record(2)]);
        });
      }
    );

    test("listing preserves existing commit idempotency, conflicts, ordinal order and revocation behavior", async () => {
      await fixture(kind, async (db) => {
        const owner: ArtifactPublicationIdentity = record(1);
        const first = record(1);
        const second = {
          ...record(2),
          executionId: owner.executionId,
          outputOrdinal: 1,
        };
        expect(
          await db.commitArtifactPublications(owner, [second, first])
        ).toEqual([first, second]);
        const page = await db.listArtifactPublications(PRIMARY, { limit: 2 });
        expect(page).toEqual([second, first]);
        page[0]!.filename = "mutated-result.txt";
        expect(await db.getArtifactPublication(PRIMARY, second.id)).toEqual(
          second
        );
        expect(
          await db.commitArtifactPublications(owner, [second, first])
        ).toEqual([first, second]);
        await expect(
          db.commitArtifactPublications(owner, [
            first,
            { ...second, sha256: "b".repeat(64) },
          ])
        ).rejects.toThrow();
        expect(
          await db.revokeArtifactPublication(PRIMARY, second.id, NEWER)
        ).toBe(true);
        expect(await db.getArtifactPublication(PRIMARY, second.id)).toBeNull();
        expect(
          await db.isArtifactPublicationSnapshotReferenced(second.snapshotId)
        ).toBe(true);
        expect(
          await db.listArtifactPublications(PRIMARY, { limit: 2 })
        ).toEqual([first]);
        expect(
          await db.commitArtifactPublications(owner, [second, first])
        ).toEqual([first, { ...second, revokedAt: NEWER }]);
      });
    });
  });
}

test("publication key comparison agrees with actual SQLite BINARY for Unicode and supplementary ID characters", () => {
  const sql = new Database(":memory:");
  try {
    sql.run("CREATE TABLE keys (createdAt TEXT NOT NULL, id TEXT NOT NULL)");
    const insert = sql.prepare(
      "INSERT INTO keys (createdAt, id) VALUES (?, ?)"
    );
    const ids = [
      "a",
      "z",
      "é",
      "e\u0301",
      "中",
      "\ue000",
      "\ufffd",
      "\u{10000}",
      "😀",
    ];
    const keys = ids.map((id) => ({ createdAt: NOW, id }));
    keys.push({ createdAt: NEWER, id: "a" }, { createdAt: OLDER, id: "😀" });
    for (const key of keys) {
      insert.run(key.createdAt, key.id);
    }
    const expected = sql
      .query(
        "SELECT createdAt, id FROM keys ORDER BY createdAt COLLATE BINARY DESC, id COLLATE BINARY DESC"
      )
      .all() as Array<{ createdAt: string; id: string }>;
    expect(
      [...keys].sort((left, right) => comparePublicationKeys(right, left))
    ).toEqual(expected);
    expect(
      expected.filter((key) => key.createdAt === NOW).map((key) => key.id)
    ).toEqual([
      "😀",
      "\u{10000}",
      "\ufffd",
      "\ue000",
      "中",
      "é",
      "z",
      "e\u0301",
      "a",
    ]);
    for (const cursor of keys) {
      const below = sql
        .query<{ createdAt: string; id: string }, [string, string, string]>(
          "SELECT createdAt, id FROM keys WHERE createdAt < ? COLLATE BINARY OR (createdAt = ? AND id < ? COLLATE BINARY) ORDER BY createdAt COLLATE BINARY DESC, id COLLATE BINARY DESC"
        )
        .all(cursor.createdAt, cursor.createdAt, cursor.id);
      expect(
        expected.filter((key) => comparePublicationKeys(key, cursor) < 0)
      ).toEqual(below);
    }
  } finally {
    sql.close();
  }
});
