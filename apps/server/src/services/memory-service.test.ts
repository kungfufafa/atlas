import { beforeAll, describe, expect, test } from "bun:test";
import { createSqliteDatabase, type SqliteDatabase } from "@atlas/db";
import { MemoryService } from "./memory-service";

let database: SqliteDatabase;
let memoryService: MemoryService;

beforeAll(async () => {
  database = await createSqliteDatabase(":memory:");
  memoryService = new MemoryService(database.adapter);

  const now = new Date().toISOString();
  await database.adapter.upsertOrganization({
    createdAt: now,
    id: "org-alpha",
    name: "Org Alpha",
    slug: "org-alpha",
    updatedAt: now,
  });
  await database.adapter.upsertOrganization({
    createdAt: now,
    id: "org-beta",
    name: "Org Beta",
    slug: "org-beta",
    updatedAt: now,
  });
});

describe("MemoryService", () => {
  test("writes and retrieves a user memory", async () => {
    const orgId = "org-alpha";
    const userId = "user-1";

    const mem = await memoryService.writeMemory(orgId, {
      confidence: 1.0,
      content: "I prefer technical answers with concise examples.",
      importance: 4,
      ownerId: userId,
      scope: "user",
      subject: "response_style",
    });

    expect(mem.id).toBeDefined();
    expect(mem.content).toContain("concise examples");

    const searchResults = await memoryService.searchMemories(
      orgId,
      "concise examples",
      { ownerId: userId, scope: "user" }
    );

    expect(searchResults.length).toBe(1);
    expect(searchResults[0].content).toContain("concise examples");
  });

  test("deduplicates similar memories by updating existing entry", async () => {
    const orgId = "org-alpha";
    const userId = "user-1";

    // Write slightly reworded memory with same meaning
    const updated = await memoryService.writeMemory(orgId, {
      confidence: 1.0,
      content: "I prefer technical explanations with concise examples.",
      importance: 5,
      ownerId: userId,
      scope: "user",
      subject: "response_style",
    });

    const all = await memoryService.listMemories(orgId, {
      ownerId: userId,
      scope: "user",
    });

    expect(all.length).toBe(1);
    expect(all[0].content).toBe(
      "I prefer technical explanations with concise examples."
    );
    expect(all[0].importance).toBe(5);
  });

  test("rejects sensitive secrets, passwords, and API keys", async () => {
    const orgId = "org-alpha";
    const userId = "user-1";

    await expect(
      memoryService.writeMemory(orgId, {
        content: "My secret token is sk-1234567890abcdef1234567890abcdef",
        ownerId: userId,
        scope: "user",
      })
    ).rejects.toThrow(/sensitive credentials/);

    await expect(
      memoryService.writeMemory(orgId, {
        content: "Password: supersecretpassword123",
        ownerId: userId,
        scope: "user",
      })
    ).rejects.toThrow(/sensitive credentials/);
  });

  test("enforces strict cross-org, cross-user, and cross-project isolation", async () => {
    const orgA = "org-alpha";
    const orgB = "org-beta";
    const userA = "user-alice";
    const userB = "user-bob";

    await memoryService.writeMemory(orgA, {
      content: "Alice confidential note in Org A",
      ownerId: userA,
      scope: "user",
    });

    await memoryService.writeMemory(orgA, {
      content: "Project Phoenix blueprint",
      ownerId: "proj-phoenix",
      scope: "project",
    });

    // 1. User B in Org A should not find User A's memory
    const userBSearch = await memoryService.searchMemories(orgA, "Alice", {
      ownerId: userB,
      scope: "user",
    });
    expect(userBSearch.length).toBe(0);

    // 2. Org B should not find Org A's project memories
    const orgBSearch = await memoryService.searchMemories(orgB, "Phoenix");
    expect(orgBSearch.length).toBe(0);

    // 3. Project Gryphon in Org A should not find Project Phoenix's memories
    const projSearch = await memoryService.searchMemories(orgA, "Phoenix", {
      ownerId: "proj-gryphon",
      scope: "project",
    });
    expect(projSearch.length).toBe(0);
  });
});
