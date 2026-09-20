import type { SkillLearningStore } from "@atlas/agent";
import {
  type LearnedSkillApplyAction,
  parseRawProfileSkillContent,
} from "@atlas/core";
import type { SkillProposalService } from "./skill-proposal-service";
import type { SkillsService } from "./skills-service";

export interface SkillsServiceLearningStoreOptions {
  orgId: string;
  profileId: string;
  sessionId?: string | null;
  skillProposalService?: SkillProposalService | null;
  userId?: string | null;
}

/**
 * Production adapter: create/patch/edit go through SkillsService, the same
 * functions skill_manage uses. Write-approval stages a proposal instead of
 * writing the live skill.
 */
export function createSkillsServiceLearningStore(
  skillsService: SkillsService,
  options: SkillsServiceLearningStoreOptions
): SkillLearningStore {
  const changeMeta = {
    actorUserId: options.userId ?? null,
    source: "skill_manage" as const,
  };

  return {
    async apply(
      outcome: Exclude<LearnedSkillApplyAction, { action: "noop" }>,
      context
    ) {
      const writeApprovalRequired = context?.writeApprovalRequired === true;
      if (writeApprovalRequired) {
        const proposals = options.skillProposalService;
        if (!proposals) {
          return {
            action: "noop" as const,
            reason: "proposal_store_unavailable",
          };
        }
        if (outcome.action === "create") {
          const staged = await proposals.stageProposal({
            action: "create",
            content: outcome.content,
            orgId: options.orgId,
            profileId: options.profileId,
            proposedByUserId: options.userId ?? null,
            sessionId: options.sessionId ?? null,
          });
          const { name } = parseRawProfileSkillContent(
            outcome.content,
            options.orgId,
            options.profileId
          );
          return {
            action: "staged" as const,
            name,
            reason: staged.outcome,
            staged: true,
          };
        }
        if (outcome.action === "patch") {
          const staged = await proposals.stageProposal({
            action: "patch",
            newString: outcome.newString,
            oldString: outcome.oldString,
            orgId: options.orgId,
            profileId: options.profileId,
            proposedByUserId: options.userId ?? null,
            sessionId: options.sessionId ?? null,
            skillName: outcome.name,
          });
          return {
            action: "staged" as const,
            name: outcome.name,
            reason: staged.outcome,
            staged: true,
          };
        }
        const staged = await proposals.stageProposal({
          action: "edit",
          content: outcome.content,
          orgId: options.orgId,
          profileId: options.profileId,
          proposedByUserId: options.userId ?? null,
          sessionId: options.sessionId ?? null,
          skillName: outcome.name,
        });
        return {
          action: "staged" as const,
          name: outcome.name,
          reason: staged.outcome,
          staged: true,
        };
      }

      if (outcome.action === "create") {
        const response = await skillsService.createAndAssignRawSkillToProfile(
          options.orgId,
          options.profileId,
          outcome.content,
          { changeMeta, createdBy: "agent" }
        );
        return {
          action: "create" as const,
          name: response.skill.name,
        };
      }
      if (outcome.action === "patch") {
        const response = await skillsService.patchAssignedProfileSkill(
          options.orgId,
          options.profileId,
          outcome.name,
          outcome.oldString,
          outcome.newString,
          changeMeta
        );
        return { action: "patch" as const, name: response.skill.name };
      }
      const response = await skillsService.editAssignedProfileSkill(
        options.orgId,
        options.profileId,
        outcome.name,
        outcome.content,
        changeMeta
      );
      return { action: "edit" as const, name: response.skill.name };
    },
    async listCatalog() {
      const assigned = await skillsService.listAssignedDiscoveredSkills(
        options.orgId,
        options.profileId
      );
      return assigned.map((skill) => ({
        body: skill.body,
        description: skill.description,
        name: skill.name,
      }));
    },
    async listDiscovered() {
      return skillsService.listAssignedDiscoveredSkills(
        options.orgId,
        options.profileId
      );
    },
  };
}
