import type { ToolContext, ToolDefinition } from "@atlas/core";
import { applyRedactionBoundary, principalFromToolContext } from "@atlas/core";
import { jsonSchemaFromZod } from "@atlas/core/tools/schema";
import type { MemoryScope } from "@atlas/db";
import { z } from "zod";
import type { MemoryService } from "../services/memory-service";

const memoryWriteScopeSchema = z
  .enum(["user", "organization", "agent"])
  .describe(
    "Audience across sessions within this organization: 'user' for the current user's memory; 'agent' for memory shared with users of the current profile; 'organization' for workspace-shared memory whose changes require an administrator. Choose the intended audience, not the topic."
  );

const memoryReadScopeSchema = z
  .enum(["user", "project", "organization", "agent"])
  .describe(
    "Filter by current user, current profile ('agent'), or organization. 'project' is a legacy filter for records owned by the current session only; it does not provide shared project memory. Omitting scope searches the user, agent and organization audiences."
  );

export const memorySearchInputSchema = z.object({
  limit: z.number().int().min(1).max(50).optional().default(10),
  query: z
    .string()
    .describe("Search keywords or natural language query for memories"),
  scope: memoryReadScopeSchema.optional(),
});

export const memoryWriteInputSchema = z.object({
  confidence: z.number().min(0).max(1).optional().default(1.0),
  content: z
    .string()
    .min(1)
    .describe("The fact, preference, or durable instruction to remember"),
  importance: z
    .number()
    .int()
    .min(1)
    .max(5)
    .optional()
    .default(1)
    .describe("Importance from 1 (low) to 5 (critical)"),
  scope: memoryWriteScopeSchema.optional().default("user"),
  subject: z
    .string()
    .optional()
    .describe(
      "Specific stable label for the durable fact or preference, including its entity when relevant. Independent facts remain separate even with the same subject. Use memory_update by ID for an intentional correction."
    ),
});

export const memoryUpdateInputSchema = z.object({
  confidence: z.number().min(0).max(1).optional(),
  content: z.string().optional(),
  id: z.string().describe("ID of the memory to update"),
  importance: z.number().int().min(1).max(5).optional(),
  subject: z.string().nullable().optional(),
});

export const memoryDeleteInputSchema = z.object({
  id: z.string().describe("ID of the memory to delete"),
});

export const memoryListInputSchema = z.object({
  limit: z.number().int().min(1).max(100).optional().default(20),
  scope: memoryReadScopeSchema.optional(),
});

function rejectUnboundProjectWrite(input: unknown): void {
  if (typeof input !== "object" || input === null) {
    return;
  }
  if (("scope" in input && input.scope === "project") || "projectId" in input) {
    throw new Error(
      "Project memory cannot be written without a trusted shared project context. No memory was saved. Choose 'user' for the current user's memory, 'agent' for memory shared with the current profile, or 'organization' for workspace-shared memory with administrator authority. Do not change the intended audience without authorization."
    );
  }
}

function canWriteOrganizationMemory(context: ToolContext): boolean {
  return context.orgRole === "admin" || context.isPlatformAdmin === true;
}

function requireOrgId(context: ToolContext): string {
  const orgId = context.orgId?.trim();
  if (!orgId) {
    throw new Error("orgId is required.");
  }
  return orgId;
}

function resolveOwnerId(scope: MemoryScope, context: ToolContext): string {
  const principal = principalFromToolContext(context);
  if (scope === "user") {
    return principal.userId;
  }
  if (scope === "agent") {
    const profileId = context.profileId?.trim();
    if (!profileId) {
      throw new Error("profileId is required for agent-scoped memory.");
    }
    return profileId;
  }
  if (scope === "project") {
    const owner = context.sessionId?.trim();
    if (!owner) {
      throw new Error(
        "sessionId is required to access legacy session-owned project memory."
      );
    }
    return owner;
  }
  return principal.orgId;
}

async function assertCanMutateMemory(
  memoryService: MemoryService,
  orgId: string,
  id: string,
  context: ToolContext
): Promise<void> {
  const existing = await memoryService.getMemory(orgId, id);
  if (!existing) {
    throw new Error(`Memory with ID '${id}' not found.`);
  }

  if (existing.scope === "organization") {
    if (!canWriteOrganizationMemory(context)) {
      throw new Error(
        "Workspace Admin access required to change organization memories."
      );
    }
    return;
  }

  const ownerId = resolveOwnerId(existing.scope, context);
  if (existing.ownerId !== ownerId) {
    throw new Error(`Memory with ID '${id}' not found.`);
  }
}

