import { rankSkillsForMessage } from "../learning/rank";
import type { DiscoveredSkill, SkillMatchOptions } from "./types";

const EXPLICIT_SKILL_PATTERN =
  /(?:^|\s)(?:\/skill|use skill|activate skill)\s+([a-z0-9-]+)\b/i;

export function matchSkillsForMessage(
  skills: DiscoveredSkill[],
  userMessage: string,
  options: SkillMatchOptions = {}
): DiscoveredSkill[] {
  const message = userMessage.trim();

  if (!message || skills.length === 0) {
    return [];
  }

  const explicitName = extractExplicitSkillName(message);
  const invocable = skills.filter((skill) => {
    if (explicitName) {
      return skill.name === explicitName;
    }
    return !(options.explicitOnly || skill.disableModelInvocation);
  });
  const matched: DiscoveredSkill[] = [];

  for (const skill of invocable) {
    if (explicitName || messageMatchesSkill(message, skill)) {
      matched.push(skill);
    }
  }

  const ranker = options.ranker ?? { rank: rankSkillsForMessage };
  const retrieved = ranker.retrieve?.(invocable, message) ?? [];

  const byName = new Map<string, DiscoveredSkill>();
  for (const skill of matched) {
    byName.set(skill.name, skill);
  }
  for (const skill of retrieved) {
    byName.set(skill.name, skill);
  }
  const candidates = [...byName.values()];

  if (candidates.length <= 1) {
    return candidates;
  }

  const ranked = ranker.rank(candidates, message, options.outcomes ?? []);
  if (ranked.length === 0) {
    return candidates;
  }
  return ranked.map((entry) => entry.skill);
}

export function extractExplicitSkillName(message: string): string | null {
  const match = message.match(EXPLICIT_SKILL_PATTERN);
  return match?.[1]?.toLowerCase() ?? null;
}

function messageMatchesSkill(message: string, skill: DiscoveredSkill): boolean {
  const normalized = message.toLowerCase();

  if (containsWord(normalized, skill.name)) {
    return true;
  }

  const keywords = extractKeywords(skill.description);

  return keywords.some((keyword) => containsWord(normalized, keyword));
}

function extractKeywords(description: string): string[] {
  const stopWords = new Set([
    "a",
    "an",
    "the",
    "and",
    "or",
    "for",
    "to",
    "when",
    "use",
    "with",
    "user",
    "asks",
    "about",
    "working",
    "files",
    "file",
    "this",
    "that",
    "from",
    "into",
    "are",
    "is",
    "in",
    "on",
    "of",
    "by",
    "as",
    "at",
    "it",
    "be",
    "do",
    "does",
    "help",
    "helps",
    "using",
    "used",
  ]);

  return description
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 4 && !stopWords.has(word));
}

function containsWord(haystack: string, word: string): boolean {
  const pattern = new RegExp(
    `(?:^|[^a-z0-9-])${escapeRegExp(word)}(?:[^a-z0-9-]|$)`
  );
  return pattern.test(haystack);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
