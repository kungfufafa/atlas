import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createInMemoryDatabaseAdapter,
  createSqliteDatabase,
  type DatabaseAdapter,
  type SqliteDatabase,
  type StoredMemoryRecord,
} from "@atlas/db";
import { MemoryService } from "./memory-service";

const ORG = "retrieval-org";
const OTHER_ORG = "unrelated-org";
const USER = "operator-a";
const PROFILE = "profile-a";
const roots: string[] = [];
const databases = new Set<SqliteDatabase>();

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "atlas-memory-retrieval-"));
  roots.push(root);
  const path = join(root, "memory.sqlite");
  const database = await createSqliteDatabase(path);
  databases.add(database);
  for (const id of [ORG, OTHER_ORG]) {
    await database.adapter.upsertOrganization({
      createdAt: "2026-01-01T00:00:00Z",
      id,
      name: id,
      slug: id,
      updatedAt: "2026-01-01T00:00:00Z",
    });
  }
  return {
    database,
    db: database.adapter,
    path,
    service: new MemoryService(database.adapter),
  };
}

function record(
  id: string,
  patch: Partial<StoredMemoryRecord> = {}
): StoredMemoryRecord {
  return {
    confidence: 0,
    content: "Warehouse dispatch uses the Thursday morning slot.",
    createdAt: "2025-01-01T00:00:00Z",
    id,
    importance: 1,
    orgId: ORG,
    ownerId: USER,
    scope: "user",
    source: null,
    subject: null,
    updatedAt: "2025-01-01T00:00:00Z",
    ...patch,
  };
}

const visible = { profileId: PROFILE, userId: USER };

async function seed(db: DatabaseAdapter, records: StoredMemoryRecord[]) {
  for (const value of records) {
    await db.createMemory(value);
  }
}

afterEach(async () => {
  for (const database of databases) {
    database.close();
  }
  databases.clear();
  for (const root of roots.splice(0)) {
    await rm(root, { force: true, recursive: true });
  }
});

test("natural questions retrieve old facts ahead of many distractors after SQLite reopen", async () => {
  const { database, db, service } = await fixture();
  const target = record("old-relevant-fact", {
    content: "Nusa warehouse dispatch uses the Thursday morning slot.",
    subject: "Nusa warehouse dispatch",
  });
  await db.createMemory(target);
  for (let index = 0; index < 450; index++) {
    await seed(db, [
      record(`org-distractor-${index}`, {
        content: `Dispatch bulletin ${index} concerns office stationery.`,
        importance: 5,
        ownerId: ORG,
        scope: "organization",
        updatedAt: "2026-09-01T00:00:00Z",
      }),
      record(`user-distractor-${index}`, {
        content: `Warehouse inventory label ${index} is green.`,
        importance: 5,
        updatedAt: "2026-09-01T00:00:00Z",
      }),
    ]);
  }
  const question = "Tolong ingatkan kapan jadwal dispatch warehouse Nusa?";
  expect(await db.searchMemories(ORG, question, "user", USER)).toEqual([]);
  expect(
    (
      await service.searchVisibleMemories(ORG, question, {
        ...visible,
        limit: 1,
      })
    ).map((item) => item.id)
  ).toEqual([target.id]);
  await database.reopen();
  const reopened = new MemoryService(db);
  const hits = await reopened.searchVisibleMemories(ORG, question, {
    ...visible,
    limit: 1,
  });
  expect(hits).toEqual([target]);
  expect(hits[0]?.confidence).toBe(0);
  expect(hits[0]?.source).toBeNull();
});

test("relevance is global across scopes and never receives an organization or personal scope boost", async () => {
  const { db, service } = await fixture();
  await seed(db, [
    record("organization-match", {
      content: "Marigold returns require the green authorization form.",
      ownerId: ORG,
      scope: "organization",
      subject: "Marigold returns authorization",
    }),
    record("personal-distraction", {
      content: "Marigold office snacks include pears.",
      importance: 5,
    }),
    record("profile-match", {
      content: "Kestrel shipping cutoff is 16:00.",
      ownerId: PROFILE,
      scope: "agent",
      subject: "Kestrel shipping cutoff",
    }),
    record("personal-match", {
      content: "Orchid invoice contact is Sinta.",
      subject: "Orchid invoice contact",
    }),
  ]);
  for (let index = 0; index < 20; index++) {
    await db.createMemory(
      record(`org-noise-${index}`, {
        content: "Orchid cafeteria policy changed.",
        importance: 5,
        ownerId: ORG,
        scope: "organization",
      })
    );
  }
  for (const [query, id] of [
    ["What is the Marigold returns authorization?", "organization-match"],
    ["When is the Kestrel shipping cutoff?", "profile-match"],
    ["Who is the Orchid invoice contact?", "personal-match"],
  ]) {
    const results = await service.searchVisibleMemories(ORG, query!, {
      ...visible,
      limit: 1,
    });
    expect(results.map((item) => item.id)).toEqual([id!]);
  }
});

