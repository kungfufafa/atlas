import path from "node:path";
import type { JsonSchema, ToolContext, ToolDefinition } from "../contract";
import { permissiveObjectSchema } from "../tools/schema";
import type { DiscoveredSkill } from "./types";

export interface SkillToolModule {
  description?: string;
  name?: string;
  parameters?: JsonSchema;
  run: (input: unknown, context: ToolContext) => Promise<unknown>;
}

export interface SkillToolRuntime {
  /** Metadata loading must be confined too: module imports execute code. */
  load(skill: DiscoveredSkill): Promise<SkillToolModule>;
}

export async function loadSkillTool(
  skill: DiscoveredSkill,
  runtime?: SkillToolRuntime
): Promise<ToolDefinition | null> {
  if (!skill.toolPath) {
    return null;
  }

  try {
    if (!runtime) {
      throw new Error(
        "Executable skills require a configured confined skill runtime. Run this skill through the Atlas server."
      );
    }
    const module = await runtime.load(skill);

    return {
      description: module.description?.trim() || skill.description,
      name: module.name?.trim() || skill.name,
      parameters: module.parameters ?? permissiveObjectSchema(),
      async run(input, context) {
        return module.run(input, context);
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return {
      description: skill.description,
      name: skill.name,
      parameters: permissiveObjectSchema(),
      async run() {
        return { error: `Skill tool failed to load: ${message}` };
      },
    };
  }
}

export async function loadSkillTools(
  skills: DiscoveredSkill[],
  runtime?: SkillToolRuntime
): Promise<ToolDefinition[]> {
  const tools: ToolDefinition[] = [];

  for (const skill of skills) {
    if (!skill.hasTool) {
      continue;
    }

    const tool = await loadSkillTool(skill, runtime);

    if (tool) {
      tools.push(tool);
    }
  }

  return tools;
}

function resolveSkillToolPath(
  toolPath: string,
  skillDirectory: string
): string {
  const resolved = path.isAbsolute(toolPath)
    ? path.resolve(toolPath)
    : path.resolve(skillDirectory, toolPath);

  if (!isPathInsideDirectory(resolved, skillDirectory)) {
    throw new Error(`Skill tool path must stay inside ${skillDirectory}.`);
  }

  return resolved;
}

function isPathInsideDirectory(
  targetPath: string,
  directoryPath: string
): boolean {
  const relative = path.relative(directoryPath, targetPath);
  return (
    relative === "" || !(relative.startsWith("..") || path.isAbsolute(relative))
  );
}

/** @deprecated Confined skill modules are loaded afresh in each child. */
export function clearSkillToolModuleCache(): void {
  // Retained for callers of the previous core API; there is no host module cache.
}

export { resolveSkillToolPath };
