import {
  jsonSchemaFromZod,
  parseToolInput,
  requiredTrimmedString,
  type ToolContext,
  type ToolDefinition,
} from "@atlas/core";
import { z } from "zod";
import { toolActivationService } from "../services/tool-activation-service";

export const toolSearchInputSchema = z
  .object({
    activate: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        "Whether to automatically activate matched tools into the current session."
      ),
    limit: z
      .number()
      .int()
      .min(1, "limit must be at least 1")
      .max(50, "limit cannot exceed 50")
      .optional()
      .default(10),
    query: requiredTrimmedString("query"),
  })
  .strict();

export type ToolSearchInput = z.infer<typeof toolSearchInputSchema>;

export interface SearchMatchedTool {
  activated?: boolean;
  description: string;
  handlerType?: string;
  name: string;
  parameters?: Record<string, unknown>;
}

export interface ToolSearchOutput {
  activatedTools?: string[];
  query: string;
  tools: SearchMatchedTool[];
  totalMatches: number;
}

const SUPER_AGENT_ONLY_TOOLS = new Set([
  "list_profiles",
  "get_profile",
  "create_profile",
  "update_profile",
  "assign_tool_to_profile",
  "list_tools",
  "create_tool",
]);

export function searchToolCatalog(
  availableTools: ToolDefinition[],
  query: string,
  options: { isSuperAgent?: boolean; limit?: number } = {}
): SearchMatchedTool[] {
  const normalizedQuery = query.toLowerCase().trim();
  const queryTokens = normalizedQuery.split(/\s+/).filter(Boolean);
  const limit = options.limit ?? 10;

  const matches: Array<{ score: number; tool: SearchMatchedTool }> = [];

  for (const tool of availableTools) {
    if (!options.isSuperAgent && SUPER_AGENT_ONLY_TOOLS.has(tool.name)) {
      continue;
    }

    const nameLower = tool.name.toLowerCase();
    const descLower = tool.description.toLowerCase();

    let score = 0;
    if (nameLower === normalizedQuery) {
      score += 100;
    } else if (nameLower.includes(normalizedQuery)) {
      score += 50;
    }

    for (const token of queryTokens) {
      if (nameLower.includes(token)) {
        score += 20;
      }
      if (descLower.includes(token)) {
        score += 10;
      }
    }

    if (score > 0) {
      matches.push({
        score,
        tool: {
          description: tool.description,
          name: tool.name,
          parameters: tool.parameters as Record<string, unknown> | undefined,
        },
      });
    }
  }

  matches.sort((a, b) => b.score - a.score);
  return matches.slice(0, limit).map((m) => m.tool);
}

export function createToolSearchTool(
  resolveCatalog: (context: ToolContext) => Promise<ToolDefinition[]>
): ToolDefinition<ToolSearchInput, ToolSearchOutput> {
  return {
    description:
      "Search the available tool catalog for specific capabilities, tools, and connectors (e.g. calculator, python, spreadsheet, files, browser, automations). Automatically activates matched tools into the current session.",
    name: "tool_search",
    parameters: jsonSchemaFromZod(toolSearchInputSchema),
    async run(input: unknown, context: ToolContext): Promise<ToolSearchOutput> {
      const parsed = parseToolInput(toolSearchInputSchema, input);
      const catalog = await resolveCatalog(context);
      const results = searchToolCatalog(catalog, parsed.query, {
        limit: parsed.limit,
      });

      let activatedTools: string[] = [];
      if (parsed.activate && context.sessionId && results.length > 0) {
        const namesToActivate = results.map((r) => r.name);
        activatedTools = toolActivationService.activateTools(
          context.sessionId,
          namesToActivate
        );
        for (const tool of results) {
          tool.activated = true;
        }
      }

      return {
        activatedTools: activatedTools.length > 0 ? activatedTools : undefined,
        query: parsed.query,
        tools: results,
        totalMatches: results.length,
      };
    },
  };
}
