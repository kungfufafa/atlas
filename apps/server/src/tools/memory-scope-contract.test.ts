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

const context: ToolContext = {
  orgId: "scope-workspace",
  orgRole: "admin",
  profileId: "scope-assistant",
  sessionId: "conversation-one",
  userId: "scope-user",
};
const nextSession = { ...context, sessionId: "conversation-two" };
const otherUser = { ...nextSession, userId: "another-user" };
const otherProfile = { ...nextSession, profileId: "another-assistant" };
const otherOrg = { ...nextSession, orgId: "another-workspace" };

async function fixture(kind: "in-memory" | "sqlite") {
  const directory = mkdtempSync(join(tmpdir(), "memory-scope-contract-"));
  const file = join(directory, "memory.sqlite");
  let sqlite = kind === "sqlite" ? await createSqliteDatabase(file) : null;
  let db: DatabaseAdapter = sqlite?.adapter ?? createInMemoryDatabaseAdapter();
  const now = new Date().toISOString();
  for (const id of [context.orgId!, otherOrg.orgId]) {
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
      selectedContext: ToolContext = context
    ): Promise<Record<string, unknown>> {
      const tool = createMemoryTools(new MemoryService(db)).find(
        (entry) => entry.name === name
      );
      if (!tool) {
        throw new Error(`Missing native tool ${name}`);
      }
      return (await tool.run(input, selectedContext)) as Record<
        string,
        unknown
      >;
    },
    service() {
      return new MemoryService(db);
    },
  };
}

function savedMemory(result: Record<string, unknown>): { id: string } {
  if (typeof result.id !== "string" || !result.id) {
    throw new Error("Native memory write did not return an ID.");
  }
  return { id: result.id };
}

function ids(result: Record<string, unknown>): string[] {
  return (result.memories as { id: string }[]).map((row) => row.id).sort();
}

