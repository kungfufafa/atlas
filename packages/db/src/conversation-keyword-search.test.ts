import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatMessage, ToolContext } from "@atlas/core";
import { createConversationTools } from "../../../apps/server/src/tools/conversation-tools";
import { createInMemoryDatabaseAdapter } from "./adapters/in-memory";
import { createSqliteDatabase, type SqliteDatabase } from "./adapters/sqlite";
import type { DatabaseAdapter, StoredConversationSearchResult } from "./types";

const now = "2026-02-01T12:00:00.000Z";
const context: ToolContext = {
  orgId: "workshop",
  orgRole: "member",
  profileId: "crafts",
  sessionId: "next-session",
  userId: "reader",
};

async function seed(db: DatabaseAdapter): Promise<void> {
  for (const id of ["workshop", "other-workshop"]) {
    await db.upsertOrganization({
      createdAt: now,
      id,
      name: id,
      slug: id,
      updatedAt: now,
    });
  }
  for (const id of ["reader", "other-reader"]) {
    await db.createUser({
      createdAt: now,
      email: `${id}@example.test`,
      id,
      name: id,
      passwordHash: "test-only",
      updatedAt: now,
    });
  }
  for (const profile of [
    { id: "crafts", isSuper: false, orgId: "workshop" },
    { id: "super", isSuper: true, orgId: "workshop" },
    { id: "other-crafts", isSuper: false, orgId: "other-workshop" },
  ]) {
    const record = {
      ...profile,
      createdAt: now,
      model: null,
      name: profile.id,
      systemPrompt: "",
      updatedAt: now,
    };
    await db.upsertProfile(record);
  }
  for (const session of [
    { id: "own", orgId: "workshop", profileId: "crafts", userId: "reader" },
    {
      id: "foreign-user",
      orgId: "workshop",
      profileId: "crafts",
      userId: "other-reader",
    },
    {
      id: "foreign-org",
      orgId: "other-workshop",
      profileId: "other-crafts",
      userId: "reader",
    },
    {
      id: "super-session",
      orgId: "workshop",
      profileId: "super",
      userId: "reader",
    },
  ]) {
    await db.upsertSession({
      ...session,
      agentQuestionnaire: null,
      agentTodos: [],
      channel: "web",
      createdAt: now,
      modelOverride: null,
      title: null,
    });
  }
}

async function add(
  db: DatabaseAdapter,
  id: string,
  payload: unknown,
  options: { sessionId?: string; createdAt?: string; seq?: number } = {}
): Promise<void> {
  const sessionId = options.sessionId ?? "own";
  await db.appendMessagesForSession(sessionId, [
    {
      createdAt: options.createdAt ?? now,
      id,
      payload,
      seq: options.seq ?? 0,
      sessionId,
    },
  ]);
}