export function createMemoryTools(
  memoryService: MemoryService
): ToolDefinition[] {
  const memorySearchTool: ToolDefinition = {
    description:
      "Search durable memories for the current user, profile, or organization. An explicit 'project' filter accesses only legacy records owned by the current session, not shared project knowledge.",
    name: "memory_search",
    parallelSafe: true,
    parameters: jsonSchemaFromZod(memorySearchInputSchema),
    async run(input, context) {
      const parsed = memorySearchInputSchema.parse(input);
      const orgId = requireOrgId(context);
      principalFromToolContext(context);
      const results = parsed.scope
        ? await memoryService.searchMemories(orgId, parsed.query, {
            limit: parsed.limit,
            ownerId: resolveOwnerId(parsed.scope, context),
            profileId: context.profileId,
            scope: parsed.scope,
          })
        : await memoryService.searchVisibleMemories(orgId, parsed.query, {
            limit: parsed.limit,
            profileId: context.profileId,
            userId: context.userId,
          });

      return {
        count: results.length,
        memories: results.map((m) => ({
          content: m.content,
          id: m.id,
          importance: m.importance,
          scope: m.scope,
          subject: m.subject,
          updatedAt: m.updatedAt,
        })),
        query: parsed.query,
      };
    },
  };

  const memoryWriteTool: ToolDefinition = {
    description:
      "Save an independent durable fact, preference, or operating guideline for the current user, profile, or organization across sessions. Scope selects who can access it; shared project context is not supported. Existing facts are preserved, even with the same subject; an exact repeated fact reuses its record. For a correction or withdrawal of an existing fact, use memory_update on its ID rather than adding another current version.",
    name: "memory_write",
    parallelSafe: false,
    parameters: jsonSchemaFromZod(memoryWriteInputSchema),
    async run(input, context) {
      // Reject legacy arguments before Zod can strip an unknown projectId and
      // accidentally save the fact for a different audience.
      rejectUnboundProjectWrite(input);
      const parsed = memoryWriteInputSchema.parse(input);
      const orgId = requireOrgId(context);
      parsed.content = applyRedactionBoundary(parsed.content, "memory");
      if (
        parsed.scope === "organization" &&
        !canWriteOrganizationMemory(context)
      ) {
        throw new Error(
          "Workspace Admin access required to write organization memories."
        );
      }
      const ownerId = resolveOwnerId(parsed.scope, context);

      const saved = await memoryService.writeMemory(
        orgId,
        {
          confidence: parsed.confidence,
          content: parsed.content,
          importance: parsed.importance,
          ownerId,
          scope: parsed.scope,
          subject: parsed.subject,
        },
        { strategy: "preserve" }
      );

      return {
        id: saved.id,
        message: `Saved ${saved.scope} memory successfully.`,
        scope: saved.scope,
        subject: saved.subject,
      };
    },
  };

  const memoryUpdateTool: ToolDefinition = {
    description:
      "Update an existing durable memory by ID. For a corrected or withdrawn preference without a request to erase stored information, replace the obsolete content with the current state; if no replacement was chosen, record that no current preference is set. This changes only the database: reconcile any existing authorized copy in active MEMORY.md with file tools, without copying private user memory into a shared profile. Use memory_delete for requested erasure.",
    name: "memory_update",
    parallelSafe: false,
    parameters: jsonSchemaFromZod(memoryUpdateInputSchema),
    async run(input, context) {
      const parsed = memoryUpdateInputSchema.parse(input);
      const orgId = requireOrgId(context);
      if (parsed.content) {
        parsed.content = applyRedactionBoundary(parsed.content, "memory");
      }
      await assertCanMutateMemory(memoryService, orgId, parsed.id, context);

      // Object.entries keeps only own fields. Undefined means no change;
      // explicit null (clear subject) and zero confidence remain meaningful.
      const patch = Object.fromEntries(
        Object.entries(parsed).filter(
          ([key, value]) => key !== "id" && value !== undefined
        )
      );
      const updated = await memoryService.updateMemory(orgId, parsed.id, patch);

      if (!updated) {
        throw new Error(`Memory with ID '${parsed.id}' not found.`);
      }

      return {
        id: updated.id,
        message: "Memory updated successfully.",
      };
    },
  };

  const memoryDeleteTool: ToolDefinition = {
    description:
      "Delete a stored durable memory by ID, including when the user requests erasure. Do not substitute an inactive marker or archive for requested erasure. Required approval still applies; do not claim deletion is complete while approval is pending. This deletes only this database record, not copies in profile files or conversation history.",
    name: "memory_delete",
    parallelSafe: false,
    parameters: jsonSchemaFromZod(memoryDeleteInputSchema),
    async run(input, context) {
      const parsed = memoryDeleteInputSchema.parse(input);
      const orgId = requireOrgId(context);
      await assertCanMutateMemory(memoryService, orgId, parsed.id, context);
      const deleted = await memoryService.deleteMemory(orgId, parsed.id);
      return {
        deleted,
        id: parsed.id,
        message: deleted ? "Memory deleted." : "Memory not found.",
      };
    },
  };

  const memoryListTool: ToolDefinition = {
    description:
      "List durable memories for the current user, profile, or organization. An explicit 'project' filter lists only legacy records owned by the current session, not shared project knowledge.",
    name: "memory_list",
    parallelSafe: true,
    parameters: jsonSchemaFromZod(memoryListInputSchema),
    async run(input, context) {
      const parsed = memoryListInputSchema.parse(input);
      const orgId = requireOrgId(context);
      const memories = parsed.scope
        ? await memoryService.listMemories(orgId, {
            limit: parsed.limit,
            ownerId: resolveOwnerId(parsed.scope, context),
            scope: parsed.scope,
          })
        : await memoryService.listVisibleMemories(orgId, {
            limit: parsed.limit,
            profileId: context.profileId,
            userId: context.userId,
          });

      return {
        count: memories.length,
        memories: memories.map((m) => ({
          content: m.content,
          id: m.id,
          importance: m.importance,
          scope: m.scope,
          subject: m.subject,
          updatedAt: m.updatedAt,
        })),
      };
    },
  };

  return [
    memorySearchTool,
    memoryWriteTool,
    memoryUpdateTool,
    memoryDeleteTool,
    memoryListTool,
  ];
}
