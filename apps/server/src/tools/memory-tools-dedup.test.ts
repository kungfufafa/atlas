import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "@atlas/core";
import {
  createInMemoryDatabaseAdapter,
  createSqliteDatabase,
  type DatabaseAdapter,
} from "@atlas/db";
import { MemoryService } from "../services/memory-service";
import { createMemoryTools } from "./memory-tools";

const principal: ToolContext = {
  orgId: "dedup-org",
  orgRole: "admin",
  profileId: "dedup-agent",
  sessionId: "dedup-session",
  userId: "dedup-user",
};

async function fixture(kind: "sqlite" | "in-memory") {
  const directory = mkdtempSync(join(tmpdir(), "memory-dedup-native-"));
  const file = join(directory, "memory.sqlite");
  let sqlite = kind === "sqlite" ? await createSqliteDatabase(file) : null;
  let db: DatabaseAdapter = sqlite?.adapter ?? createInMemoryDatabaseAdapter();
  const now = new Date().toISOString();
  for (const id of ["dedup-org", "other-org"]) {
    await db.upsertOrganization({
      createdAt: now,
      id,
      name: id,
      slug: id,
      updatedAt: now,
    });
  }
  return {
    close() {
      sqlite?.close();
      rmSync(directory, { force: true, recursive: true });
    },
    async reopen() {
      if (sqlite) {
        sqlite.close();
        sqlite = await createSqliteDatabase(file);
        db = sqlite.adapter;
      }
    },
    async run(
      name: string,
      input: Record<string, unknown>,
      context: ToolContext = principal
    ) {
      const tool = createMemoryTools(new MemoryService(db)).find(
        (entry) => entry.name === name
      );
      if (!tool) {
        throw new Error(`Missing native tool ${name}`);
      }
      return (await tool.run(input, context)) as Record<string, unknown>;
    },
    service() {
      return new MemoryService(db);
    },
  };
}

