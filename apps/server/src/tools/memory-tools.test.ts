import { describe, expect, test } from "bun:test";
import { createInMemoryDatabaseAdapter } from "@atlas/db";
import { MemoryService } from "../services/memory-service";
import { createMemoryTools } from "./memory-tools";

function toolByName(name: string) {
  const db = createInMemoryDatabaseAdapter();
  const memoryService = new MemoryService(db);
  const tools = createMemoryTools(memoryService);
  const tool = tools.find((entry) => entry.name === name);
  if (!tool) {
    throw new Error(`missing ${name}`);
  }
  return { memoryService, tool };
}

describe("memory tools fail closed", () => {
  test("memory_search without principal throws", async () => {
    const { tool } = toolByName("memory_search");
    await expect(
      tool.run({ query: "allergy" }, { orgId: "org_a" })
    ).rejects.toThrow("Canonical principal");
  });
});

describe("memory tools ownership", () => {
  test("member cannot update another user's memory", async () => {
    const { memoryService, tool } = toolByName("memory_update");
    const saved = await memoryService.writeMemory("org_a", {
      content: "Alice allergy",
      ownerId: "user_alice",
      scope: "user",
    });

    await expect(
      tool.run(
        { content: "overwritten", id: saved.id },
        {
          orgId: "org_a",
          orgRole: "member",
          profileId: "profile_bob",
          userId: "user_bob",
        }
      )
    ).rejects.toThrow("not found");

    const still = await memoryService.getMemory("org_a", saved.id);
    expect(still?.content).toBe("Alice allergy");
  });

  test("member cannot write organization-scope memory", async () => {
    const { tool } = toolByName("memory_write");
    await expect(
      tool.run(
        { content: "planted org fact", scope: "organization" },
        {
          orgId: "org_a",
          orgRole: "member",
          profileId: "profile_bob",
          userId: "user_bob",
        }
      )
    ).rejects.toThrow("Workspace Admin access required");
  });

  test("platform admin can write organization-scope memory", async () => {
    const { memoryService, tool } = toolByName("memory_write");
    const result = (await tool.run(
      { content: "org-wide fact", scope: "organization" },
      {
        isPlatformAdmin: true,
        orgId: "org_a",
        orgRole: "member",
        profileId: "profile_bob",
        userId: "user_bob",
      }
    )) as { id?: string };

    expect(result.id).toBeTruthy();
    const stored = await memoryService.getMemory("org_a", result.id!);
    expect(stored?.content).toBe("org-wide fact");
    expect(stored?.scope).toBe("organization");
  });
});