for (const adapterName of ["in-memory", "sqlite"] as const) {
  describe(`conversation keywords: ${adapterName}`, () => {
    let database: SqliteDatabase | undefined;
    afterEach(() => database?.close());
    async function fresh(): Promise<DatabaseAdapter> {
      let db: DatabaseAdapter;
      if (adapterName === "sqlite") {
        database = await createSqliteDatabase(
          join(
            await mkdtemp(join(tmpdir(), "atlas-conversation-keywords-")),
            "history.db"
          )
        );
        db = database.adapter;
      } else {
        db = createInMemoryDatabaseAdapter();
      }
      await seed(db);
      return db;
    }

    test("preserves legacy scalar message text and type across search and transcript retrieval", async () => {
      const db = await fresh();
      const object = {
        content: "Visible pottery",
        marker: "needle",
        role: "assistant",
      };
      const raw = JSON.stringify(object);
      await add(db, "object", object);
      await add(db, "number-string", "42", { seq: 1 });
      await add(db, "null-string", "null", { seq: 2 });
      // Simulate legacy persisted data; new writers use ChatMessage objects.
      const legacy = [raw, "42", "null", 42, true, "true", null, 0, false];
      await db.replaceMessagesForSession(
        "own",
        await db.listMessagesForSession("own"),
        [
          {
            createdAt: "2026-01-01T00:00:00.000Z",
            id: "legacy",
            messages: JSON.parse(JSON.stringify(legacy)),
            sessionId: "own",
          },
        ]
      );
      if (database) {
        database.close();
        await database.reopen();
      }
      const options = { matchMode: "keywords" as const, userId: "reader" };
      const needle = await db.searchConversationMessages(
        "workshop",
        "needle",
        options
      );
      expect(needle).toHaveLength(1);
      expect(needle[0]).toMatchObject({
        archiveId: "legacy",
        matchedSnippet: raw,
        role: "user",
      });
      expect(
        (await db.searchConversationMessages("workshop", "pottery", options))
          .map(({ role }) => role)
          .sort()
      ).toEqual(["assistant", "user"]);
      expect(
        (await db.searchConversationMessages("workshop", "42", options)).map(
          ({ messageId }) => messageId
        )
      ).toEqual(["number-string", "legacy:3"]);
      expect(
        (await db.searchConversationMessages("workshop", "null", options)).map(
          ({ messageId }) => messageId
        )
      ).toEqual(["null-string"]);
      expect(
        await db.searchConversationMessages("workshop", "true", options)
      ).toHaveLength(2);
      const archive = await db.getConversationHistory("workshop", "own", {
        archiveId: "legacy",
        userId: "reader",
      });
      expect(archive?.messages.map(({ text }) => text)).toEqual([
        raw,
        "42",
        "null",
        "42",
        "true",
        "true",
        '""',
        "0",
        "false",
      ]);
      expect(archive?.messages[0]?.role).toBe("user");
      const active = await db.getConversationHistory("workshop", "own", {
        userId: "reader",
      });
      expect(active?.messages.map(({ text }) => text)).toEqual([
        "Visible pottery",
        "42",
        "null",
      ]);
    });

    test("uses identical binary ID ordering for equal-date duplicate messages", async () => {
      const db = await fresh();
      const payload: ChatMessage = {
        content: "Clay workshop schedule",
        role: "user",
      };
      await add(db, "a", payload);
      await add(db, "Z", payload, { seq: 1 });
      const results = await db.searchConversationMessages(
        "workshop",
        "clay schedule",
        { matchMode: "keywords", userId: "reader" }
      );
      expect(results.map(({ messageId }) => messageId)).toEqual(["a"]);
    });

    test("native topic lookup finds separated terms and ranks before limiting older history", async () => {
      const db = await fresh();
      await add(db, "decision", {
        content:
          "The lacquer cures overnight. Our polishing schedule is Thursday.",
        role: "user",
      });
      for (let index = 0; index < 120; index += 1) {
        await add(
          db,
          `recent-${index}`,
          { content: `Lacquer color swatch ${index}.`, role: "user" },
          { createdAt: "2026-02-02T12:00:00.000Z", seq: index + 1 }
        );
      }
      const tool = createConversationTools(db).find(
        ({ name }) => name === "search_chats"
      )!;
      const result = (await tool.run(
        { limit: 1, query: "What is the polishing schedule for lacquer?" },
        context
      )) as { results: StoredConversationSearchResult[] };
      expect(result.results.map(({ messageId }) => messageId)).toEqual([
        "decision",
      ]);
      expect(result.results[0]?.matchedSnippet).toContain(
        "polishing schedule is Thursday"
      );
      expect(
        await db.searchConversationMessages("workshop", "polishing lacquer", {
          userId: "reader",
        })
      ).toEqual([]);
      expect(
        (
          await db.searchConversationMessages("workshop", "cures overnight", {
            userId: "reader",
          })
        )[0]?.messageId
      ).toBe("decision");
    });

    test("keeps tenant, caller, profile and Super Agent filters before ranking", async () => {
      const db = await fresh();
      for (const sessionId of [
        "own",
        "foreign-user",
        "foreign-org",
        "super-session",
      ]) {
        await add(
          db,
          `${sessionId}-match`,
          { content: "Binding glue drying schedule", role: "user" },
          { sessionId }
        );
      }
      const options = {
        excludeSuperAgent: true,
        matchMode: "keywords" as const,
        userId: "reader",
      };
      expect(
        (
          await db.searchConversationMessages(
            "workshop",
            "glue schedule",
            options
          )
        ).map(({ sessionId }) => sessionId)
      ).toEqual(["own"]);
      expect(
        await db.searchConversationMessages("workshop", "glue schedule", {
          ...options,
          profileId: "other-crafts",
        })
      ).toEqual([]);
      expect(
        (
          await db.searchConversationMessages(
            "other-workshop",
            "glue schedule",
            options
          )
        ).map(({ sessionId }) => sessionId)
      ).toEqual(["foreign-org"]);
    });

    test("archives remain searchable after reopen with stable active duplicate preference and date bounds", async () => {
      const db = await fresh();
      const duplicate: ChatMessage = {
        content: "Glaze testing temperatures",
        name: "read_file",
        role: "tool",
        toolCallId: "read-old",
      };
      await add(db, "live-copy", duplicate);
      await db.replaceMessagesForSession(
        "own",
        await db.listMessagesForSession("own"),
        [
          {
            createdAt: "2026-01-01T00:00:00.000Z",
            id: "archive-craft",
            messages: [
              duplicate,
              { content: "Ceramic bisque firing: 980 degrees.", role: "user" },
            ],
            sessionId: "own",
          },
        ]
      );
      if (database) {
        database.close();
        await database.reopen();
      }
      const options = { matchMode: "keywords" as const, userId: "reader" };
      const archived = await db.searchConversationMessages(
        "workshop",
        "bisque degrees",
        options
      );
      expect(archived).toHaveLength(1);
      expect(archived[0]?.archiveId).toBe("archive-craft");
      const transcript = await db.getConversationHistory("workshop", "own", {
        archiveId: archived[0]?.archiveId,
        userId: "reader",
      });
      expect(
        transcript?.messages.some(({ text }) => text.includes("980"))
      ).toBe(true);
      const live = await db.searchConversationMessages(
        "workshop",
        "glaze temperatures",
        options
      );
      expect(live.map(({ messageId }) => messageId)).toEqual(["live-copy"]);
      expect(live[0]?.archiveId).toBeUndefined();
      expect(
        await db.searchConversationMessages("workshop", "bisque degrees", {
          ...options,
          after: now,
        })
      ).toEqual([]);
      expect(
        await db.searchConversationMessages("workshop", "glaze temperatures", {
          ...options,
          before: "2026-01-15T00:00:00.000Z",
        })
      ).toEqual([]);
    });

    test("normalizes lexical spelling, keeps punctuation literal and excludes metadata-only matches", async () => {
      const db = await fresh();
      await add(db, "wide", {
        content: "ＣＡＦＥ reservation confirmed; occupancy is 50%.",
        role: "user",
      });
      await add(
        db,
        "plain",
        {
          content: "No reservation here.",
          role: "assistant",
          thinking: "opaque-private-marker",
        },
        { seq: 1 }
      );
      const options = { matchMode: "keywords" as const, userId: "reader" };
      expect(
        (
          await db.searchConversationMessages("workshop", "cafe reservation", {
            ...options,
            limit: 1,
          })
        )[0]?.messageId
      ).toBe("wide");
      expect(
        (await db.searchConversationMessages("workshop", "%", options)).map(
          ({ messageId }) => messageId
        )
      ).toEqual(["wide"]);
      expect(
        await db.searchConversationMessages(
          "workshop",
          "opaque-private-marker",
          options
        )
      ).toEqual([]);
      expect(
        await db.searchConversationMessages("workshop", "assistant", options)
      ).toEqual([]);
      expect(
        await db.searchConversationMessages(
          "workshop",
          "and the dengan yang",
          options
        )
      ).toEqual([]);
      expect(
        await db.searchConversationMessages("workshop", "reservation", {
          ...options,
          limit: 0,
        })
      ).toEqual([]);
      await add(db, "invoice-target", {
        content: "Invoice 2048 delivery pending",
        role: "user",
      });
      await add(
        db,
        "invoice-other",
        { content: "Invoice 1976 delivery pending", role: "user" },
        { createdAt: "2026-02-02T12:00:00.000Z" }
      );
      expect(
        (
          await db.searchConversationMessages("workshop", "invoice 2048", {
            ...options,
            limit: 1,
          })
        )[0]?.messageId
      ).toBe("invoice-target");
    });

    test("chooses the newest identical current message before applying date filters", async () => {
      const db = await fresh();
      const payload: ChatMessage = {
        content: "Kiln maintenance schedule",
        role: "user",
      };
      await add(db, "older", payload, {
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      await add(db, "newer", payload, { seq: 1 });
      const result = await db.searchConversationMessages(
        "workshop",
        "kiln schedule",
        {
          after: "2026-01-15T00:00:00.000Z",
          matchMode: "keywords",
          userId: "reader",
        }
      );
      expect(result.map(({ messageId }) => messageId)).toEqual(["newer"]);
    });
  });
}
