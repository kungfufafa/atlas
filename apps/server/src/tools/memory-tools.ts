import type { ToolContext, ToolDefinition } from "@atlas/core";
import { jsonSchemaFromZod } from "@atlas/core/tools/schema";
import type { MemoryScope } from "@atlas/db";
import { z } from "zod";
import type { MemoryService } from "../services/memory-service";

const memoryScopeSchema = z
  .enum(["user", "project", "organization", "agent"])
  .describe(
    "Memory scope: 'user' for user preferences, 'project' for workspace/project facts, 'organization' for company facts, 'agent' for profile persona."
  );

export const memorySearchInputSchema = z.object({
  limit: z.number().int().min(1).max(50).optional().default(10),
  query: z
    .string()
    .describe("Search keywords or natural language query for memories"),
  scope: memoryScopeSchema.optional().describe("Optional scope filter"),
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
  projectId: z
    .string()
    .optional()
    .describe("Project ID when scope is 'project'"),
  scope: memoryScopeSchema.optional().default("user"),
  subject: z
    .string()
    .optional()
    .describe(
      "Brief topic or subject (e.g. 'coding_style', 'user_preference')"
    ),
});

export const memoryUpdateInputSchema = z.object({
  confidence: z.number().min(0).max(1).optional(),
  content: z.string().optional(),
  id: z.string().describe("ID of the memory to update"),
  importance: z.number().int().min(1).max(5).optional(),
  subject: z.string().optional(),
});

export const memoryDeleteInputSchema = z.object({
  id: z.string().describe("ID of the memory to delete"),
});

export const memoryListInputSchema = z.object({
  limit: z.number().int().min(1).max(100).optional().default(20),
  scope: memoryScopeSchema.optional(),
});

function resolveOwnerId(
  scope: MemoryScope,
  context: ToolContext,
  projectId?: string
): string {
  if (scope === "user") {
    return context.userId || "user_default";
  }
  if (scope === "agent") {
    return context.profileId || "profile_default";
  }
  if (scope === "project") {
    return projectId || context.sessionId || "project_default";
  }
  return context.orgId || "org_default";
}

export function createMemoryTools(
  memoryService: MemoryService
): ToolDefinition[] {
  const memorySearchTool: ToolDefinition = {
    description:
      "Search durable memories across user preferences, project knowledge, organization rules, or agent profile facts.",
    name: "memory_search",
    parallelSafe: true,
    parameters: jsonSchemaFromZod(memorySearchInputSchema),
    async run(input, context) {
      const parsed = memorySearchInputSchema.parse(input);
      const orgId = context.orgId || "org_default";
      const ownerId = parsed.scope
        ? resolveOwnerId(parsed.scope, context)
        : undefined;

      const results = await memoryService.searchMemories(orgId, parsed.query, {
        limit: parsed.limit,
        ownerId,
        scope: parsed.scope,
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
      "Save a durable memory, fact, preference, or operating guideline for the user, project, organization, or agent.",
    name: "memory_write",
    parallelSafe: false,
    parameters: jsonSchemaFromZod(memoryWriteInputSchema),
    async run(input, context) {
      const parsed = memoryWriteInputSchema.parse(input);
      const orgId = context.orgId || "org_default";
      const ownerId = resolveOwnerId(parsed.scope, context, parsed.projectId);

      const saved = await memoryService.writeMemory(orgId, {
        confidence: parsed.confidence,
        content: parsed.content,
        importance: parsed.importance,
        ownerId,
        scope: parsed.scope,
        subject: parsed.subject,
      });

      return {
        id: saved.id,
        message: `Saved ${saved.scope} memory successfully.`,
        scope: saved.scope,
        subject: saved.subject,
      };
    },
  };

  const memoryUpdateTool: ToolDefinition = {
    description: "Update an existing durable memory by ID.",
    name: "memory_update",
    parallelSafe: false,
    parameters: jsonSchemaFromZod(memoryUpdateInputSchema),
    async run(input, context) {
      const parsed = memoryUpdateInputSchema.parse(input);
      const orgId = context.orgId || "org_default";

      const updated = await memoryService.updateMemory(orgId, parsed.id, {
        confidence: parsed.confidence,
        content: parsed.content,
        importance: parsed.importance,
        subject: parsed.subject,
      });

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
    description: "Delete a durable memory by ID.",
    name: "memory_delete",
    parallelSafe: false,
    parameters: jsonSchemaFromZod(memoryDeleteInputSchema),
    async run(input, context) {
      const parsed = memoryDeleteInputSchema.parse(input);
      const orgId = context.orgId || "org_default";
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
      "List durable memories for the current user, agent, or organization.",
    name: "memory_list",
    parallelSafe: true,
    parameters: jsonSchemaFromZod(memoryListInputSchema),
    async run(input, context) {
      const parsed = memoryListInputSchema.parse(input);
      const orgId = context.orgId || "org_default";
      const ownerId = parsed.scope
        ? resolveOwnerId(parsed.scope, context)
        : undefined;

      const memories = await memoryService.listMemories(orgId, {
        limit: parsed.limit,
        ownerId,
        scope: parsed.scope,
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