for (const adapter of ["sqlite", "in-memory"] as const) {
  describe(`${adapter} explicit-subject memory identity`, () => {
    test("native saves preserve separate entities with highly similar fact templates after reopen and recall", async () => {
      const f = await fixture(adapter);
      try {
        const entries = [
          {
            content:
              "Printer P-A uses an approved service interval of 12 days according to the operating manual.",
            subject: "printer_p-a",
          },
          {
            content:
              "Printer P-B uses an approved service interval of 13 days according to the operating manual.",
            subject: "printer_p-b",
          },
          {
            content:
              "Printer P-C uses an approved service interval of 14 days according to the operating manual.",
            subject: "printer_p-c",
          },
        ];
        const ids: unknown[] = [];
        for (const entry of entries) {
          ids.push((await f.run("memory_write", entry)).id);
        }
        expect(new Set(ids).size).toBe(entries.length);
        await f.reopen();
        for (const [index, entry] of entries.entries()) {
          const found = await f.run("memory_search", {
            query: entry.subject,
            scope: "user",
          });
          // Native lexical search may return other matching printers too. Verify
          // that the distinct saved fact survives and is actually retrieved.
          expect(found.count).toBe(entries.length);
          expect(found.memories).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                content: entry.content,
                id: ids[index],
                subject: entry.subject,
              }),
            ])
          );
        }
      } finally {
        f.close();
      }
    });

    test("even identical text cannot replace a genuinely different explicit subject", async () => {
      const f = await fixture(adapter);
      try {
        const content = "Use concise technical replies with concrete examples.";
        const left = await f.run("memory_write", {
          content,
          subject: "email_style",
        });
        const right = await f.run("memory_write", {
          content,
          subject: "chat_style",
        });
        expect(right.id).not.toBe(left.id);
        expect((await f.run("memory_list", { scope: "user" })).count).toBe(2);
      } finally {
        f.close();
      }
    });

    test("equivalent Unicode subjects reuse an exact fact and corrections update by ID", async () => {
      const f = await fixture(adapter);
      try {
        const first = await f.run("memory_write", {
          content: "Send account notices to the support desk.",
          subject: "  RÉSUMÉ_Ａ  ",
        });
        const duplicate = await f.run("memory_write", {
          content: "Send account notices to the support desk.",
          subject: " re\u0301sume\u0301_a ",
        });
        expect(duplicate.id).toBe(first.id);
        await f.run("memory_update", {
          content: "Send account notices to the billing desk instead.",
          id: first.id,
        });
        await f.reopen();
        expect(
          (await f.run("memory_list", { scope: "user" })).memories
        ).toEqual([
          expect.objectContaining({
            content: "Send account notices to the billing desk instead.",
            id: first.id,
          }),
        ]);
      } finally {
        f.close();
      }
    });

    test("different Unicode subjects remain separate even when their content is identical", async () => {
      const f = await fixture(adapter);
      try {
        const a = await f.run("memory_write", {
          content: "Use the approved maintenance procedure.",
          subject: "打印机-甲",
        });
        const b = await f.run("memory_write", {
          content: "Use the approved maintenance procedure.",
          subject: "打印机-乙",
        });
        expect(a.id).not.toBe(b.id);
      } finally {
        f.close();
      }
    });

    test("explicit corrections and unlabelled exact duplicate saves retain one ID", async () => {
      const f = await fixture(adapter);
      try {
        const first = await f.run("memory_write", {
          content: "I prefer technical answers with concise examples.",
          subject: "response_style",
        });
        const second = await f.run("memory_update", {
          content: "I prefer technical explanations with concise examples.",
          id: first.id,
          subject: "response_style",
        });
        expect(second.id).toBe(first.id);
        const unlabelled = {
          content: "Keep the front reception lights on during opening hours.",
        };
        const third = await f.run("memory_write", unlabelled);
        expect((await f.run("memory_write", unlabelled)).id).toBe(third.id);
        await f.run("memory_update", {
          content: "Use the service entrance after closing time.",
          id: third.id,
        });
        await f.reopen();
        expect(
          await f.service().getMemory("dedup-org", String(third.id))
        ).toMatchObject({
          content: "Use the service entrance after closing time.",
          id: third.id,
        });
      } finally {
        f.close();
      }
    });

    test("native saves preserve independent same-subject facts after reopen and recall", async () => {
      const f = await fixture(adapter);
      try {
        const meals = await f.run("memory_write", {
          content: "Use vegetarian meals on overnight trips.",
          subject: "travel_preferences",
        });
        const seats = await f.run("memory_write", {
          content: "Prefer aisle seats for flights longer than four hours.",
          subject: "travel_preferences",
        });
        expect(seats.id).not.toBe(meals.id);
        await f.reopen();
        expect((await f.run("memory_list", { scope: "user" })).count).toBe(2);
        expect(
          (await f.run("memory_search", { query: "vegetarian meals" })).memories
        ).toEqual([
          expect.objectContaining({
            content: "Use vegetarian meals on overnight trips.",
            id: meals.id,
          }),
        ]);
        expect(
          (await f.run("memory_search", { query: "aisle seats" })).memories
        ).toEqual([
          expect.objectContaining({
            content: "Prefer aisle seats for flights longer than four hours.",
            id: seats.id,
          }),
        ]);
      } finally {
        f.close();
      }
    });

    test("deduplication does not cross organization, user or agent ownership", async () => {
      const f = await fixture(adapter);
      try {
        const fact = {
          content: "Keep the service contact on the cover page.",
          subject: "service_contact",
        };
        const ids = new Set<unknown>();
        for (const [input, context] of [
          [fact, principal],
          [fact, { ...principal, userId: "other-user" }],
          [fact, { ...principal, orgId: "other-org" }],
          [{ ...fact, scope: "agent" }, principal],
          [
            { ...fact, scope: "agent" },
            { ...principal, profileId: "other-agent" },
          ],
          [{ ...fact, scope: "organization" }, principal],
        ] as const) {
          ids.add((await f.run("memory_write", input, context)).id);
        }
        expect(ids.size).toBe(6);
        const privateRows = await f.run("memory_search", {
          query: "service_contact",
          scope: "user",
        });
        expect(privateRows.count).toBe(1);
      } finally {
        f.close();
      }
    });
  });
}
