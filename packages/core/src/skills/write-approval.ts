export interface SkillWriteApprovalSources {
  orgSkillsWriteApproval?: boolean | null;
  profileSkillsWriteApproval?: boolean | null;
}

export const MANAGE_SKILLS_SKILL_NAME = "manage-skills";

/** File/python/bash writes under skills/ must be refused when this skill is assigned. */
export function assignedSkillsForbidMarkdownWrites(
  assignedNames: readonly string[]
): boolean {
  return assignedNames.includes(MANAGE_SKILLS_SKILL_NAME);
}

/** Profile override wins when non-null; otherwise org default (false when unset). */
export function resolveSkillWriteApprovalRequired(
  sources: SkillWriteApprovalSources
): boolean {
  if (
    sources.profileSkillsWriteApproval !== undefined &&
    sources.profileSkillsWriteApproval !== null
  ) {
    return sources.profileSkillsWriteApproval;
  }
  return sources.orgSkillsWriteApproval === true;
}
