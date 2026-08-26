import type { ToolContext, ToolDefinition } from "@atlas/core";
import { principalFromToolContext } from "@atlas/core";
import { canAccessSuperAgentProfile } from "@atlas/core/profiles";
import { jsonSchemaFromZod } from "@atlas/core/tools/schema";
import type { DatabaseAdapter } from "@atlas/db";
import { z } from "zod";

export const searchChatsInputSchema = z.object({
  after: z
    .string()
    .optional()
    .describe("Filter messages sent after this ISO timestamp"),
  before: z
    .string()
    .optional()
    .describe("Filter messages sent before this ISO timestamp"),
  limit: z.number().int().min(1).max(50).optional().default(10),
  profileId: z.string().optional().describe("Optional profile ID filter"),
  query: z
    .string()
    .min(1)
    .describe("Search query to find in past conversations and sessions"),
});

export const getConversationInputSchema = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .default(50)
    .describe("Max messages to retrieve"),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .default(0)
    .describe("Pagination offset"),
  sessionId: z
    .string()
    .min(1)
    .describe("Session ID of the conversation to inspect"),
});

export function createConversationTools(db: DatabaseAdapter): ToolDefinition[] {
  const searchChatsTool: ToolDefinition = {
    description:
      "Search your previous chat sessions and conversations for topics, decisions, past research, or discussions.",
    name: "search_chats",
    parallelSafe: true,
    parameters: jsonSchemaFromZod(searchChatsInputSchema),
    async run(input, context: ToolContext) {
      const parsed = searchChatsInputSchema.parse(input);
      const principal = principalFromToolContext(context);
      const orgId = principal.orgId;
      const excludeSuperAgent = !canAccessSuperAgentProfile(principal);

      const results = await db.searchConversationMessages(orgId, parsed.query, {
        after: parsed.after,
        before: parsed.before,
        excludeSuperAgent,
        limit: parsed.limit,
        profileId: parsed.profileId,
        userId: principal.userId,
      });

      return {
        count: results.length,
        query: parsed.query,
        results: results.map((r) => ({
          createdAt: r.createdAt,
          matchedSnippet: r.matchedSnippet,
          messageId: r.messageId,
          profileId: r.profileId,
          role: r.role,
          sessionId: r.sessionId,
          sessionTitle: r.sessionTitle,
        })),
      };
    },
  };

  const getConversationTool: ToolDefinition = {
    description:
      "Retrieve full or bounded message transcript of a specific past conversation session.",
    name: "get_conversation",
    parallelSafe: true,
    parameters: jsonSchemaFromZod(getConversationInputSchema),
    async run(input, context: ToolContext) {
      const parsed = getConversationInputSchema.parse(input);
      const principal = principalFromToolContext(context);
      const orgId = principal.orgId;
      const excludeSuperAgent = !canAccessSuperAgentProfile(principal);

      const conversation = await db.getConversationHistory(
        orgId,
        parsed.sessionId,
        {
          excludeSuperAgent,
          limit: parsed.limit,
          offset: parsed.offset,
          userId: principal.userId,
        }
      );

      if (!conversation) {
        throw new Error(
          `Conversation session '${parsed.sessionId}' was not found or access is denied.`
        );
      }

      return conversation;
    },
  };

  return [searchChatsTool, getConversationTool];
}
