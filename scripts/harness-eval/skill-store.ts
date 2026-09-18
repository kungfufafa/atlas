import type { SkillLearningStore } from "@atlas/agent";
import {
  type DiscoveredSkill,
  discoveredSkillFromMarkdown,
  type LearnedSkillApplyAction,
} from "@atlas/core";
import { createFts5SkillRanker } from "@atlas/db";

/**
 * Harness-faithful skill store: create/patch/edit + FTS match/rank use the
 * same parse/compose/rank functions as production. Not tenant SQLite or
 * SkillsService disk writes.
 */
export function createInHarnessSkillStore(): SkillLearningStore & {
  applyLog: Array<{ action: string; name: string }>;
  snapshot(): DiscoveredSkill[];
} {
  const skills = new Map<string, { content: string; skill: DiscoveredSkill }>();
  const applyLog: Array<{ action: string; name: string }> = [];
  const ranker = createFts5SkillRanker();

  const store: SkillLearningStore & {
    applyLog: Array<{ action: string; name: string }>;
    snapshot(): DiscoveredSkill[];
  } = {
    apply(outcome: Exclude<LearnedSkillApplyAction, { action: "noop" }>) {
      if (outcome.action === "patch") {
        const existing = skills.get(outcome.name);
        if (!existing) {
          return {
            action: "noop",
            name: outcome.name,
            reason: "missing_skill",
          };
        }
        if (!existing.content.includes(outcome.oldString)) {
          return {
            action: "noop",
            name: outcome.name,
            reason: "old_string_missing",
          };
        }
        const content = existing.content.replace(
          outcome.oldString,
          outcome.newString
        );
        const skill = discoveredSkillFromMarkdown(
          content,
          `eval://${outcome.name}/SKILL.md`
        );
        skills.set(skill.name, { content, skill });
        applyLog.push({ action: "patch", name: skill.name });
        return { action: "patch", name: skill.name };
      }

      const skill = discoveredSkillFromMarkdown(
        outcome.content,
        `eval://${outcome.name}/SKILL.md`
      );
      const action = skills.has(skill.name) ? "edit" : outcome.action;
      skills.set(skill.name, { content: outcome.content, skill });
      applyLog.push({ action, name: skill.name });
      return { action, name: skill.name };
    },
    applyLog,
    listCatalog() {
      return [...skills.values()].map(({ skill }) => ({
        body: skill.body,
        description: skill.description,
        name: skill.name,
      }));
    },
    listDiscovered() {
      return [...skills.values()].map(({ skill }) => skill);
    },
    ranker,
    snapshot() {
      return [...skills.values()].map(({ skill }) => skill);
    },
  };
  return store;
}