test("tenant, exact organization owner, user, profile and project ACLs apply before candidate limits", async () => {
  const { db, service } = await fixture();
  const content = "Confidential saffron shipping authorization code.";
  await seed(db, [
    record("allowed-user", { content }),
    record("allowed-profile", { content, ownerId: PROFILE, scope: "agent" }),
    record("allowed-organization", {
      content,
      ownerId: ORG,
      scope: "organization",
    }),
    record("other-tenant", { content, orgId: OTHER_ORG }),
    record("other-user", { content, ownerId: "operator-b" }),
    record("other-profile", { content, ownerId: "profile-b", scope: "agent" }),
    record("ungranted-project", {
      content,
      ownerId: PROFILE,
      scope: "project",
    }),
    record("mismatched-org-owner", {
      content,
      ownerId: "not-the-org",
      scope: "organization",
    }),
  ]);
  const results = await service.searchVisibleMemories(
    ORG,
    "What is saffron shipping authorization?",
    { ...visible, limit: 200 }
  );
  expect(results.map((item) => item.id).sort()).toEqual([
    "allowed-organization",
    "allowed-profile",
    "allowed-user",
  ]);
  const anonymous = await service.searchVisibleMemories(ORG, "saffron", {});
  expect(anonymous.map((item) => item.id)).toEqual(["allowed-organization"]);
  expect(
    (
      await service.searchVisibleMemories(ORG, "saffron", {
        profileId: "profile-b",
        userId: "operator-b",
      })
    )
      .map((item) => item.id)
      .sort()
  ).toEqual(["allowed-organization", "other-profile", "other-user"]);
  expect(
    (await service.searchVisibleMemories(OTHER_ORG, "saffron", visible)).map(
      (item) => item.id
    )
  ).toEqual(["other-tenant"]);
  expect(
    await service.searchMemories(ORG, "saffron", {
      limit: 1,
      ownerId: "missing-project",
      scope: "project",
    })
  ).toEqual([]);
});

test("Unicode segmentation and canonical case normalization work without changing stored facts", async () => {
  const { db, service } = await fixture();
  const samples = [
    {
      content: "ÉCLAIR livraison prévue lundi.",
      id: "accent",
      query: "Quand faut-il prévoir une livraison e\u0301clair ?",
    },
    {
      content: "ΑΘΉΝΑ αποθήκη αποστολή Πέμπτη.",
      id: "greek",
      query: "Πότε γίνεται η αποστολή στην αθήνα;",
    },
    {
      content: "仓库交货时间为周四上午。",
      id: "han",
      query: "请问仓库交货时间是什么？",
    },
    {
      content: "شحن القاهرة يوم الخميس",
      id: "arabic",
      query: "متى موعد شحن القاهرة؟",
    },
    {
      content: "The preferred receiving window is noon.",
      id: "width",
      query: "ABC配送",
      subject: "ＡＢＣ配送",
    },
  ];
  for (const sample of samples) {
    await db.createMemory(record(sample.id, sample));
  }
  for (const sample of samples) {
    const results = await service.searchVisibleMemories(ORG, sample.query, {
      ...visible,
      limit: 1,
    });
    expect(results[0]?.id).toBe(sample.id);
    expect(results[0]?.content).toBe(sample.content);
  }
});

test("literal DB queries treat percent, underscore, quotes and backslashes as data in both adapters", async () => {
  const { db } = await fixture();
  for (const adapter of [db, createInMemoryDatabaseAdapter()]) {
    await seed(adapter, [
      record("literal", {
        content:
          "Use code rate_%_Q and path C:\\cargo. O'Reilly handles the 15% allowance.",
      }),
      record("wildcard-decoy", {
        content: "Use code rateXQ and path C:cargo. Ordinary allowance.",
      }),
      record("subject-literal", {
        content: "Follow the assigned procedure.",
        subject: "under_score",
      }),
    ]);
    for (const query of ["rate_%_Q", "15%", "O'Reilly", "C:\\cargo"]) {
      expect(
        (await adapter.searchMemories(ORG, query, "user", USER)).map(
          (item) => item.id
        )
      ).toEqual(["literal"]);
    }
    expect(
      (await adapter.searchMemories(ORG, "under_score", "user", USER)).map(
        (item) => item.id
      )
    ).toEqual(["subject-literal"]);
    expect(
      await adapter.searchMemories(ORG, "' OR 1=1 --", "user", USER)
    ).toEqual([]);
    const service = new MemoryService(adapter);
    expect(
      (await service.searchVisibleMemories(ORG, "%", visible)).map(
        (item) => item.id
      )
    ).toEqual(["literal"]);
  }
});

test("search columns stay synchronized across create, same-id upsert, update and reopen", async () => {
  const { database, db } = await fixture();
  const initial = record("changing", {
    content: "ÉCLAIR landing bay",
    subject: "Original",
  });
  await db.createMemory(initial);
  expect((await db.searchMemories(ORG, "éclair"))[0]?.content).toBe(
    initial.content
  );
  await db.createMemory({
    ...initial,
    content: "海運スケジュール",
    subject: "ＡＢＣ",
  });
  expect(await db.searchMemories(ORG, "éclair")).toEqual([]);
  expect((await db.searchMemories(ORG, "abc"))[0]?.id).toBe(initial.id);
  await db.updateMemory(ORG, initial.id, {
    content: "ΠΕΙΡΑΙΆΣ receiving gate",
    subject: null,
  });
  expect(await db.searchMemories(ORG, "abc")).toEqual([]);
  await database.reopen();
  const updated = await db.searchMemories(ORG, "πειραιάς");
  expect(updated[0]?.content).toBe("ΠΕΙΡΑΙΆΣ receiving gate");
  expect(updated[0]?.subject).toBeNull();
  expect(updated[0]?.confidence).toBe(0);
});

