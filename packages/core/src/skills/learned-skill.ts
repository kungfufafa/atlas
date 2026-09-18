import { skillCuratorSimilarity } from "./curator-consolidation";
import { parseSkillMarkdown } from "./parse";
import type { DiscoveredSkill } from "./types";

export const LEARNED_SKILL_OVERLAP = 0.45;

export interface LearnedSkillCatalogEntry {
  body?: string;
  description: string;
  name: string;
}

export type LearnedSkillApplyAction =
  | { action: "create"; content: string; name: string }
  | { action: "edit"; content: string; name: string }
  | { action: "noop"; reason?: string }
  | { action: "patch"; name: string; newString: string; oldString: string };

export function buildLearnedSkillMarkdown(input: {
  body: string;
  description: string;
  name: string;
}): string {
  const body = input.body.trim();
  return [
    "---",
    `name: ${input.name}`,
    `description: ${input.description}`,
    "include-body-on-match: true",
    "---",
    "",
    body,
    "",
  ].join("\n");
}

export function discoveredSkillFromMarkdown(
  content: string,
  sourcePath = "memory://learned/SKILL.md"
): DiscoveredSkill {
  const parsed = parseSkillMarkdown(content, sourcePath);
  const directory = sourcePath.replace(/\/SKILL\.md$/i, "");
  return {
    body: parsed.body,
    description: parsed.frontmatter.description,
    directory,
    disableModelInvocation: parsed.frontmatter.disableModelInvocation ?? false,
    hasTool: false,
    includeBodyOnMatch: parsed.frontmatter.includeBodyOnMatch ?? true,
    name: parsed.frontmatter.name,
    skillFilePath: sourcePath,
    toolPath: null,
  };
}

export function slugifyLearnedSkillName(value: string): string {
  const slug = value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || "learned-procedure";
}

/**
 * Prefer patch/edit over a second create when a catalog skill already covers
 * the same lesson (Nakama-style consolidation).
 */
export function consolidateSkillLearningOutcome(
  outcome: LearnedSkillApplyAction,
  catalog: readonly LearnedSkillCatalogEntry[]
): LearnedSkillApplyAction {
  if (outcome.action === "noop" || outcome.action === "patch") {
    return outcome;
  }

  const incoming = discoveredSkillFromMarkdown(
    outcome.content,
    `memory://${outcome.name}/SKILL.md`
  );
  const sameName = catalog.find((entry) => entry.name === incoming.name);
  const overlap = catalog.find(
    (entry) =>
      entry.name !== incoming.name &&
      skillCuratorSimilarity(
        curatorShape(entry),
        curatorShape({
          body: incoming.body,
          description: incoming.description,
          name: incoming.name,
        })
      ) >= LEARNED_SKILL_OVERLAP
  );
  const existing = sameName ?? overlap;
  if (!existing) {
    return { action: "create", content: outcome.content, name: incoming.name };
  }

  const existingBody = existing.body?.trim() ?? "";
  if (
    existingBody &&
    (existingBody.includes(incoming.body.trim()) ||
      incoming.body.trim().length === 0)
  ) {
    return { action: "noop", reason: "duplicate_skill" };
  }

  if (outcome.action === "edit" && existing.name === incoming.name) {
    return { action: "edit", content: outcome.content, name: existing.name };
  }

  const mergedBody = mergeLearnedSkillBodies(existingBody, incoming.body);
  const merged = buildLearnedSkillMarkdown({
    body: mergedBody,
    description: existing.description || incoming.description,
    name: existing.name,
  });
  return { action: "edit", content: merged, name: existing.name };
}

export function mergeLearnedSkillBodies(
  existingBody: string,
  incomingBody: string
): string {
  const existing = existingBody.trim();
  const incoming = incomingBody.trim();
  if (!existing) {
    return incoming;
  }
  if (!incoming || existing.includes(incoming)) {
    return existing;
  }
  return `${existing}\n\n## Learned updates\n\n${incoming}`;
}

function curatorShape(entry: LearnedSkillCatalogEntry) {
  return {
    body: entry.body ?? "",
    createdBy: "agent" as const,
    description: entry.description,
    enabled: true,
    id: entry.name,
    name: entry.name,
    sourcePath: entry.name,
    updatedAt: "",
  };
}