for (const adapter of ["in-memory", "sqlite"] as const) {
  describe(`${adapter} native memory scope contract`, () => {
    test("supported audiences persist across sessions without widening user, profile or organization access", async () => {
      const f = await fixture(adapter);
      try {
        const privateFact = savedMemory(
          await f.run("memory_write", {
            content: "Prefer a window seat on the train.",
            subject: "train_seating",
          })
        );
        const profileFact = savedMemory(
          await f.run("memory_write", {
            content: "The assistant formats handover notes as a checklist.",
            scope: "agent",
            subject: "handover_format",
          })
        );
        const orgFact = savedMemory(
          await f.run("memory_write", {
            content: "The shared supply cupboard is beside reception.",
            scope: "organization",
            subject: "supply_location",
          })
        );
        await f.reopen();
        const expected = [privateFact.id, profileFact.id, orgFact.id].sort();
        expect(ids(await f.run("memory_list", {}, nextSession))).toEqual(
          expected
        );
        for (const [query, scope, id] of [
          ["train_seating", "user", privateFact.id],
          ["handover_format", "agent", profileFact.id],
          ["supply_location", "organization", orgFact.id],
        ] as const) {
          expect(
            ids(await f.run("memory_search", { query, scope }, nextSession))
          ).toEqual([id]);
          expect(
            ids(await f.run("memory_search", { query }, nextSession))
          ).toEqual([id]);
        }
        expect(ids(await f.run("memory_list", {}, otherUser))).toEqual(
          [profileFact.id, orgFact.id].sort()
        );
        expect(ids(await f.run("memory_list", {}, otherProfile))).toEqual(
          [privateFact.id, orgFact.id].sort()
        );
        expect(ids(await f.run("memory_list", {}, otherOrg))).toEqual([]);
        expect(
          ids(
            await f.run("memory_search", { query: "train_seating" }, otherUser)
          )
        ).toEqual([]);
        expect(
          ids(
            await f.run(
              "memory_search",
              { query: "handover_format" },
              otherProfile
            )
          )
        ).toEqual([]);
        for (const foreignContext of [otherUser, otherOrg]) {
          await expect(
            f.run(
              "memory_update",
              { content: "changed", id: privateFact.id },
              foreignContext
            )
          ).rejects.toThrow();
          await expect(
            f.run("memory_delete", { id: privateFact.id }, foreignContext)
          ).rejects.toThrow();
        }
        await expect(
          f.run(
            "memory_update",
            { content: "changed", id: profileFact.id },
            otherProfile
          )
        ).rejects.toThrow();
        await expect(
          f.run("memory_delete", { id: profileFact.id }, otherProfile)
        ).rejects.toThrow();
        await f.run(
          "memory_update",
          { content: "Prefer an aisle seat on the train.", id: privateFact.id },
          nextSession
        );
        await f.reopen();
        expect(
          (await f.service().getMemory(context.orgId!, privateFact.id))?.content
        ).toBe("Prefer an aisle seat on the train.");
        expect(
          (await f.service().getMemory(context.orgId!, profileFact.id))?.content
        ).toBe("The assistant formats handover notes as a checklist.");
      } finally {
        f.close();
      }
    });

    test("unbound project writes and any supplied projectId fail without inserting or changing records", async () => {
      const f = await fixture(adapter);
      try {
        await f.run("memory_write", {
          content: "Keep the existing private note.",
        });
        const before = await f.service().listMemories(context.orgId!);
        for (const input of [
          { scope: "project" },
          { projectId: "renovation-notes", scope: "project" },
          { projectId: "renovation-notes" },
          { projectId: "renovation-notes", scope: "user" },
          { projectId: "renovation-notes", scope: "agent" },
          { projectId: "renovation-notes", scope: "organization" },
          { projectId: "" },
          { projectId: null },
          { projectId: undefined },
        ]) {
          await expect(
            f.run("memory_write", {
              content: "Remember the meeting room layout.",
              ...input,
            })
          ).rejects.toThrow();
          expect(await f.service().listMemories(context.orgId!)).toEqual(
            before
          );
        }
        await f.reopen();
        expect(await f.service().listMemories(context.orgId!)).toEqual(before);
      } finally {
        f.close();
      }
    });

    test("organization writes, corrections and erasure preserve administrator authority", async () => {
      const f = await fixture(adapter);
      try {
        const saved = savedMemory(
          await f.run("memory_write", {
            content: "Office deliveries arrive at the west entrance.",
            scope: "organization",
          })
        );
        await f.reopen();
        const member = { ...nextSession, orgRole: "member" as const };
        const before = await f.service().listMemories(context.orgId!);
        await expect(
          f.run(
            "memory_write",
            { content: "Unauthorized shared note.", scope: "organization" },
            member
          )
        ).rejects.toThrow();
        await expect(
          f.run(
            "memory_update",
            { content: "Unauthorized change.", id: saved.id },
            member
          )
        ).rejects.toThrow();
        await expect(
          f.run("memory_delete", { id: saved.id }, member)
        ).rejects.toThrow();
        expect(await f.service().listMemories(context.orgId!)).toEqual(before);
        const platformAdmin = { ...member, isPlatformAdmin: true };
        await f.run(
          "memory_update",
          {
            content: "Office deliveries arrive at the east entrance.",
            id: saved.id,
          },
          platformAdmin
        );
        const another = savedMemory(
          await f.run(
            "memory_write",
            {
              content: "Reception accepts parcels until noon.",
              scope: "organization",
            },
            platformAdmin
          )
        );
        await f.reopen();
        expect(
          ids(await f.run("memory_list", { scope: "organization" }, member))
        ).toEqual([saved.id, another.id].sort());
        await f.run("memory_delete", { id: saved.id }, nextSession);
        expect(
          await f.service().getMemory(context.orgId!, saved.id)
        ).toBeNull();
      } finally {
        f.close();
      }
    });

    test("legacy session-owned project rows remain explicitly accessible only in their original session", async () => {
      const f = await fixture(adapter);
      try {
        // Direct seeding exercises old stored-data compatibility, not learning.
        const legacy = await f.service().writeMemory(
          context.orgId!,
          {
            confidence: 0.4,
            content: "The archive labels use blue ink.",
            importance: 3,
            ownerId: context.sessionId!,
            scope: "project",
            subject: "archive_labels",
          },
          { strategy: "preserve" }
        );
        const arbitraryOwner = await f.service().writeMemory(
          context.orgId!,
          {
            content: "The map cabinet contains the floor plans.",
            ownerId: "building-records",
            scope: "project",
            subject: "floor_plans",
          },
          { strategy: "preserve" }
        );
        await f.reopen();
        expect(await f.service().getMemory(context.orgId!, legacy.id)).toEqual(
          legacy
        );
        expect(ids(await f.run("memory_list", {}))).toEqual([]);
        expect(
          ids(await f.run("memory_search", { query: "archive_labels" }))
        ).toEqual([]);
        expect(ids(await f.run("memory_list", { scope: "project" }))).toEqual([
          legacy.id,
        ]);
        expect(
          ids(
            await f.run("memory_search", {
              query: "archive_labels",
              scope: "project",
            })
          )
        ).toEqual([legacy.id]);
        for (const foreignContext of [
          nextSession,
          { ...context, orgId: otherOrg.orgId },
        ]) {
          expect(
            ids(
              await f.run("memory_list", { scope: "project" }, foreignContext)
            )
          ).toEqual([]);
          expect(
            ids(
              await f.run(
                "memory_search",
                { query: "archive_labels", scope: "project" },
                foreignContext
              )
            )
          ).toEqual([]);
          await expect(
            f.run(
              "memory_update",
              { content: "changed", id: legacy.id },
              foreignContext
            )
          ).rejects.toThrow();
          await expect(
            f.run("memory_delete", { id: legacy.id }, foreignContext)
          ).rejects.toThrow();
        }
        for (const name of ["memory_search", "memory_list"]) {
          await expect(
            f.run(
              name,
              { query: "archive_labels", scope: "project" },
              { ...context, sessionId: undefined }
            )
          ).rejects.toThrow();
          await expect(
            f.run(
              name,
              { query: "archive_labels", scope: "project" },
              { ...context, userId: undefined }
            )
          ).rejects.toThrow();
        }
        await expect(
          f.run("memory_update", { content: "changed", id: arbitraryOwner.id })
        ).rejects.toThrow();
        await expect(
          f.run("memory_delete", { id: arbitraryOwner.id })
        ).rejects.toThrow();
        await f.run("memory_update", {
          content: "The archive labels use black ink.",
          id: legacy.id,
        });
        await f.reopen();
        expect(await f.service().getMemory(context.orgId!, legacy.id)).toEqual(
          expect.objectContaining({
            confidence: legacy.confidence,
            content: "The archive labels use black ink.",
            createdAt: legacy.createdAt,
            importance: legacy.importance,
            ownerId: legacy.ownerId,
            scope: legacy.scope,
            subject: legacy.subject,
          })
        );
        await f.run("memory_delete", { id: legacy.id });
        await f.reopen();
        expect(
          await f.service().getMemory(context.orgId!, legacy.id)
        ).toBeNull();
        expect(
          await f.service().getMemory(context.orgId!, arbitraryOwner.id)
        ).toEqual(arbitraryOwner);
      } finally {
        f.close();
      }
    });
  });
}