test("preexisting database migration backfills Unicode searches without rewriting source metadata", async () => {
  const { database, db, path } = await fixture();
  const old = record("before-migration", {
    confidence: 0.25,
    content: "ÉCLAIR uses gate 7.",
    source: "historical",
    subject: "ＡＢＣ荷物",
  });
  await db.createMemory(old);
  database.close();
  databases.delete(database);
  const legacy = new Database(path);
  legacy.exec("ALTER TABLE memories DROP COLUMN search_content");
  legacy.exec("ALTER TABLE memories DROP COLUMN search_subject");
  legacy.close();
  const migrated = await createSqliteDatabase(path);
  databases.add(migrated);
  expect(await migrated.adapter.getMemory(ORG, old.id)).toEqual(old);
  expect((await migrated.adapter.searchMemories(ORG, "éclair"))[0]).toEqual(
    old
  );
  expect((await migrated.adapter.searchMemories(ORG, "abc"))[0]).toEqual(old);
  await migrated.reopen();
  expect((await migrated.adapter.searchMemories(ORG, "éclair"))[0]).toEqual(
    old
  );
});

test("zero, negative, fractional and excessive result limits stay bounded in both adapters", async () => {
  const { db } = await fixture();
  for (const adapter of [db, createInMemoryDatabaseAdapter()]) {
    const service = new MemoryService(adapter);
    for (let index = 0; index < 220; index++) {
      await adapter.createMemory(
        record(`bounded-${index}`, {
          content: `Uniform dispatch label ${index}`,
        })
      );
    }
    for (const limit of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        await service.searchVisibleMemories(ORG, "dispatch", {
          ...visible,
          limit,
        })
      ).toEqual([]);
      expect(
        await service.listVisibleMemories(ORG, { ...visible, limit })
      ).toEqual([]);
      expect(
        await adapter.searchMemories(ORG, "dispatch", "user", USER, limit)
      ).toEqual([]);
      expect(await adapter.listMemories(ORG, "user", USER, limit)).toEqual([]);
    }
    expect(
      (
        await service.searchVisibleMemories(ORG, "dispatch", {
          ...visible,
          limit: 1.9,
        })
      ).length
    ).toBe(1);
    expect(
      (
        await service.searchVisibleMemories(ORG, "dispatch", {
          ...visible,
          limit: 10_000,
        })
      ).length
    ).toBe(200);
    expect(
      (await service.searchVisibleMemories(ORG, " ", { ...visible, limit: 3 }))
        .length
    ).toBe(3);
    expect(
      await service.searchVisibleMemories(ORG, "the and yang dan", visible)
    ).toEqual([]);
    expect(
      await adapter.searchMemories(
        ORG,
        Array.from({ length: 10_000 }, (_, index) => `absent-token-${index}`),
        "user",
        USER
      )
    ).toEqual([]);
  }
});

test("searchVisibleMemories ranks profile memory-archive files on the production path", async () => {
  const previous = process.env.ATLAS_CONFIG_DIR;
  const { db, service } = await fixture();
  const root = roots.at(-1);
  if (!root) {
    throw new Error("expected fixture root");
  }
  process.env.ATLAS_CONFIG_DIR = root;
  try {
    const archiveDir = join(
      root,
      "orgs",
      ORG,
      "profiles",
      PROFILE,
      "memory-archive"
    );
    await mkdir(archiveDir, { recursive: true });
    await writeFile(
      join(archiveDir, "2026-08.md"),
      `# Archived Memory

---

## 2026-08-15

- The badge code is QUARTZ-WALRUS-19.
`,
      "utf8"
    );
    await seed(db, [
      record("noise-bin", {
        content: "Warehouse bin 014 holds spare tape.",
        ownerId: PROFILE,
        scope: "agent",
      }),
    ]);
    const hits = await service.searchVisibleMemories(
      ORG,
      "badge code QUARTZ-WALRUS",
      visible
    );
    expect(hits[0]?.content).toContain("QUARTZ-WALRUS-19");
    expect(hits[0]?.source).toBe("memory-archive");

    const off = new MemoryService(db, { indexProfileArchive: false });
    const missed = await off.searchVisibleMemories(
      ORG,
      "badge code QUARTZ-WALRUS",
      visible
    );
    expect(missed.some((row) => row.content.includes("QUARTZ-WALRUS-19"))).toBe(
      false
    );
  } finally {
    if (previous === undefined) {
      delete process.env.ATLAS_CONFIG_DIR;
    } else {
      process.env.ATLAS_CONFIG_DIR = previous;
    }
  }
});
